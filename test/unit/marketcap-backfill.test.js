import { expect } from 'chai'
import { createContext } from './env.js'
import {
	writeTokenMetrics,
	writeMetricSeriesBackward,
	readTokenMetricSeries
} from '../../src/db/helpers/tokenmetrics.js'
import TokenType from '../../src/xrpl/tokentype.js'


const ISSUER = 'rMrCiKUV4wUNXYJvZn2zQwd7BkSim2JJ3A'
let currencySeq = 0

function makeToken(ctx){
	// Distinct 3-char currency per token so each has its own metric series.
	let n = currencySeq++
	let currency = 'T' + String.fromCharCode(65 + (n % 26)) + String.fromCharCode(65 + ((n / 26 | 0) % 26))
	return ctx.db.core.tokens.createOne({
		data: { currency, issuer: { address: ISSUER }, tokenType: TokenType.IOU }
	})
}

function readSeries(ctx, token){
	return ctx.db.core.tokenMarketcap
		.readMany({ where: { token: { id: token.id } }, orderBy: { ledgerSequence: 'asc' } })
		.map(p => ({
			ledgerSequence: Number(p.ledgerSequence),
			value: p.value != null ? p.value.toString() : null
		}))
}

// Reference path: one writeTokenMetrics (-> writePoint -> a readPoint per point) call
// per ascending point. This is what the new fast path must reproduce byte-for-byte.
function applyOld(ctx, token, points){
	for(let { ledgerSequence, marketcap } of points){
		writeTokenMetrics({ ctx, token, ledgerSequence, metrics: { marketcap }, updateCache: false })
	}
}

function applyNew(ctx, token, points){
	writeMetricSeriesBackward({
		ctx,
		token,
		metric: 'marketcap',
		updateCache: false,
		points: points.map(({ ledgerSequence, marketcap }) => ({
			ledgerSequence,
			value: marketcap === '0' ? null : marketcap
		}))
	})
}

// Run the same series through both paths (each into its own token) and assert the
// materialised marketcap rows are identical. `seed` runs first on both (e.g. an anchor).
async function assertEquivalent(series, { seed, runs = 1 } = {}){
	let ctx = await createContext()
	let oldToken = makeToken(ctx)
	let newToken = makeToken(ctx)

	if(seed){
		applyOld(ctx, oldToken, seed)
		applyNew(ctx, newToken, seed)
	}

	for(let i = 0; i < runs; i++){
		applyOld(ctx, oldToken, series)
		applyNew(ctx, newToken, series)
	}

	let oldSeries = readSeries(ctx, oldToken)
	let newSeries = readSeries(ctx, newToken)
	expect(newSeries, 'new fast path must match the per-point writePoint loop').to.deep.equal(oldSeries)
	return { ctx, newToken, series: newSeries }
}


describe('marketcap backward-series fast path (writeMetricSeriesBackward)', () => {
	// Every interesting transition: fresh value, unchanged repeat, change, drop to zero,
	// held zero, recovery from zero.
	const SERIES = [
		{ ledgerSequence: 100, marketcap: '200' },
		{ ledgerSequence: 105, marketcap: '200' }, // unchanged → no point
		{ ledgerSequence: 110, marketcap: '350' },
		{ ledgerSequence: 115, marketcap: '0'   }, // drop to zero → marker
		{ ledgerSequence: 120, marketcap: '0'   }, // held zero
		{ ledgerSequence: 125, marketcap: '500' },
	]

	it('matches the per-point writePoint loop exactly (single pass)', async () => {
		let { series } = await assertEquivalent(SERIES)
		// Non-zero changes are materialised at the right sequences with the right values.
		let nonZero = series.filter(p => p.value != null && p.value !== '0')
		expect(nonZero).to.deep.equal([
			{ ledgerSequence: 100, value: '200' },
			{ ledgerSequence: 110, value: '350' },
			{ ledgerSequence: 125, value: '500' },
		])
	})

	it('matches the reference path under re-backfill (two passes over the same range)', async () => {
		await assertEquivalent(SERIES, { runs: 2 })
	})

	it('matches the reference path with an anchor point below the range', async () => {
		// Anchor value 200 at seq 50; the first in-range point (100=200) repeats it and
		// must not be re-materialised — both paths must agree on that.
		let { series } = await assertEquivalent(SERIES, {
			seed: [{ ledgerSequence: 50, marketcap: '200' }]
		})
		expect(series.some(p => p.ledgerSequence === 50)).to.equal(true)
		expect(series.some(p => p.ledgerSequence === 100)).to.equal(false)
	})

	it('matches the reference path for a strictly increasing series', async () => {
		await assertEquivalent([
			{ ledgerSequence: 10, marketcap: '1' },
			{ ledgerSequence: 20, marketcap: '2' },
			{ ledgerSequence: 30, marketcap: '3' },
			{ ledgerSequence: 40, marketcap: '4' },
		])
	})

	it('matches the reference path when the series opens with zeros (no prior point)', async () => {
		await assertEquivalent([
			{ ledgerSequence: 10, marketcap: '0' }, // no prior point → nothing written
			{ ledgerSequence: 20, marketcap: '0' },
			{ ledgerSequence: 30, marketcap: '750' },
			{ ledgerSequence: 40, marketcap: '0' }, // now a prior point exists → marker
		])
	})
})


describe('readTokenMetricSeries honours both range bounds', () => {
	// Regression: the upper bound used to be silently dropped (two range operators on one
	// field in a single where object — composeFilter keeps only the first), so the read
	// ran unbounded above sequenceStart. That over-read past firstMarketcap and was the
	// trigger for a sparse-series divergence in the backward marketcap pass.
	it('excludes points above sequenceEnd', async () => {
		let ctx = await createContext()
		let token = makeToken(ctx)

		for(let seq of [100, 150, 200, 250])
			ctx.db.core.tokenSupply.createOne({ data: { token: { id: token.id }, ledgerSequence: seq, value: '1' } })

		let bounded = readTokenMetricSeries({ ctx, token: { id: token.id }, metric: 'supply', sequenceStart: 120, sequenceEnd: 210 })
		expect(bounded.map(p => Number(p.ledgerSequence))).to.deep.equal([150, 200])

		// No upper bound → everything from sequenceStart up.
		let openEnded = readTokenMetricSeries({ ctx, token: { id: token.id }, metric: 'supply', sequenceStart: 120 })
		expect(openEnded.map(p => Number(p.ledgerSequence))).to.deep.equal([150, 200, 250])
	})
})


describe('metric point tables: redundant ascending unique index dropped (idx-2)', () => {
	it('keeps only the descending unique index on the metric tables', async () => {
		let ctx = await createContext()

		for(let table of ['TokenSupply', 'TokenTrustlines', 'TokenHolders', 'TokenMarketcap']){
			let names = ctx.db.core.database
				.all({
					text: `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`,
					values: [table]
				})
				.map(r => r.name)

			expect(names, `${table} asc index`).to.not.include(`${table}:unique-token-ledgerSequence:asc`)
			expect(names, `${table} desc index`).to.include(`${table}:unique-token-ledgerSequence:desc`)
		}
	})

	it('still de-duplicates points on (token, ledgerSequence) via the surviving unique index', async () => {
		let ctx = await createContext()
		let token = makeToken(ctx)

		ctx.db.core.tokenSupply.createOne({ data: { token: { id: token.id }, ledgerSequence: 100, value: '10' } })
		ctx.db.core.tokenSupply.createOne({ data: { token: { id: token.id }, ledgerSequence: 100, value: '20' } })

		let rows = ctx.db.core.tokenSupply.readMany({ where: { token: { id: token.id }, ledgerSequence: 100 } })
		expect(rows.length).to.equal(1)
	})
})
