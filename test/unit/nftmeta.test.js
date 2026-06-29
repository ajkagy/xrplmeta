import { expect } from 'chai'
import { resolveUri, classifyMediaType, parseNFTMetadata, selectMedia, fetchNFTMetadata } from '../../src/cache/nftmeta.js'


const GW = ['https://ipfs.io']


describe('NFT metadata resolution & parsing', () => {
	describe('resolveUri', () => {
		it('maps ipfs:// to the gateway', () => {
			expect(resolveUri('ipfs://QmHash/1.json', GW)).to.equal('https://ipfs.io/ipfs/QmHash/1.json')
		})
		it('strips a redundant ipfs/ prefix', () => {
			expect(resolveUri('ipfs://ipfs/QmHash', GW)).to.equal('https://ipfs.io/ipfs/QmHash')
		})
		it('maps ar:// to arweave', () => {
			expect(resolveUri('ar://abc', GW)).to.equal('https://arweave.net/abc')
		})
		it('passes through http(s) and data URIs', () => {
			expect(resolveUri('https://x.org/a.json', GW)).to.equal('https://x.org/a.json')
			expect(resolveUri('data:application/json,{}', GW)).to.equal('data:application/json,{}')
		})
		it('resolves a bare CID', () => {
			expect(resolveUri('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', GW)).to.equal('https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')
		})
		it('returns null for unsupported schemes / empty', () => {
			expect(resolveUri('ftp://x', GW)).to.equal(null)
			expect(resolveUri('', GW)).to.equal(null)
			expect(resolveUri(null, GW)).to.equal(null)
		})
		it('returns null for ipfs:// with no gateway configured', () => {
			expect(resolveUri('ipfs://QmHash', [])).to.equal(null)
		})
	})

	describe('classifyMediaType', () => {
		it('classifies by extension', () => {
			expect(classifyMediaType('a/b/c.png')).to.equal('image')
			expect(classifyMediaType('x.MP4')).to.equal('video')
			expect(classifyMediaType('x.mp3?foo=1')).to.equal('audio')
			expect(classifyMediaType('x.glb')).to.equal('model')
			expect(classifyMediaType('x.html#y')).to.equal('html')
			expect(classifyMediaType('x.bin')).to.equal('other')
		})
		it('prefers a declared content-type', () => {
			expect(classifyMediaType('x.bin', 'image/png')).to.equal('image')
			expect(classifyMediaType('x.png', 'video/mp4')).to.equal('video')
		})
	})

	describe('parseNFTMetadata + selectMedia', () => {
		it('extracts fields and a collection name', () => {
			let parsed = parseNFTMetadata({
				name: 'Cool #1',
				description: 'desc',
				image: 'ipfs://QmImg/1.png',
				collection: { name: 'Cool Cats', family: 'Cats' },
				attributes: [{ trait_type: 'bg', value: 'blue' }]
			})
			expect(parsed.name).to.equal('Cool #1')
			expect(parsed.collectionName).to.equal('Cool Cats')
			expect(parsed.attributes).to.have.length(1)

			let media = selectMedia(parsed, GW)
			expect(media.mediaType).to.equal('image')
			expect(media.mediaUrl).to.equal('https://ipfs.io/ipfs/QmImg/1.png')
			expect(media.imageUrl).to.equal('https://ipfs.io/ipfs/QmImg/1.png')
		})

		it('treats animation_url video as primary media but keeps the image thumbnailable', () => {
			let parsed = parseNFTMetadata({
				name: 'Vid',
				image: 'ipfs://QmImg/cover.png',
				animation_url: 'ipfs://QmVid/clip.mp4'
			})
			let media = selectMedia(parsed, GW)
			expect(media.mediaType).to.equal('video')
			expect(media.mediaUrl).to.equal('https://ipfs.io/ipfs/QmVid/clip.mp4')
			// the cover image is still eligible for the thumbnail cache
			expect(media.imageUrl).to.equal('https://ipfs.io/ipfs/QmImg/cover.png')
		})

		it('handles a string collection field and missing name', () => {
			let parsed = parseNFTMetadata({ collection: 'JustAName' })
			expect(parsed.collectionName).to.equal('JustAName')
			expect(parsed.name).to.equal(undefined)
		})
	})

	describe('fetchNFTMetadata (mocked fetch)', () => {
		it('resolves, fetches and parses', async () => {
			let calls = []
			let fakeFetch = async url => {
				calls.push(url)
				return { status: 200, data: { name: 'X', image: 'ipfs://QmI/p.png' } }
			}
			let res = await fetchNFTMetadata({ uri: 'ipfs://QmMeta/1.json', gateways: GW, fetch: fakeFetch })
			expect(calls[0]).to.equal('https://ipfs.io/ipfs/QmMeta/1.json')
			expect(res.name).to.equal('X')
			expect(res.imageUrl).to.equal('https://ipfs.io/ipfs/QmI/p.png')
		})

		it('parses inline data: JSON without fetching', async () => {
			let dataUri = 'data:application/json,' + encodeURIComponent(JSON.stringify({ name: 'Inline' }))
			let res = await fetchNFTMetadata({ uri: dataUri, gateways: GW, fetch: async () => { throw new Error('should not fetch') } })
			expect(res.name).to.equal('Inline')
		})
	})
})
