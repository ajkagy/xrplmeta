import { expect } from 'chai'
import { decodeAccountID } from 'ripple-address-codec'
import { createContext } from './env.js'
import { applyLedgerStateFromTransactions } from '../../src/ledger/state/index.js'
import { applyLedgerEvents } from '../../src/ledger/events/index.js'
import { updateCacheForNFTCollection } from '../../src/cache/nfts.js'
import { enrichCollection } from '../../src/cache/nftenrich.js'
import * as api from '../../src/srv/api.js'


const ISSUER = 'rMrCiKUV4wUNXYJvZn2zQwd7BkSim2JJ3A'
const OWNER1 = 'rKwsswRD2LvRMWjRh5pZthDNJcwWcMeZK8'
const TAXON = 7
const META_URI = 'ipfs://QmMeta/1.json'


function hexAccount(a){ return Buffer.from(decodeAccountID(a)).toString('hex').toUpperCase() }
function hex64(n){ return n.toString(16).padStart(64, '0').toUpperCase() }
function buildNFTokenId({ taxon, serial }){
	let scrambled = (BigInt(taxon) ^ ((384160001n * BigInt(serial) + 2459n) % 4294967296n)) % 4294967296n
	return ('0000' + '0000' + hexAccount(ISSUER).toLowerCase() + scrambled.toString(16).padStart(8, '0') + serial.toString(16).padStart(8, '0')).toUpperCase()
}

function withConfig(ctx){
	return {
		...ctx,
		config: {
			...ctx.config,
			server: { publicUrl: 'https://api.test' },
			nfts: { metadata: { gateways: ['https://ipfs.io'] } }
		}
	}
}

function applyLedger(ctx, sequence, transactions){
	let ledger = { sequence, ledger_index: String(sequence), hash: hex64(sequence), closeTime: 1000000000 + sequence, transactions }
	ctx.db.core.tx(() => {
		let testCtx = { ...ctx, ledgerSequence: sequence }
		applyLedgerStateFromTransactions({ ctx: testCtx, ledger })
		applyLedgerEvents({ ctx: testCtx, ledger })
	})
}


describe('NFT metadata enrichment + API integration (Phase 4)', function(){
	this.timeout(8000)

	it('derives a collection name and per-NFT media from XLS-24 metadata', async () => {
		let base = await createContext()
		let ctx = withConfig(base)
		let id1 = buildNFTokenId({ taxon: TAXON, serial: 1 })

		// Mint with an ipfs metadata URI.
		applyLedger(ctx, 50, [{
			TransactionType: 'NFTokenMint', Account: ISSUER, hash: hex64(0xaa),
			metaData: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [{
				CreatedNode: {
					LedgerEntryType: 'NFTokenPage',
					LedgerIndex: hexAccount(OWNER1) + '0'.repeat(24),
					NewFields: { NFTokens: [{ NFToken: { NFTokenID: id1, URI: Buffer.from(META_URI, 'utf8').toString('hex').toUpperCase() } }] }
				}
			}] }
		}])

		let coll = ctx.db.core.nftCollections.readOne({ where: { issuer: { address: ISSUER }, taxon: TAXON } })
		updateCacheForNFTCollection({ ctx, collection: { id: coll.id } })

		let cacheRow = ctx.db.cache.nftCollections.readOne({ where: { collection: coll.id } })
		expect(cacheRow.name, 'no name before enrichment').to.satisfy(n => n == null)

		// Mocked metadata fetch.
		let fakeFetch = async url => {
			expect(url).to.equal('https://ipfs.io/ipfs/QmMeta/1.json')
			return { status: 200, data: { name: 'Cool #1', description: 'a cat', image: 'ipfs://QmImg/1.png', collection: { name: 'Cool Cats' }, attributes: [{ trait_type: 'bg', value: 'blue' }] } }
		}

		await enrichCollection({ ctx, cacheRow, fetch: fakeFetch })

		// Collection name derived.
		let enriched = ctx.db.cache.nftCollections.readOne({ where: { collection: coll.id } })
		expect(enriched.name).to.equal('Cool Cats')
		expect(enriched.imageUrl).to.equal('https://ipfs.io/ipfs/QmImg/1.png')

		// Per-NFT meta stored.
		let meta = ctx.db.cache.nftMeta.readOne({ where: { tokenId: id1 } })
		expect(meta.name).to.equal('Cool #1')
		expect(meta.mediaType).to.equal('image')
		expect(meta.imageUrl).to.equal('https://ipfs.io/ipfs/QmImg/1.png')

		// API surfaces it.
		let list = api.nft_collections({ ctx })
		expect(list.collections[0].name).to.equal('Cool Cats')
		expect(list.collections[0].image).to.equal('https://ipfs.io/ipfs/QmImg/1.png')

		// name_like searches the real name now.
		expect(api.nft_collections({ ctx, name_like: 'cool' }).count).to.equal(1)
		expect(api.nft_collections({ ctx, name_like: 'zzz' }).count).to.equal(0)

		// Single NFT carries media fields + thumbnail URL.
		let nft = api.nft({ ctx, tokenId: id1 })
		expect(nft.name).to.equal('Cool #1')
		expect(nft.media_type).to.equal('image')
		expect(nft.image).to.equal('https://ipfs.io/ipfs/QmImg/1.png')
		expect(nft.thumbnail).to.equal('https://api.test/v2/nft/' + id1 + '/image')
	})

	it('records a fetch failure without throwing and leaves the name null', async () => {
		let base = await createContext()
		let ctx = withConfig(base)
		let id1 = buildNFTokenId({ taxon: 8, serial: 1 })

		applyLedger(ctx, 60, [{
			TransactionType: 'NFTokenMint', Account: ISSUER, hash: hex64(0xbb),
			metaData: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [{
				CreatedNode: { LedgerEntryType: 'NFTokenPage', LedgerIndex: hexAccount(OWNER1) + '0'.repeat(24), NewFields: { NFTokens: [{ NFToken: { NFTokenID: id1, URI: Buffer.from(META_URI, 'utf8').toString('hex').toUpperCase() } }] } }
			}] }
		}])

		let coll = ctx.db.core.nftCollections.readOne({ where: { issuer: { address: ISSUER }, taxon: 8 } })
		updateCacheForNFTCollection({ ctx, collection: { id: coll.id } })
		let cacheRow = ctx.db.cache.nftCollections.readOne({ where: { collection: coll.id } })

		let fakeFetch = async () => ({ status: 404, data: null })
		await enrichCollection({ ctx, cacheRow, fetch: fakeFetch })

		let enriched = ctx.db.cache.nftCollections.readOne({ where: { collection: coll.id } })
		expect(enriched.name).to.satisfy(n => n == null)

		let meta = ctx.db.cache.nftMeta.readOne({ where: { tokenId: id1 } })
		expect(meta.error, 'failure recorded').to.be.a('string')
	})
})
