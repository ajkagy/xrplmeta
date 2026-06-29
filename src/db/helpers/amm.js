import { readBalance } from './balances.js'
import { readMostRecentLedger, readLedgerAt } from './ledgers.js'

// Read the current state of all AMM pools with optional pagination + filtering.
// Pool reserves are computed live from the pseudo-account's balances at the requested ledger.
export function readAmmPools({ ctx, ledgerSequence, offset = 0, limit = 50, token }){
	// The ammPools table is not currently registered in the core schema (see
	// docs/audit findings); the state writer no-ops when it's absent, so guard the
	// readers too rather than throwing on every /v2/amms request.
	if(!ctx.db?.core?.ammPools)
		return { count: 0, pools: [] }

	let where = {}

	if(token){
		// Pools where either asset matches the provided token
		where.OR = [
			{ asset1Token: token },
			{ asset2Token: token }
		]
	}

	let pools = ctx.db.core.ammPools.readMany({
		where,
		include: {
			account: true,
			asset1Token: { issuer: true },
			asset2Token: { issuer: true }
		},
		skip: offset,
		take: limit
	})

	let count = ctx.db.core.ammPools.count({ where })
	let effectiveSequence = ledgerSequence ?? readMostRecentLedger({ ctx })?.sequence

	let result = pools.map(pool => ({
		account: pool.account.address,
		asset1: tokenToApi(pool.asset1Token),
		asset2: tokenToApi(pool.asset2Token),
		lpTokenCurrency: pool.lpTokenCurrency,
		tradingFee: pool.tradingFee,
		asset1Balance: readBalance({
			ctx,
			account: pool.account,
			token: pool.asset1Token,
			ledgerSequence: effectiveSequence
		})?.toString() ?? '0',
		asset2Balance: readBalance({
			ctx,
			account: pool.account,
			token: pool.asset2Token,
			ledgerSequence: effectiveSequence
		})?.toString() ?? '0',
		ledgerSequence: effectiveSequence
	}))

	return { count: Number(count), pools: result }
}

export function readAmmPoolByAccount({ ctx, address, ledgerSequence }){
	if(!ctx.db?.core?.ammPools)
		return null

	let pool = ctx.db.core.ammPools.readOne({
		where: { account: { address } },
		include: {
			account: true,
			asset1Token: { issuer: true },
			asset2Token: { issuer: true }
		}
	})

	if(!pool) return null

	let effectiveSequence = ledgerSequence ?? readMostRecentLedger({ ctx })?.sequence

	return {
		account: pool.account.address,
		asset1: tokenToApi(pool.asset1Token),
		asset2: tokenToApi(pool.asset2Token),
		lpTokenCurrency: pool.lpTokenCurrency,
		tradingFee: pool.tradingFee,
		asset1Balance: readBalance({
			ctx,
			account: pool.account,
			token: pool.asset1Token,
			ledgerSequence: effectiveSequence
		})?.toString() ?? '0',
		asset2Balance: readBalance({
			ctx,
			account: pool.account,
			token: pool.asset2Token,
			ledgerSequence: effectiveSequence
		})?.toString() ?? '0',
		ledgerSequence: effectiveSequence
	}
}

function tokenToApi(token){
	if(!token) return undefined
	if(token.tokenType === 'XRP')
		return { currency: 'XRP' }
	if(token.tokenType === 'MPT')
		return { mpt_issuance_id: token.mptIssuanceId }
	return {
		currency: token.currency,
		issuer: token.issuer?.address
	}
}

// Read a series of pool snapshots over a sequence or time range.
// Returns an array of { ledgerSequence, asset1Balance, asset2Balance } points.
export function readAmmPoolSeries({ ctx, address, sequence, time, points = 50 }){
	if(!ctx.db?.core?.ammPools)
		return null

	// Clamp sample count so a large `points` can't collapse `step` to 1 and turn this
	// into an O(ledger-span) synchronous loop that blocks the event loop (DoS).
	points = Math.min(Math.max(1, points | 0), 1000)

	let pool = ctx.db.core.ammPools.readOne({
		where: { account: { address } },
		include: {
			account: true,
			asset1Token: { issuer: true },
			asset2Token: { issuer: true }
		}
	})
	if(!pool) return null

	let startSeq, endSeq
	if(sequence){
		startSeq = sequence.start
		endSeq = sequence.end ?? readMostRecentLedger({ ctx })?.sequence
	}else if(time){
		let s = readLedgerAt({ ctx, time: time.start, clamp: true })
		let e = readLedgerAt({ ctx, time: time.end ?? Math.floor(Date.now() / 1000), clamp: true })
		startSeq = s?.sequence
		endSeq = e?.sequence
	}else{
		return null
	}

	if(startSeq == null || endSeq == null || endSeq < startSeq) return []

	// Build evenly-spaced sample sequences across the range, capped at `points`.
	let span = endSeq - startSeq
	let step = Math.max(1, Math.floor(span / Math.max(1, points - 1)))
	let series = []
	for(let seq = startSeq; seq <= endSeq; seq += step){
		series.push({
			ledgerSequence: seq,
			asset1Balance: readBalance({
				ctx,
				account: pool.account,
				token: pool.asset1Token,
				ledgerSequence: seq
			})?.toString() ?? '0',
			asset2Balance: readBalance({
				ctx,
				account: pool.account,
				token: pool.asset2Token,
				ledgerSequence: seq
			})?.toString() ?? '0',
		})
	}

	return {
		account: pool.account.address,
		asset1: tokenToApi(pool.asset1Token),
		asset2: tokenToApi(pool.asset2Token),
		series
	}
}
