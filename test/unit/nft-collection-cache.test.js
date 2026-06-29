import { expect } from 'chai'
import { decodeAccountID } from 'ripple-address-codec'
import { createContext } from './env.js'
import { applyLedgerStateFromTransactions } from '../../src/ledger/state/index.js'
import { applyLedgerEvents } from '../../src/ledger/events/index.js'
import { updateCacheForNFTCollection } from '../../src/cache/nfts.js'
import { readNFTCollection } from '../../src/db/helpers/nfts.js'


const ISSUER = 'rMrCiKUV4wUNXYJvZn2zQwd7BkSim2JJ3A'
const OWNER1 = 'rKwsswRD2LvRMWjRh5pZthDNJcwWcMeZK8'
const OWNER2 = 'rsnyc3RYKFrRHgVZ4TJ6PKnPCBtaJkiqig'


function hexAccount(address){
	return Buffer.from(decodeAccountID(address)).toString('hex').toUpperCase()
}

function buildNFTokenId({ taxon, serial, flags = 0, transferFee = 0, issuer = ISSUER }){
	let scrambled = (BigInt(taxon) ^ ((384160001n * BigInt(serial) + 2459n) % 4294967296n)) % 4294967296n
	return (
		flags.toString(16).padStart(4, '0') +
		transferFee.toString(16).padStart(4, '0') +
		hexAccount(issuer).toLowerCase() +
		scrambled.toString(16).padStart(8, '0') +
		serial.toString(16).padStart(8, '0')
	).toUpperCase()
}

function hex64(seed){
	return seed.toString(16).padStart(64, '0').toUpperCase()
}

function applyLedger(ctx, sequence, transactions){
	let ledger = {
		sequence,
		ledger_index: String(sequence),
		hash: hex64(sequence),
		closeTime: 1000000000 + sequence,
		transactions
	}
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


describe(
	'NFT collection cache (Phase 2 metrics)',
	() => {
		it(
			'computes supply, holders, floor and volume — incl. offers/sales on a non-first NFT',
			async () => {
				let ctx = await createContext()
				let id1 = buildNFTokenId({ taxon: 7, serial: 1 })
				let id2 = buildNFTokenId({ taxon: 7, serial: 2 })

				// Ledger 50: mint two NFTs in taxon 7 to two different owners.
				applyLedger(ctx, 50, [{
					TransactionType: 'NFTokenMint',
					Account: ISSUER,
					hash: hex64(0xaa),
					metaData: {
						TransactionResult: 'tesSUCCESS',
						TransactionIndex: 0,
						AffectedNodes: [mintNode(id1, OWNER1), mintNode(id2, OWNER2)]
					}
				}])

				// Ledger 51: list the SECOND NFT (id2) as a 5 XRP sell offer. Using a
				// non-first NFT guards against the LIMIT-1 subquery regression.
				applyLedger(ctx, 51, [{
					TransactionType: 'NFTokenCreateOffer',
					Account: OWNER2,
					hash: hex64(0xbb),
					metaData: {
						TransactionResult: 'tesSUCCESS',
						TransactionIndex: 0,
						AffectedNodes: [{
							CreatedNode: {
								LedgerEntryType: 'NFTokenOffer',
								LedgerIndex: hex64(0xc1),
								NewFields: {
									NFTokenID: id2,
									Flags: 1,
									Amount: '5000000',
									Owner: OWNER2
								}
							}
						}]
					}
				}])

				let collection = ctx.db.core.nftCollections.readOne({
					where: { issuer: { address: ISSUER }, taxon: 7 }
				})
				expect(collection, 'collection exists').to.not.be.undefined

				// Seed a completed sale (3 XRP) on id2 directly — the FK needs an offer
				// row, and the exchange carries the denormalized collection.
				ctx.db.core.tx(() => {
					ctx.db.core.nftOffers.createOne({
						data: {
							offerId: hex64(0xc2),
							account: { address: OWNER1 },
							nft: { tokenId: id2 },
							collection: { id: collection.id },
							isSellOffer: false,
							amountToken: { id: 1 },
							amountValue: '3',
							ledgerSequence: 51,
							lastLedgerSequence: 51
						}
					})
					ctx.db.core.nftExchanges.createOne({
						data: {
							txHash: hex64(0xd1),
							account: { address: OWNER1 },
							offer: { offerId: hex64(0xc2) },
							nft: { tokenId: id2 },
							collection: { id: collection.id },
							amountToken: { id: 1 },
							amountValue: '3',
							isSellOffer: false,
							ledgerSequence: 51
						}
					})
				})

				updateCacheForNFTCollection({ ctx, collection: { id: collection.id } })

				let cached = readNFTCollection({ ctx, issuer: ISSUER, taxon: 7 })
				expect(cached, 'cache row').to.not.be.undefined
				expect(cached.supply, 'supply').to.equal(2)
				expect(cached.holders, 'holders').to.equal(2)
				expect(cached.floor.toString(), 'floor').to.equal('5')
				expect(cached.volumeAll.toString(), 'all-time volume').to.equal('3')
				expect(cached.trades7D, 'trade count').to.equal(1)
			}
		)

		it(
			'excludes destination-restricted (private) offers from the floor',
			async () => {
				let ctx = await createContext()
				let id1 = buildNFTokenId({ taxon: 8, serial: 1 })

				applyLedger(ctx, 60, [{
					TransactionType: 'NFTokenMint',
					Account: ISSUER,
					hash: hex64(0x1a),
					metaData: {
						TransactionResult: 'tesSUCCESS',
						TransactionIndex: 0,
						AffectedNodes: [mintNode(id1, OWNER1)]
					}
				}])

				// A private (destination-restricted) 1 XRP sell offer should NOT set floor.
				applyLedger(ctx, 61, [{
					TransactionType: 'NFTokenCreateOffer',
					Account: OWNER1,
					hash: hex64(0x1b),
					metaData: {
						TransactionResult: 'tesSUCCESS',
						TransactionIndex: 0,
						AffectedNodes: [{
							CreatedNode: {
								LedgerEntryType: 'NFTokenOffer',
								LedgerIndex: hex64(0x1c),
								NewFields: {
									NFTokenID: id1,
									Flags: 1,
									Amount: '1000000',
									Owner: OWNER1,
									Destination: OWNER2
								}
							}
						}]
					}
				}])

				let collection = ctx.db.core.nftCollections.readOne({
					where: { issuer: { address: ISSUER }, taxon: 8 }
				})
				updateCacheForNFTCollection({ ctx, collection: { id: collection.id } })

				let cached = readNFTCollection({ ctx, issuer: ISSUER, taxon: 8 })
				expect(cached.floor.toString(), 'floor ignores private offer').to.equal('0')
			}
		)

		it(
			'drops a burned NFT out of supply/holders',
			async () => {
				let ctx = await createContext()
				let id1 = buildNFTokenId({ taxon: 9, serial: 1 })
				let id2 = buildNFTokenId({ taxon: 9, serial: 2 })

				applyLedger(ctx, 70, [{
					TransactionType: 'NFTokenMint',
					Account: ISSUER,
					hash: hex64(0xee),
					metaData: {
						TransactionResult: 'tesSUCCESS',
						TransactionIndex: 0,
						AffectedNodes: [mintNode(id1, OWNER1), mintNode(id2, OWNER2)]
					}
				}])

				applyLedger(ctx, 71, [{
					TransactionType: 'NFTokenBurn',
					Account: OWNER1,
					NFTokenID: id1,
					hash: hex64(0xef),
					metaData: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [] }
				}])

				let collection = ctx.db.core.nftCollections.readOne({
					where: { issuer: { address: ISSUER }, taxon: 9 }
				})
				updateCacheForNFTCollection({ ctx, collection: { id: collection.id } })

				let cached = readNFTCollection({ ctx, issuer: ISSUER, taxon: 9 })
				expect(cached.supply, 'supply after burn').to.equal(1)
				expect(cached.holders, 'holders after burn').to.equal(1)
			}
		)
	}
)
