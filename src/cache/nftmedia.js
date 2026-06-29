// Capped, LRU-evicting NFT thumbnail cache.
//
// Images are cached lazily (only when first served), resized to the configured
// sizes, and stored under {dataDir}/media/nft/. A byte cap is enforced: after every
// insert we evict least-recently-served thumbnails until total <= cap, so the on-disk
// footprint stays pinned at ~nfts.media.max_bytes regardless of how many NFTs exist.
// (Concurrent first-time inserts can transiently overshoot by at most
// imageConcurrency × per-thumbnail bytes before the next eviction runs — negligible
// against a multi-GB cap, and concurrency is bounded by the image route's semaphore.)
// Non-image media never reaches this module (see nftmeta.selectMedia).

import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { createHash } from 'crypto'
import log from '../lib/log.js'
import { unixNow } from '../lib/time.js'
import { validate as validateURL } from '../lib/url.js'
import { createFetch } from '../lib/fetch.js'


// Raster formats only. SVG is intentionally excluded — librsvg renders attacker
// SVG with no inherent dimension bound (vector bomb). Both the declared mime and
// the sharp-decoded format must be in this set.
const imageMimeTypes = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/avif': 'avif'
}

const ALLOWED_DECODED_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp', 'avif'])

// Cap the decoded pixel surface so a small highly-compressed image can't expand to
// gigabytes (decompression bomb). The fetch byte cap only bounds the ENCODED size.
const MAX_INPUT_PIXELS = 24_000_000   // ~24 MP

const DEFAULT_MAX_BYTES = 20_000_000_000   // 20 GB
const DEFAULT_SIZES = [256]
const EVICT_BATCH = 64


function mediaConfig({ ctx }){
	let cfg = ctx.config.nfts?.media || {}
	return {
		disabled: !!cfg.disabled,
		maxBytes: cfg.maxBytes ?? DEFAULT_MAX_BYTES,
		sizes: Array.isArray(cfg.sizes) && cfg.sizes.length ? cfg.sizes : DEFAULT_SIZES
	}
}

function getMediaDir({ ctx }){
	let dir = path.join(ctx.config.node.dataDir, 'media', 'nft')
	if(!fs.existsSync(dir))
		fs.mkdirSync(dir, { recursive: true })
	return dir
}

export function getNFTMediaPath({ ctx, hash, size }){
	return path.join(getMediaDir({ ctx }), `${hash}@${size}.png`)
}

export function hashSourceUrl(sourceUrl){
	return createHash('md5').update(sourceUrl).digest('hex').slice(0, 16).toUpperCase()
}


export function totalNFTMediaBytes({ ctx }){
	let aggregate = ctx.db.cache.nftMedia.readOne({
		select: { sizeBytes: { function: 'SUM' } }
	})
	return Number(aggregate?.sizeBytes ?? 0)
}


function removeMediaFiles({ ctx, media }){
	// Glob every variant for this hash (any @size) so files written under a prior
	// `sizes` config are still removed — otherwise a sizes change would orphan files
	// and let the on-disk total drift above the cap.
	let dir = getMediaDir({ ctx })
	let prefix = `${media.hash}@`

	try{
		for(let file of fs.readdirSync(dir)){
			if(file.startsWith(prefix))
				fs.rmSync(path.join(dir, file), { force: true })
		}
	}catch{
		// best effort
	}
}


// Enforce the hard cap: evict least-recently-served thumbnails until the total is
// at or below 90% of the cap. Returns the number of entries evicted.
export function evictNFTMediaIfNeeded({ ctx }){
	let { maxBytes } = mediaConfig({ ctx })
	let total = totalNFTMediaBytes({ ctx })

	if(total <= maxBytes)
		return 0

	let target = Math.floor(maxBytes * 0.9)
	let evicted = 0

	while(total > target){
		let victims = ctx.db.cache.nftMedia.readMany({
			orderBy: { lastAccess: 'asc' },
			take: EVICT_BATCH
		})

		if(victims.length === 0)
			break

		for(let victim of victims){
			removeMediaFiles({ ctx, media: victim })
			ctx.db.cache.nftMedia.deleteOne({ where: { id: victim.id } })
			total -= victim.sizeBytes || 0
			evicted++

			if(total <= target)
				break
		}
	}

	if(evicted)
		log.debug(`evicted ${evicted} NFT thumbnail(s); total now ~${total} bytes`)

	return evicted
}


// Return a cached thumbnail for sourceUrl, fetching + resizing + storing it on a
// miss (then enforcing the cap). `fetchImpl` is injectable for tests. Returns
// { hash } on success, or null if media caching is disabled / the URL is unsafe.
export async function cacheThumbnail({ ctx, sourceUrl, fetchImpl }){
	let { disabled, sizes } = mediaConfig({ ctx })

	if(disabled)
		return null

	if(!sourceUrl || !validateURL(sourceUrl))
		return null

	let hash = hashSourceUrl(sourceUrl)

	let existing = ctx.db.cache.nftMedia.readOne({ where: { hash } })
	if(existing){
		ctx.db.cache.nftMedia.updateOne({
			data: { lastAccess: unixNow() },
			where: { id: existing.id }
		})
		return { hash }
	}

	let fetch = fetchImpl || createFetch({ validateUrls: true })
	let { status, headers, data } = await fetch(sourceUrl)

	if(status !== 200)
		throw new Error(`HTTP ${status}`)

	let mime = headers.get('content-type')
	if(!imageMimeTypes[mime])
		throw new Error(`not a supported image: ${mime}`)

	if(!Buffer.isBuffer(data))
		throw new Error(`image response was not binary`)

	// Decode under a hard pixel cap and verify the ACTUAL format (content-type is
	// attacker-controlled and must not be trusted for the security decision).
	let base = sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
	let info = await base.metadata()

	if(!ALLOWED_DECODED_FORMATS.has(info.format))
		throw new Error(`unsupported decoded image format: ${info.format}`)

	let sizeBytes = 0
	for(let size of sizes){
		let out = await base.clone().png().resize(size, size, { fit: 'cover' }).toBuffer()
		fs.writeFileSync(getNFTMediaPath({ ctx, hash, size }), out)
		sizeBytes += out.length
	}

	ctx.db.cache.nftMedia.createOne({
		data: {
			hash,
			sourceUrl,
			fileType: 'png',
			sizeBytes,
			lastAccess: unixNow(),
			timeCreated: unixNow()
		}
	})

	evictNFTMediaIfNeeded({ ctx })

	return { hash }
}
