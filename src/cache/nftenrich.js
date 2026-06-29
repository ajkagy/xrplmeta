// NFT off-chain metadata enrichment (DB-writing) + the bounded enrichment worker.
//
// nftmeta.js holds the pure resolve/parse logic; this module stores results into the
// cache DB and runs the periodic top-N collection enrichment. Both the worker (cache
// process) and the on-demand image route (server main thread) hold read-WRITE cache
// connections, so both may call enrichNFT/enrichCollection. The HTTP API procedures
// run in read-only worker threads and never enrich.

import log from '../lib/log.js'
import { wait, unixNow } from '../lib/time.js'
import { createFetch } from '../lib/fetch.js'
import { validate as validateURL } from '../lib/url.js'
import { fetchNFTMetadata } from './nftmeta.js'
import { cacheThumbnail } from './nftmedia.js'


export function makeMetadataFetch({ ctx }){
	let cfg = ctx.config.nfts?.metadata || {}
	return createFetch({
		validateUrls: true,
		timeout: 30,
		maxBytes: { json: cfg.maxBytes || 5_000_000 }
	})
}


function upsertNFTMeta({ ctx, tokenId, data }){
	let existing = ctx.db.cache.nftMeta.readOne({ where: { tokenId } })
	if(existing)
		ctx.db.cache.nftMeta.updateOne({ data, where: { id: existing.id } })
	else
		ctx.db.cache.nftMeta.createOne({ data: { tokenId, ...data } })
}


// Resolve + fetch + store one NFT's metadata. Returns the parsed metadata (incl.
// collectionName) or null on failure (the failure is recorded so it isn't retried
// constantly).
export async function enrichNFT({ ctx, tokenId, uri, fetch }){
	let uriStr = Buffer.isBuffer(uri) ? uri.toString('utf8') : uri
	let gateways = ctx.config.nfts?.metadata?.gateways || []

	let meta
	try{
		meta = await fetchNFTMetadata({ uri: uriStr, gateways, fetch: fetch || makeMetadataFetch({ ctx }) })
	}catch(error){
		upsertNFTMeta({ ctx, tokenId, data: { error: String(error?.message || error).slice(0, 200), fetchedTime: unixNow() } })
		return null
	}

	upsertNFTMeta({
		ctx,
		tokenId,
		data: {
			name: meta.name ?? null,
			description: meta.description ?? null,
			mediaUrl: meta.mediaUrl ?? null,
			mediaType: meta.mediaType ?? null,
			imageUrl: meta.imageUrl ?? null,
			fetchedTime: unixNow(),
			error: null
		}
	})

	return meta
}


// Enrich a collection's display fields by sampling one of its NFTs' metadata. XLS-20
// has no on-ledger collection object, so the collection name (when any) comes from a
// member NFT's metadata `collection.name`.
export async function enrichCollection({ ctx, cacheRow, fetch }){
	let sample = ctx.db.core.nfts.readOne({
		where: { collection: { id: cacheRow.collection }, NOT: { uri: null } },
		select: { tokenId: true, uri: true }
	})

	if(!sample)
		return null

	let meta = await enrichNFT({ ctx, tokenId: sample.tokenId, uri: sample.uri, fetch })

	// Always stamp enrichedTime (even on failure / no name) so the worker backs off
	// and a nameless or failing collection doesn't get re-fetched every interval and
	// permanently occupy the bounded top-N budget.
	let data = { enrichedTime: unixNow() }
	if(meta?.collectionName) data.name = meta.collectionName
	if(meta?.imageUrl) data.imageUrl = meta.imageUrl
	ctx.db.cache.nftCollections.updateOne({ data, where: { id: cacheRow.id } })

	return meta
}


// Concurrency control for the lazy, on-request image path. Each request to an
// un-cached NFT triggers attacker-controlled outbound fetch(es) + a sharp decode on
// the server MAIN thread, so we (a) coalesce concurrent requests for the same NFT
// onto one build and (b) cap the number of concurrent builds — beyond which we shed
// load instead of spawning unbounded fetches/decodes.
let activeImageOps = 0
const inFlightImage = new Map()

function imageConcurrencyCap({ ctx }){
	return ctx.config.nfts?.media?.concurrency
		?? ctx.config.nfts?.metadata?.concurrency
		?? 4
}

// Resolve (and lazily cache) a thumbnail for an NFT image, on the request path.
// Returns:
//   { hash }      -> a cached thumbnail exists; caller serves the file for this hash
//   { redirect }  -> 302 to the (validated) source image (media caching disabled)
//   { busy }      -> too many concurrent builds; caller should 503
//   null          -> no image for this NFT (404)
export async function serveNFTImage({ ctx, tokenId }){
	if(inFlightImage.has(tokenId))
		return inFlightImage.get(tokenId)

	if(activeImageOps >= imageConcurrencyCap({ ctx }))
		return { busy: true }

	activeImageOps++
	let promise = buildNFTImage({ ctx, tokenId }).finally(() => {
		activeImageOps--
		inFlightImage.delete(tokenId)
	})

	inFlightImage.set(tokenId, promise)
	return promise
}

async function buildNFTImage({ ctx, tokenId }){
	let meta = ctx.db.cache.nftMeta.readOne({ where: { tokenId } })

	// Lazy enrich on first request if we've never fetched this NFT's metadata.
	if(!meta){
		let nft = ctx.db.core.nfts.readOne({ where: { tokenId }, select: { tokenId: true, uri: true } })
		if(nft?.uri){
			await enrichNFT({ ctx, tokenId, uri: nft.uri })
			meta = ctx.db.cache.nftMeta.readOne({ where: { tokenId } })
		}
	}

	// Validate the (attacker-controlled) image URL up front: blocks data:/private
	// hosts both for caching and for the disabled-cache redirect (no open redirect).
	if(!meta || !meta.imageUrl || !validateURL(meta.imageUrl))
		return null

	let result = await cacheThumbnail({ ctx, sourceUrl: meta.imageUrl })
	if(!result)
		return { redirect: meta.imageUrl }

	return { hash: result.hash }
}


// Periodic, bounded enrichment: each pass enriches the top-N collections (by volume)
// that still lack a name. The long tail is enriched on-demand via the image route.
export async function startNFTMetadataWorker({ ctx }){
	let cfg = ctx.config.nfts?.metadata

	if(!cfg || cfg.disabled){
		log.info(`NFT metadata enrichment is disabled`)
		return { stop(){} }
	}

	let running = true
	let fetch = makeMetadataFetch({ ctx })
	let topN = cfg.eagerTopN || 1000
	let interval = (cfg.fetchInterval || 86400) * 1000

	;(async () => {
		while(running){
			let enriched = 0

			try{
				let cutoff = unixNow() - (cfg.fetchInterval || 86400)
				let due = ctx.db.cache.nftCollections.readMany({
					where: {
						name: null,
						OR: [
							{ enrichedTime: null },
							{ enrichedTime: { lessThan: cutoff } }
						]
					},
					orderBy: { volumeAll: 'desc' },
					take: topN
				})

				for(let row of due){
					if(!running)
						break

					try{
						let meta = await enrichCollection({ ctx, cacheRow: row, fetch })
						if(meta?.collectionName)
							enriched++
					}catch(error){
						log.debug(`nft enrich failed for collection #${row.id}: ${error?.message || error}`)
					}

					// Pace outbound requests; yield to the loop regardless.
					await wait(250)
				}
			}catch(error){
				log.warn(`nft metadata worker error: ${error?.message || error}`)
			}

			if(enriched > 0)
				log.info(`NFT metadata: enriched ${enriched} collection name(s)`)

			await wait(interval)
		}
	})()

	return { stop(){ running = false } }
}
