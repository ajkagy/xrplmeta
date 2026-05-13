import { expect } from 'chai'
import { createContext } from '../env.js'
import { applyLedgerStateFromTransactions } from '../../../src/ledger/state/index.js'
import { collectPseudoFromDeltas, isPseudoAccount } from '../../../src/ledger/state/pseudoaccounts.js'
import { readTokenMetrics } from '../../../src/db/helpers/tokenmetrics.js'
import { readTokenHolders } from '../../../src/db/helpers/tokenholders.js'
import TokenType from '../../../src/xrpl/tokentype.js'


// XRPL AccountRoot.lsfAMM flag — marks the account as an AMM pool's pseudo-account.
const LSF_AMM = 0x02000000

const ISSUER = 'rMrCiKUV4wUNXYJvZn2zQwd7BkSim2JJ3A'
const ALICE  = 'rKwsswRD2LvRMWjRh5pZthDNJcwWcMeZK8'
const AMM_PSEUDO_ACCT = 'rsnyc3RYKFrRHgVZ4TJ6PKnPCBtaJkiqig'


describe('pseudoaccounts helper', () => {
	it('collects AccountRoot entries with lsfAMM as pseudo', () => {
		let deltas = [
			{ type: 'AccountRoot', final: { Account: ALICE, Flags: 0 } },
			{ type: 'AccountRoot', final: { Account: AMM_PSEUDO_ACCT, Flags: LSF_AMM } },
			{ type: 'RippleState', final: {} },
		]
		let set = collectPseudoFromDeltas(deltas)
		expect(set.has(AMM_PSEUDO_ACCT)).to.be.true
		expect(set.has(ALICE)).to.be.false
	})

	it('isPseudoAccount returns true when ctx.pseudoAccounts contains the address', () => {
		let ctx = { pseudoAccounts: new Set([AMM_PSEUDO_ACCT]) }
		expect(isPseudoAccount({ ctx, address: AMM_PSEUDO_ACCT })).to.be.true
		expect(isPseudoAccount({ ctx, address: ALICE })).to.be.false
	})

	it('isPseudoAccount falls back to DB lookup for accounts not in current-ledger set', async () => {
		let ctx = await createContext()
		ctx.db.core.accounts.createOne({ data: { address: AMM_PSEUDO_ACCT, pseudo: true, pseudoSource: 'amm' } })
		ctx.db.core.accounts.createOne({ data: { address: ALICE, pseudo: false } })

		ctx.pseudoAccounts = new Map()
		ctx.pseudoAccountsCache = new Map()

		expect(isPseudoAccount({ ctx, address: AMM_PSEUDO_ACCT })).to.be.true
		expect(isPseudoAccount({ ctx, address: ALICE })).to.be.false

		// Cache stores { pseudo, pseudoSource } info objects, not bare booleans
		let cached = ctx.pseudoAccountsCache.get(AMM_PSEUDO_ACCT)
		expect(cached.pseudo).to.be.true
		expect(cached.pseudoSource).to.equal('amm')
	})
})


describe('AMM pseudo-account exclusion from holder count', () => {
	const CURRENCY_USD = '0000000000000000000000005553440000000000'  // hex-encoded "USD"

	it('AMM pseudo-account holding a trustline does not increment holder count', async () => {
		let ctx = await createContext()

		// Single ledger: TrustSet creates a regular account holder, AMMCreate creates a pseudo-account
		// trustline. We expect holders=1 (only Alice), supply=10000+5000=15000.
		let ledger = {
			sequence: 100,
			transactions: [
				{
					Account: ALICE,
					TransactionType: 'TrustSet',
					hash: 'TX-TRUSTSET',
					Fee: '12',
					metaData: {
						TransactionResult: 'tesSUCCESS',
						AffectedNodes: [
							{ CreatedNode: {
								LedgerEntryType: 'AccountRoot',
								LedgerIndex: 'ACCT-ALICE',
								NewFields: { Account: ALICE, Balance: '10000000', Flags: 0 }
							} },
							{ CreatedNode: {
								LedgerEntryType: 'RippleState',
								LedgerIndex: 'TL-ALICE',
								NewFields: {
									HighLimit: { issuer: ALICE, currency: CURRENCY_USD, value: '1000000' },
									LowLimit:  { issuer: ISSUER, currency: CURRENCY_USD, value: '0' },
									Balance:   { issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', currency: CURRENCY_USD, value: '-10000' }
								}
							} },
						]
					}
				},
				{
					Account: ISSUER,
					TransactionType: 'AMMCreate',
					hash: 'TX-AMMCREATE',
					Fee: '12',
					metaData: {
						TransactionResult: 'tesSUCCESS',
						AffectedNodes: [
							{ CreatedNode: {
								LedgerEntryType: 'AccountRoot',
								LedgerIndex: 'ACCT-AMM',
								NewFields: { Account: AMM_PSEUDO_ACCT, Balance: '10000000', Flags: LSF_AMM }
							} },
							{ CreatedNode: {
								LedgerEntryType: 'RippleState',
								LedgerIndex: 'TL-AMM',
								NewFields: {
									HighLimit: { issuer: AMM_PSEUDO_ACCT, currency: CURRENCY_USD, value: '1000000' },
									LowLimit:  { issuer: ISSUER, currency: CURRENCY_USD, value: '0' },
									Balance:   { issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', currency: CURRENCY_USD, value: '-5000' }
								}
							} },
						]
					}
				}
			]
		}

		applyLedgerStateFromTransactions({ ctx: { ...ctx, ledgerSequence: 100 }, ledger })

		let token = ctx.db.core.tokens.readOne({
			where: {
				currency: CURRENCY_USD,
				issuer: { address: ISSUER },
				tokenType: TokenType.IOU
			}
		})
		expect(token, 'IOU token should be created').to.not.be.null

		let metrics = readTokenMetrics({
			ctx,
			token,
			metrics: { trustlines: true, holders: true, supply: true },
			ledgerSequence: 100
		})

		// Both trustlines count (it's still trustlines including AMM)
		expect(metrics.trustlines).to.equal(2)
		// But only Alice counts as a holder; the AMM is excluded
		expect(metrics.holders).to.equal(1)
		// Total supply includes the AMM-locked portion (it was issued)
		expect(metrics.supply.toString()).to.equal('15000')

		// The AMM pseudo-account should be marked in the Account table
		let ammAccount = ctx.db.core.accounts.readOne({ where: { address: AMM_PSEUDO_ACCT } })
		expect(ammAccount.pseudo, 'AMM account marked pseudo').to.be.true
		expect(ammAccount.pseudoSource, 'pseudoSource is amm').to.equal('amm')

		// readTokenHolders should return both holders with the pool flag set on the AMM
		let holders = readTokenHolders({ ctx, token, ledgerSequence: 100 })
		expect(holders.length).to.equal(2)
		let amm = holders.find(h => h.account.address === AMM_PSEUDO_ACCT)
		let alice = holders.find(h => h.account.address === ALICE)
		expect(amm, 'AMM holder row exists').to.exist
		expect(alice, 'Alice holder row exists').to.exist
		expect(amm.account.pseudo, 'AMM marked pseudo in holders query').to.be.true
		expect(amm.account.pseudoSource).to.equal('amm')
		expect(alice.account.pseudo, 'Alice NOT marked pseudo').to.be.false
	})
})
