import { readPoint, writePoint } from './common.js'
import { markCacheDirtyForTokenMetrics } from '../../cache/todo.js'


const metricTables = {
	trustlines: 'tokenTrustlines',
	holders: 'tokenHolders',
	supply: 'tokenSupply',
	marketcap: 'tokenMarketcap'
}


export function writeTokenMetrics({ ctx, token, ledgerSequence, metrics, updateCache = true }){
	for(let [key, value] of Object.entries(metrics)){
		writePoint({
			table: ctx.db.core[metricTables[key]],
			selector: {
				token
			},
			ledgerSequence,
			backwards: ctx.backwards,
			data: value.toString() !== '0'
				? { value }
				: null
		})
	}

	if(updateCache)
		markCacheDirtyForTokenMetrics({ ctx, token, metrics })
}


// Backward-only fast path for materialising a whole metric series in one shot.
// Equivalent to calling writePoint for each ascending (ledgerSequence, value) point,
// but reads the existing range + the anchor point below it ONCE instead of doing a
// readPoint per point — the dominant cost when a single exchange backfills a
// long-history token's marketcap (an O(token-history) spike independent of tx count).
//
// Preserves writePoint's sparse-series invariant: a point exists at a ledger only
// where the value changes vs the previous materialised point; a transition to zero is
// recorded as a value-less marker row (matching writePoint's `...data` with null data),
// and a value that is unchanged from the previous point is not materialised.
export function writeMetricSeriesBackward({ ctx, token, metric, points, updateCache = true }){
	let table = ctx.db.core[metricTables[metric]]

	if(points.length === 0)
		return

	let sequenceStart = points[0].ledgerSequence
	let sequenceEnd = points[points.length - 1].ledgerSequence

	// Any points already materialised in this range (idempotent re-backfill), keyed by
	// ledgerSequence so we update/delete in place instead of inserting duplicates.
	// PRECONDITION: callers must not have pre-existing points at sequences ABSENT from
	// `points` within this range — change detection below tracks the previous *series*
	// value, which only equals readPoint(<= seq) when stray in-range points don't exist.
	// The marketcap caller satisfies this: its range is strictly below firstMarketcap, so
	// no marketcap point exists in it and this map is empty (or, on re-backfill, holds
	// only points at series sequences).
	let existingBySeq = new Map(
		readTokenMetricSeries({ ctx, token, metric, sequenceStart, sequenceEnd })
			.map(p => [p.ledgerSequence.toString(), p])
	)

	// `prev` = value of the most recent materialised point strictly BELOW the current
	// one (null = none), seeded from the anchor point just below the range. This is
	// exactly what writePoint's readPoint(<= seq) sees, so the branches below mirror
	// writePoint one-for-one (including the detail that a zero/marker is written for
	// every zero point with a prior point — zeros are NOT change-deduped).
	let anchor = readPoint({ table, selector: { token }, ledgerSequence: sequenceStart - 1 })
	let prev = anchor ? (anchor.value != null ? anchor.value.toString() : '0') : null

	for(let { ledgerSequence, value } of points){
		let existing = existingBySeq.get(ledgerSequence.toString())

		if(value != null){
			// Non-zero value: write only when it differs from the most recent point
			// (writePoint's change detection), updating in place on an exact-seq hit.
			let str = value.toString()
			let pointValue = existing
				? (existing.value != null ? existing.value.toString() : '0')
				: prev

			if(pointValue !== str){
				if(existing)
					table.updateOne({ data: { value }, where: { id: existing.id } })
				else
					table.createOne({ data: { token, ledgerSequence, value } })
			}
			prev = str
		}else{
			// Zero: delete an exact-seq point, else write a value-less marker whenever a
			// prior point exists, else do nothing (matches writePoint's null-data path).
			if(existing){
				table.deleteOne({ where: { id: existing.id } })
			}else if(prev != null){
				table.createOne({ data: { token, ledgerSequence } })
				prev = '0'
			}
		}
	}

	if(updateCache)
		markCacheDirtyForTokenMetrics({ ctx, token, metrics: { [metric]: true } })
}


export function readTokenMetrics({ ctx, token, ledgerSequence, metrics }){
	let point = {}

	for(let key of Object.keys(metrics)){
		let entry = readPoint({
			table: ctx.db.core[metricTables[key]],
			selector: {
				token
			},
			ledgerSequence
		})

		if(entry){
			point[key] = entry.value
		}
	}

	return point
}



export function readTokenMetricSeries({ ctx, token, metric, sequenceStart, sequenceEnd }){
	return ctx.db.core[metricTables[metric]].readMany({
		where: {
			token,
			// Both bounds MUST be separate AND conditions. structdb's composeFilter keeps
			// only the FIRST range operator when two are placed on one field in the same
			// object, so `{ greaterOrEqual, lessOrEqual }` would silently drop the upper
			// bound — making this read run unbounded above sequenceStart.
			AND: [
				{ ledgerSequence: { greaterOrEqual: sequenceStart } },
				...(sequenceEnd != null ? [{ ledgerSequence: { lessOrEqual: sequenceEnd } }] : [])
			]
		},
		orderBy: {
			ledgerSequence: 'asc'
		}
	})
}



export function readTokenMetricIntervalSeries({ ctx, token, metric, sequence, time }){
	let table = metricTables[metric]
	
	if(time){
		return ctx.db.core[table].readManyRaw({
			query: 
				`SELECT MAX(Ledger.closeTime) as time, value
				FROM ${table}
				LEFT JOIN Ledger ON (Ledger.sequence = ledgerSequence)
				WHERE token = ?
					AND (
						(Ledger.closeTime >= ? AND Ledger.closeTime <= ?)
						OR
						(
							ledgerSequence = (
								SELECT ledgerSequence
								FROM ${table}
								WHERE token = ?
									AND ledgerSequence < ?
								ORDER BY ledgerSequence DESC
								LIMIT 1
							)
						)
					)
				GROUP BY Ledger.closeTime / CAST(? as INTEGER)
				ORDER BY Ledger.closeTime ASC`,
			params: [
				token.id,
				time.start,
				time.end,
				token.id,
				sequence.start,
				time.interval,
			]
		})
	}else{
		return ctx.db.core[table].readManyRaw({
			query: 
				`SELECT MAX(ledgerSequence) as sequence, value
				FROM ${table}
				WHERE token = ?
					AND (
						(ledgerSequence >= ? AND ledgerSequence <= ?)
						OR
						(
							ledgerSequence = (
								SELECT ledgerSequence
								FROM ${table}
								WHERE token = ?
									AND ledgerSequence < ?
								ORDER BY ledgerSequence DESC
								LIMIT 1
							)
						)
					)
				GROUP BY ledgerSequence / CAST(? as INTEGER)
				ORDER BY ledgerSequence ASC`,
			params: [
				token.id,
				sequence.start,
				sequence.end,
				token.id,
				sequence.start,
				sequence.interval,
			]
		})
	}
}