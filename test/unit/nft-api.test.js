import { expect } from 'chai'
import { decodeAccountID } from 'ripple-address-codec'
import { createContext } from './env.js'
import { applyLedgerStateFromTransactions } from '../../src/ledger/state/index.js'
import { applyLedgerEvents } from '../../src/ledger/events/index.js'
import { updateCacheForNFTCollection } from '../../src/cache/nfts.js'
import * as api from '../../src/srv/api.js'


const ISSUER = 'rMrCiKUV4wUNXYJvZn2zQwd7BkSim2JJ3A'
const OWNER1 = 'rKwsswRD2LvRMWjRh5pZthDNJcwWcMeZK8'
const OWNER2 = 'rsnyc3RYKFrRHgVZ4TJ6PKnPCBtaJkiqig'
const TAXON = 7


function hexAccount(a){ return Buffer.from(decodeAccountID(a)).toString('hex').toUpperCase() }

function buildNFTokenId({ taxon, serial, flags = 0, transferFee = 0 }){
	let scrambled = (BigInt(taxon) ^ ((384160001n * BigInt(serial) + 2459n) % 4294967296n)) % 4294967296n
	return (
		flags.toString(16).padStart(4, '0') +
		transferFee.toString(16).padStart(4, '0') +
		hexAccount(ISSUER).toLowerCase() +
		scrambled.toString(16).padStart(8, '0') +
		serial.toString(16).padStart(8, '0')
	).toUpperCase()
}

function hex64(seed){ return seed.toString(16).padStart(64, '0').toUpperCase() }

function applyLedger(ctx, sequence, transactions){
	let ledger = { sequence, ledger_index: String(sequence), hash: hex64(sequence), closeTime: 1000000000 + sequence, transactions }
	ctx.db.core.tx(() => {
		let testCtx = { ...ctx, ledgerSequence: sequence }
		applyLedgerStateFromTransactions({ ctx: testCtx, ledger })
		applyLedgerEvents({ ctx: testCtx, ledger })
	})
}

function mintNode(tokenId, owner){
	return {
		CreatedNode: {
			LedgerEntryType: 'NFTokenPage',
			LedgerIndex: hexAccount(owner) + '0'.repeat(24),
			NewFields: { NFTokens: [{ NFToken: { NFTokenID: tokenId } }] }
		}
	}
}


async function seed(){
	let ctx = await createContext()
	let id1 = buildNFTokenId({ taxon: TAXON, serial: 1 })
	let id2 = buildNFTokenId({ taxon: TAXON, serial: 2 })

	applyLedger(ctx, 50, [{
		TransactionType: 'NFTokenMint', Account: ISSUER, hash: hex64(0xaa),
		metaData: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [mintNode(id1, OWNER1), mintNode(id2, OWNER2)] }
	}])

	applyLedger(ctx, 51, [{
		TransactionType: 'NFTokenCreateOffer', Account: OWNER2, hash: hex64(0xbb),
		metaData: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [{
			CreatedNode: { LedgerEntryType: 'NFTokenOffer', LedgerIndex: hex64(0xc1), NewFields: { NFTokenID: id2, Flags: 1, Amount: '5000000', Owner: OWNER2 } }
		}] }
	}])

	let collection = ctx.db.core.nftCollections.readOne({ where: { issuer: { address: ISSUER }, taxon: TAXON } })

	ctx.db.core.tx(() => {
		ctx.db.core.nftOffers.createOne({ data: { offerId: hex64(0xc2), account: { address: OWNER1 }, nft: { tokenId: id2 }, collection: { id: collection.id }, isSellOffer: false, amountToken: { id: 1 }, amountValue: '3', ledgerSequence: 51, lastLedgerSequence: 51 } })
		ctx.db.core.nftExchanges.createOne({ data: { txHash: hex64(0xd1), account: { address: OWNER1 }, offer: { offerId: hex64(0xc2) }, nft: { tokenId: id2 }, collection: { id: collection.id }, amountToken: { id: 1 }, amountValue: '3', isSellOffer: false, ledgerSequence: 51 } })
	})

	updateCacheForNFTCollection({ ctx, collection: { id: collection.id } })

	return { ctx, id1, id2 }
}


describe(
	'NFT API procedures (Phase 3)',
	() => {
		it('lists collections with metrics', async () => {
			let { ctx } = await seed()
			let res = api.nft_collections({ ctx })
			expect(res.count).to.equal(1)
			expect(res.collections[0].issuer).to.equal(ISSUER)
			expect(res.collections[0].taxon).to.equal(TAXON)
			expect(res.collections[0].supply).to.equal(2)
			expect(res.collections[0].floor).to.equal('5')
		})

		it('serves a single collection summary', async () => {
			let { ctx } = await seed()
			let res = api.nft_collection({ ctx, issuer: ISSUER, taxon: String(TAXON) })
			expect(res.holders).to.equal(2)
			expect(res.volume.all).to.equal('3')
		})

		it('lists the NFTs in a collection', async () => {
			let { ctx, id1 } = await seed()
			let res = api.nft_collection_nfts({ ctx, issuer: ISSUER, taxon: String(TAXON) })
			expect(res.count).to.equal(2)
			expect(res.nfts.map(n => n.token_id)).to.include(id1)
			expect(res.nfts[0]).to.have.property('owner')
		})

		it('serves a single NFT with its active offers', async () => {
			let { ctx, id2 } = await seed()
			let res = api.nft({ ctx, tokenId: id2 })
			expect(res.token_id).to.equal(id2)
			expect(res.issuer).to.equal(ISSUER)
			// id2 has one active sell offer (5 XRP)
			expect(res.offers.some(o => o.is_sell && o.amount === '5')).to.equal(true)
		})

		it('lists active collection offers', async () => {
			let { ctx } = await seed()
			let res = api.nft_collection_offers({ ctx, issuer: ISSUER, taxon: String(TAXON) })
			expect(res.count).to.be.greaterThan(0)
			expect(res.offers.some(o => o.amount === '5')).to.equal(true)
		})

		it('lists collection exchanges over the full range', async () => {
			let { ctx } = await seed()
			let res = api.nft_collection_exchanges({ ctx, issuer: ISSUER, taxon: String(TAXON) })
			expect(res.count).to.equal(1)
			expect(res.exchanges[0].amount).to.equal('3')
		})

		it('rejects a malformed NFTokenID', async () => {
			let { ctx } = await seed()
			expect(() => api.nft({ ctx, tokenId: 'not-a-token' })).to.throw()
		})

		it('404s an unknown collection', async () => {
			let { ctx } = await seed()
			expect(() => api.nft_collection({ ctx, issuer: ISSUER, taxon: '99999' })).to.throw()
		})

		it('honors limit on the exchanges listing', async () => {
			let { ctx, id2 } = await seed()
			let coll = ctx.db.core.nftCollections.readOne({ where: { issuer: { address: ISSUER }, taxon: TAXON } })

			ctx.db.core.tx(() => {
				for(let i of [2, 3]){
					ctx.db.core.nftOffers.createOne({ data: { offerId: hex64(0xe0 + i), account: { address: OWNER1 }, nft: { tokenId: id2 }, collection: { id: coll.id }, isSellOffer: false, amountToken: { id: 1 }, amountValue: '1', ledgerSequence: 51, lastLedgerSequence: 51 } })
					ctx.db.core.nftExchanges.createOne({ data: { txHash: hex64(0xf0 + i), account: { address: OWNER1 }, offer: { offerId: hex64(0xe0 + i) }, nft: { tokenId: id2 }, collection: { id: coll.id }, amountToken: { id: 1 }, amountValue: '1', isSellOffer: false, ledgerSequence: 51 } })
				}
			})

			let res = api.nft_collection_exchanges({ ctx, issuer: ISSUER, taxon: String(TAXON), limit: 2 })
			expect(res.count).to.equal(3)
			expect(res.exchanges.length).to.equal(2)
		})

		it('excludes time-expired offers from the collection offers list', async () => {
			let { ctx, id1 } = await seed()
			let coll = ctx.db.core.nftCollections.readOne({ where: { issuer: { address: ISSUER }, taxon: TAXON } })

			// An expired (expirationTime in the past) 1 XRP sell offer must not appear.
			ctx.db.core.tx(() => {
				ctx.db.core.nftOffers.createOne({ data: { offerId: hex64(0xab1), account: { address: OWNER1 }, nft: { tokenId: id1 }, collection: { id: coll.id }, isSellOffer: true, amountToken: { id: 1 }, amountValue: '1', expirationTime: 1, ledgerSequence: 51, lastLedgerSequence: 51 } })
			})

			let res = api.nft_collection_offers({ ctx, issuer: ISSUER, taxon: String(TAXON) })
			expect(res.offers.some(o => o.amount === '1'), 'expired offer excluded').to.equal(false)
			expect(res.offers.some(o => o.amount === '5'), 'active offer present').to.equal(true)
		})

		it('excludes burned NFTs from the collection NFT listing', async () => {
			let { ctx, id1 } = await seed()

			applyLedger(ctx, 52, [{
				TransactionType: 'NFTokenBurn', Account: OWNER1, NFTokenID: id1, hash: hex64(0x52),
				metaData: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [] }
			}])

			let res = api.nft_collection_nfts({ ctx, issuer: ISSUER, taxon: String(TAXON) })
			expect(res.count, 'only live NFTs counted').to.equal(1)
			expect(res.nfts.map(n => n.token_id)).to.not.include(id1)
		})
	}
)
