import { expect } from 'chai'
import { createContext } from '../env.js'
import { applyLedgerStateFromObjects } from '../../../src/ledger/state/index.js'
import { getAccountId, getTokenId } from '../../../src/db/helpers/common.js'


describe('AccountRoot snapshot processing', () => {
	it('processes an AccountRoot with a Domain set without crashing on cache mark', async () => {
		let ctx = await createContext()

		applyLedgerStateFromObjects({
			ctx: { ...ctx, ledgerSequence: 0 },
			objects: [
				{
					LedgerEntryType: 'AccountRoot',
					index: 'ACCT-1',
					Account: 'rKwsswRD2LvRMWjRh5pZthDNJcwWcMeZK8',
					Balance: '10000000',
					Flags: 0,
					// 'example.com' as hex — should trigger the domain-change cache mark path
					Domain: '6578616D706C652E636F6D',
					PreviousTxnLgrSeq: 100
				}
			]
		})

		let acc = ctx.db.core.accounts.readOne({ where: { address: 'rKwsswRD2LvRMWjRh5pZthDNJcwWcMeZK8' } })
		expect(acc, 'account row exists').to.not.be.null
		expect(acc.domain).to.equal('example.com')

		let todoRows = ctx.db.cache.todos.readMany({ where: { task: 'account.props' } })
		expect(todoRows.length, 'cache-dirty todo created').to.be.at.least(1)
	})
})


describe('getAccountId / getTokenId hardening', () => {
	const TEST_ADDR = 'rKwsswRD2LvRMWjRh5pZthDNJcwWcMeZK8'

	it('getAccountId ignores extraneous fields in lookup object', async () => {
		let ctx = await createContext()
		ctx.db.core.accounts.createOne({ data: { address: TEST_ADDR } })

		// Pass a "rich" parsed-account-style object with fields not on the Account schema
		let id = getAccountId({
			ctx,
			account: {
				address: TEST_ADDR,
				balance: '42',
				ledgerSequence: 100,
				pseudo: false,
				someUnknownField: 'whatever'
			}
		})

		expect(id, 'id resolved despite extraneous fields').to.be.ok
	})

	it('getTokenId ignores extraneous fields in lookup object', async () => {
		let ctx = await createContext()
		// XRP token is auto-created by openDB at id=1
		let xrpId = getTokenId({
			ctx,
			token: {
				currency: 'XRP',
				issuer: null,
				tokenType: 'XRP',
				supply: '100',
				holders: 5
			}
		})
		// id may be Number or BigInt depending on better-sqlite3 mode — compare loosely
		expect(Number(xrpId)).to.equal(1)
	})

	it('getAccountId returns undefined for empty lookup object', async () => {
		let ctx = await createContext()
		let id = getAccountId({ ctx, account: {} })
		expect(id).to.be.undefined
	})
})
