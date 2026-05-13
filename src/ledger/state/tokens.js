import { sum, sub, eq, lt, gt, neg, max } from '../../../vendor/xfl/wrappers/class.js'
import { writeBalance } from '../../db/helpers/balances.js'
import { writeTokenMetrics, readTokenMetrics } from '../../db/helpers/tokenmetrics.js'
import TokenType from '../../xrpl/tokentype.js'
import { isPseudoAccount } from './pseudoaccounts.js'


export function parse({ entry }){
	if(!entry.HighLimit || !entry.LowLimit || !entry.Balance)
		return undefined

	let lowIssuer = entry.HighLimit.value !== '0' || lt(entry.Balance.value, '0')
	let highIssuer = entry.LowLimit.value !== '0' || gt(entry.Balance.value, '0')
	let transformed = {}

	if(lowIssuer){
		transformed.low = {
			account: { 
				address: entry.HighLimit.issuer 
			},
			token: {
				currency: entry.Balance.currency,
				issuer: {
					address: entry.LowLimit.issuer
				}
			},
			balance: max(0, neg(entry.Balance.value)),
			ledgerSequence: entry.LedgerSequence
		}
	}

	if(highIssuer){
		transformed.high = {
			account: { 
				address: entry.LowLimit.issuer 
			},
			token: {
				currency: entry.Balance.currency,
				issuer: {
					address: entry.HighLimit.issuer
				}
			},
			balance: max(0, entry.Balance.value),
			ledgerSequence: entry.LedgerSequence
		}
	}

	return transformed
}


export function group({ previous, final }){
	let groups = []

	for(let side of ['low', 'high']){
		let entry = final
			? final[side]
			: previous[side]

		if(!entry)
			continue

		groups.push({
			group: {
				token: entry.token,
				key: `${entry.token.currency}:${entry.token.issuer.address}`,
			},
			previous: previous ? previous[side] : undefined,
			final: final ? final[side] : undefined
		})
	}

	return groups
}


export function diff({ ctx, token, deltas }){
	token = ctx.db.core.tokens.createOne({
		data: {...token, tokenType: TokenType.IOU}
	})

	let { trustlines, holders, supply } = readTokenMetrics({ 
		ctx, 
		token, 
		metrics: {
			trustlines: true,
			holders: true,
			supply: true
		},
		ledgerSequence: ctx.ledgerSequence
	})

	let metrics = {
		trustlines: trustlines || 0,
		holders: holders || 0,
		supply: supply || 0,
	}

	for(let { previous, final } of deltas){
		let holderAddress = final?.account?.address || previous?.account?.address
		let pseudo = isPseudoAccount({ ctx, address: holderAddress })

		if(previous && final){
			metrics.supply = sum(
				metrics.supply,
				sub(final.balance, previous.balance)
			)

			if(!pseudo){
				if(eq(previous.balance, 0) && gt(final.balance, 0)){
					metrics.holders++
				}else if(eq(final.balance, 0) && gt(previous.balance, 0)){
					metrics.holders--
				}
			}
		}else if(final){
			metrics.trustlines++

			if(gt(final.balance, 0)){
				metrics.supply = sum(metrics.supply, final.balance)
				if(!pseudo)
					metrics.holders++
			}
		}else{
			metrics.trustlines--

			if(gt(previous.balance, 0)){
				metrics.supply = sub(metrics.supply, previous.balance)
				if(!pseudo)
					metrics.holders--
			}
		}

		if(ctx.backwards && !previous){
			// edge case when backfilling RippleState deletions
			writeBalance({
				ctx,
				account: final.account,
				token,
				ledgerSequence: ctx.ledgerSequence,
				balance: '0',
			})
		}

		if(final){
			writeBalance({
				ctx,
				account: final.account,
				token,
				ledgerSequence: final.ledgerSequence,
				balance: final.balance
			})
		}else{
			writeBalance({
				ctx,
				account: previous.account,
				token,
				ledgerSequence: ctx.ledgerSequence,
				balance: '0',
			})
		}
	}

	writeTokenMetrics({
		ctx,
		token,
		metrics,
		ledgerSequence: ctx.ledgerSequence
	})
}