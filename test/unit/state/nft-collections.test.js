import { expect } from 'chai'
import { decodeAccountID } from 'ripple-address-codec'
import { createContext } from '../env.js'
import { applyLedgerStateFromTransactions } from '../../../src/ledger/state/index.js'
import { applyLedgerEvents } from '../../../src/ledger/events/index.js'


const ISSUER = 'rMrCiKUV4wUNXYJvZn2zQwd7BkSim2JJ3A'
const OWNER = 'rKwsswRD2LvRMWjRh5pZthDNJcwWcMeZK8'


function hexAccount(address){
	return Buffer.from(decodeAccountID(address)).toString('hex').toUpperCase()
}

function buildNFTokenId({ flags, transferFee, issuer, taxon, serial }){
	let scrambled = (BigInt(taxon) ^ ((384160001n * BigInt(serial) + 2459n) % 4294967296n)) % 4294967296n

	return (
		flags.toString(16).padStart(4, '0') +
		transferFee.toString(16).padStart(4, '0') +
		hexAccount(issuer).toLowerCase() +
		scrambled.toString(16).padStart(8, '0') +
		serial.toString(16).padStart(8, '0')
	).toUpperCase()
}

function applyLedger(ctx, sequence, transactions){
	let ledger = {
		sequence,
		ledger_index: String(sequence),
		hash: sequence.toString(16).padStart(64, '0').toUpperCase(),
		closeTime: 1000000000 + sequence,
		transactions
	}
	ctx.db.core.tx(() => {
		let testCtx = { ...ctx, ledgerSequence: sequence }
		applyLedgerStateFromTransactions({ ctx: testCtx, ledger })
		applyLedgerEvents({ ctx: testCtx, ledger })
	})
}


describe(
	'NFT collections & decoding (Phase 1)',
	() => {
		it(
			'mints an NFT: creates the collection, links it, decodes fields, records mint ledger',
			async () => {
				let ctx = await createContext()
				let tokenId = buildNFTokenId({ flags: 8, transferFee: 0, issuer: ISSUER, taxon: 7, serial: 1 })
				let pageIndex = hexAccount(OWNER) + '0'.repeat(24)

				applyLedger(ctx, 50, [{
					TransactionType: 'NFTokenMint',
					Account: ISSUER,
					hash: 'D'.repeat(64),
					metaData: {
						TransactionResult: 'tesSUCCESS',
						TransactionIndex: 0,
						AffectedNodes: [{
							CreatedNode: {
								LedgerEntryType: 'NFTokenPage',
								LedgerIndex: pageIndex,
								NewFields: {
									NFTokens: [{ NFToken: { NFTokenID: tokenId } }]
								}
							}
						}]
					}
				}])

				let nft = ctx.db.core.nfts.readOne({
					where: { tokenId },
					include: { collection: true, owner: true, issuer: true }
				})

				expect(nft, 'nft row').to.not.be.undefined
				expect(nft.taxon).to.equal(7)
				expect(nft.flags).to.equal(8)
				expect(nft.serial).to.equal(1)
				expect(nft.owner.address).to.equal(OWNER)
				expect(nft.issuer.address).to.equal(ISSUER)
				expect(nft.mintLedgerSequence).to.equal(50)

				let collection = ctx.db.core.nftCollections.readOne({
					where: { issuer: { address: ISSUER }, taxon: 7 }
				})
				expect(collection, 'collection row').to.not.be.undefined
				expect(collection.firstSeenLedger).to.equal(50)
				expect(nft.collection.id).to.equal(collection.id)
			}
		)

		it(
			'burns an NFT: clears owner and records burn ledger',
			async () => {
				let ctx = await createContext()
				let tokenId = buildNFTokenId({ flags: 0, transferFee: 0, issuer: ISSUER, taxon: 3, serial: 9 })
				let pageIndex = hexAccount(OWNER) + '0'.repeat(24)

				applyLedger(ctx, 60, [{
					TransactionType: 'NFTokenMint',
					Account: ISSUER,
					hash: 'A'.repeat(64),
					metaData: {
						TransactionResult: 'tesSUCCESS',
						TransactionIndex: 0,
						AffectedNodes: [{
							CreatedNode: {
								LedgerEntryType: 'NFTokenPage',
								LedgerIndex: pageIndex,
								NewFields: { NFTokens: [{ NFToken: { NFTokenID: tokenId } }] }
							}
						}]
					}
				}])

				applyLedger(ctx, 61, [{
					TransactionType: 'NFTokenBurn',
					Account: OWNER,
					NFTokenID: tokenId,
					hash: 'B'.repeat(64),
					metaData: {
						TransactionResult: 'tesSUCCESS',
						TransactionIndex: 0,
						AffectedNodes: []
					}
				}])

				let nft = ctx.db.core.nfts.readOne({
					where: { tokenId },
					include: { owner: true }
				})

				expect(nft.owner, 'owner cleared on burn').to.satisfy(o => o == null || o.id == null)
				expect(nft.burnLedgerSequence).to.equal(61)
			}
		)
	}
)
