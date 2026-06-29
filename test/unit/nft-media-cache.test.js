import { expect } from 'chai'
import fs from 'fs'
import sharp from 'sharp'
import { createContext } from './env.js'
import { cacheThumbnail, evictNFTMediaIfNeeded, getNFTMediaPath, totalNFTMediaBytes } from '../../src/cache/nftmedia.js'


function mediaCtx(ctx, media){
	return { ...ctx, config: { ...ctx.config, nfts: { media: { sizes: [64], disabled: false, ...media } } } }
}


describe('NFT media cache (capped + LRU)', function(){
	this.timeout(10000)

	it('evicts least-recently-served thumbnails until under the cap', async () => {
		let base = await createContext()
		let ctx = mediaCtx(base, { maxBytes: 300, sizes: [256] })

		// Seed 5 entries of 100 bytes with increasing lastAccess + dummy files.
		for(let i = 1; i <= 5; i++){
			let hash = `H${i}`
			ctx.db.cache.nftMedia.createOne({ data: { hash, sourceUrl: `u${i}`, fileType: 'png', sizeBytes: 100, lastAccess: i, timeCreated: i } })
			fs.writeFileSync(getNFTMediaPath({ ctx, hash, size: 256 }), Buffer.alloc(100))
		}

		expect(totalNFTMediaBytes({ ctx })).to.equal(500)

		let evicted = evictNFTMediaIfNeeded({ ctx })

		// cap 300 -> target 270; evict H1(400),H2(300),H3(200<=270 stop) = 3 evicted.
		expect(evicted).to.equal(3)
		expect(totalNFTMediaBytes({ ctx })).to.be.at.most(270)

		let remaining = ctx.db.cache.nftMedia.readMany({ orderBy: { lastAccess: 'asc' } }).map(m => m.hash)
		expect(remaining).to.deep.equal(['H4', 'H5'])

		// Evicted files removed, survivors kept.
		expect(fs.existsSync(getNFTMediaPath({ ctx, hash: 'H1', size: 256 }))).to.equal(false)
		expect(fs.existsSync(getNFTMediaPath({ ctx, hash: 'H5', size: 256 }))).to.equal(true)
	})

	it('caches a thumbnail on first serve and reuses it (no refetch) on the second', async () => {
		let base = await createContext()
		let ctx = mediaCtx(base, { maxBytes: 1_000_000, sizes: [64] })

		let png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer()
		let calls = 0
		let fakeFetch = async () => { calls++; return { status: 200, headers: { get: k => (k === 'content-type' ? 'image/png' : null) }, data: png } }

		let r1 = await cacheThumbnail({ ctx, sourceUrl: 'https://example.org/a.png', fetchImpl: fakeFetch })
		expect(r1.hash).to.be.a('string')
		expect(fs.existsSync(getNFTMediaPath({ ctx, hash: r1.hash, size: 64 }))).to.equal(true)
		expect(Number(ctx.db.cache.nftMedia.count())).to.equal(1)
		expect(calls).to.equal(1)

		let r2 = await cacheThumbnail({ ctx, sourceUrl: 'https://example.org/a.png', fetchImpl: fakeFetch })
		expect(r2.hash).to.equal(r1.hash)
		expect(calls, 'second serve should not refetch').to.equal(1)
		expect(Number(ctx.db.cache.nftMedia.count())).to.equal(1)
	})

	it('rejects non-image media (never stored)', async () => {
		let base = await createContext()
		let ctx = mediaCtx(base, { maxBytes: 1_000_000 })
		let fakeFetch = async () => ({ status: 200, headers: { get: () => 'video/mp4' }, data: Buffer.alloc(10) })

		let err
		try{ await cacheThumbnail({ ctx, sourceUrl: 'https://example.org/clip.mp4', fetchImpl: fakeFetch }) }
		catch(e){ err = e }
		expect(err).to.be.an('error')
		expect(Number(ctx.db.cache.nftMedia.count())).to.equal(0)
	})

	it('rejects SVG (vector-bomb surface) — dropped from the allowlist', async () => {
		let base = await createContext()
		let ctx = mediaCtx(base, { maxBytes: 1_000_000 })
		let fakeFetch = async () => ({ status: 200, headers: { get: () => 'image/svg+xml' }, data: Buffer.from('<svg/>') })

		let err
		try{ await cacheThumbnail({ ctx, sourceUrl: 'https://example.org/x.svg', fetchImpl: fakeFetch }) }
		catch(e){ err = e }
		expect(err).to.be.an('error')
		expect(Number(ctx.db.cache.nftMedia.count())).to.equal(0)
	})

	it('rejects bytes that do not actually decode as a raster image (spoofed content-type)', async () => {
		let base = await createContext()
		let ctx = mediaCtx(base, { maxBytes: 1_000_000 })
		// Claims image/png but the bytes are garbage — sharp.metadata() must reject it.
		let fakeFetch = async () => ({ status: 200, headers: { get: () => 'image/png' }, data: Buffer.from('definitely not a real png') })

		let err
		try{ await cacheThumbnail({ ctx, sourceUrl: 'https://example.org/fake.png', fetchImpl: fakeFetch }) }
		catch(e){ err = e }
		expect(err).to.be.an('error')
		expect(Number(ctx.db.cache.nftMedia.count())).to.equal(0)
	})

	it('returns null when media caching is disabled', async () => {
		let base = await createContext()
		let ctx = mediaCtx(base, { disabled: true })
		let res = await cacheThumbnail({ ctx, sourceUrl: 'https://example.org/a.png', fetchImpl: async () => { throw new Error('should not fetch') } })
		expect(res).to.equal(null)
	})
})
