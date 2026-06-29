import { expect } from 'chai'
import { createContext } from './env.js'
import { applyLedgerStateFromObjects } from '../../src/ledger/state/index.js'
import { readAmmPools, readAmmPoolByAccount } from '../../src/db/helpers/amm.js'


const ctx = await createContext()

const POOL_ACCOUNT = 'rrrrrrrrrrrrrrrrrrrrBZbvji'
const ISSUER = 'rrrrrrrrrrrrrrrrrrrn5RM1rHd'


describe(
	'AMM table activation',
	() => {
		it(
			'registers the ammPools core table',
			() => {
				expect(ctx.db.core.ammPools).to.not.equal(undefined)
			}
		)

		it(
			'readAmmPools returns the empty shape (not a crash) when no pools exist',
			() => {
				expect(readAmmPools({ ctx })).to.deep.equal({ count: 0, pools: [] })
			}
		)

		it(
			'records an AMM pool from a ledger object and reads it back',
			() => {
				ctx.db.core.tx(() => {
					applyLedgerStateFromObjects({
						ctx: { ...ctx, ledgerSequence: 100 },
						objects: [
							{
								LedgerEntryType: 'AMM',
								index: 'AE0A97F385FFB7D294B1FE1AC59A9F5A99F2A1A6C0E4D6F0F0C7E0E2B4D5C6A7',
								Account: POOL_ACCOUNT,
								Asset: { currency: 'XRP' },
								Asset2: { currency: 'USD', issuer: ISSUER },
								LPTokenBalance: { currency: '03ABCDEF', issuer: POOL_ACCOUNT, value: '1000' },
								TradingFee: 500,
								PreviousTxnLgrSeq: 100
							}
						]
					})
				})

				let { count, pools } = readAmmPools({ ctx })
				expect(count).to.equal(1)
				expect(pools[0].account).to.equal(POOL_ACCOUNT)
				expect(pools[0].tradingFee).to.equal(500)

				let one = readAmmPoolByAccount({ ctx, address: POOL_ACCOUNT })
				expect(one).to.not.equal(null)
				expect(one.account).to.equal(POOL_ACCOUNT)
			}
		)
	}
)
