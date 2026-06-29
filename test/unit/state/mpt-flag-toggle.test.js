import { expect } from 'chai'
import { createContext } from '../env.js'
import { applyLedgerStateFromTransactions } from '../../../src/ledger/state/index.js'
import { readTokenMetrics } from '../../../src/db/helpers/tokenmetrics.js'
import TokenType from '../../../src/xrpl/tokentype.js'


const ID = '00000003DB82F23B803E4509878F1BF4555EBAB3A30DE89F'
const ISSUER = 'rMrCiKUV4wUNXYJvZn2zQwd7BkSim2JJ3A'
const ALICE = 'rKwsswRD2LvRMWjRh5pZthDNJcwWcMeZK8'


function applyLedger(ctx, sequence, transactions){
	let ledger = { sequence, ledger_index: String(sequence), transactions }
	ctx.db.core.tx(() => {
		applyLedgerStateFromTransactions({ ctx: { ...ctx, ledgerSequence: sequence }, ledger })
	})
}


describe(
	'MPToken flag-only change (MPTokenIssuanceSet) must not double-count',
	() => {
		it(
			'keeps supply/holders stable when only a holder flag toggles',
			async () => {
				let ctx = await createContext()

				// Ledger 7: Alice is credited 1000 — her MPToken object is created.
				applyLedger(ctx, 7, [{
					TransactionType: 'Payment',
					Account: ISSUER,
					hash: 'A'.repeat(64),
					metaData: {
						TransactionResult: 'tesSUCCESS',
						TransactionIndex: 0,
						AffectedNodes: [{
							CreatedNode: {
								LedgerEntryType: 'MPToken',
								LedgerIndex: 'B'.repeat(64),
								NewFields: {
									Account: ALICE,
									MPTokenIssuanceID: ID,
									MPTAmount: '1000'
								}
							}
						}]
					}
				}])

				let token = ctx.db.core.tokens.readOne({
					where: { mptIssuanceId: ID, tokenType: TokenType.MPT }
				})
				let m1 = readTokenMetrics({ ctx, token, metrics: { holders: true, supply: true }, ledgerSequence: 7 })
				expect((m1.supply || '0').toString()).to.equal('1000')
				expect(m1.holders || 0).to.equal(1)

				// Ledger 8: issuer locks Alice via MPTokenIssuanceSet. The MPToken is a
				// ModifiedNode whose only changed field (a flag, prev value default 0) is
				// omitted -> empty PreviousFields. MPTAmount is UNCHANGED at 1000.
				applyLedger(ctx, 8, [{
					TransactionType: 'MPTokenIssuanceSet',
					Account: ISSUER,
					hash: 'C'.repeat(64),
					metaData: {
						TransactionResult: 'tesSUCCESS',
						TransactionIndex: 0,
						AffectedNodes: [{
							ModifiedNode: {
								LedgerEntryType: 'MPToken',
								LedgerIndex: 'B'.repeat(64),
								FinalFields: {
									Account: ALICE,
									MPTokenIssuanceID: ID,
									MPTAmount: '1000',
									Flags: 2
								},
								PreviousFields: {},
								PreviousTxnLgrSeq: 7
							}
						}]
					}
				}])

				let m2 = readTokenMetrics({ ctx, token, metrics: { holders: true, supply: true }, ledgerSequence: 8 })
				expect((m2.supply || '0').toString(), 'supply unchanged after flag toggle').to.equal('1000')
				expect(m2.holders || 0, 'holders unchanged after flag toggle').to.equal(1)
			}
		)
	}
)
