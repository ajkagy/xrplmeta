import log from '../lib/log.js'
import { spawn } from '../lib/workers.js'
import { markSyncOperation, endSyncOperation, isLoopStressed, isLoopCritical } from '../lib/health.js'
import { applyLedgerEvents } from './events/index.js'
import { applyLedgerStateFromTransactions } from './state/index.js'
import { updateDerived } from './derived/index.js'
import { pullNewItems, readTableHeads } from '../db/helpers/heads.js'
import { wait } from '../lib/time.js'
import { httpLoadPending } from '../cache/worker.js'


export async function startBackfill({ ctx }){
	let { sequence: firstSequence } = ctx.db.core.ledgers.readOne({
		orderBy: {
			sequence: 'asc'
		},
		take: 1
	})
	
	let stream = await spawn(
		'../xrpl/stream.js:createBackwardStream',
		{
			ctx,
			startSequence: firstSequence - 1 
		}
	)
	
	while(true){
		let { ledger } = await stream.next()
		let blockStart = process.hrtime.bigint()

		markSyncOperation(`backfill.ledger#${ledger.sequence}(${ledger.transactions.length}txs)`)
		ctx.db.core.tx(() => {
			ctx = {
				...ctx,
				currentLedger: ledger,
				ledgerSequence: ledger.sequence,
				backwards: true
			}

			try{
				let heads = readTableHeads({ ctx })

				applyLedgerEvents({ ctx, ledger })
				applyLedgerStateFromTransactions({ ctx, ledger })
				updateDerived({
					ctx,
					newItems: pullNewItems({
						ctx,
						previousHeads: heads
					})
				})
			}catch(error){
				log.error(`fatal error while backfilling ledger #${ledger.sequence}:`)
				log.error(error.stack)

				throw error
			}
		})

		endSyncOperation()

		let elapsedMs = Number(process.hrtime.bigint() - blockStart) / 1e6
		if(elapsedMs > 500)
			log.warn(`slow backfill: ledger #${ledger.sequence} (${ledger.transactions.length} txs) took ${elapsedMs.toFixed(0)}ms — blocked event loop`)

		log.accumulate.info({
			text: [
				`at ledger #${ledger.sequence} ${
					new Date(ledger.closeTime * 1000)
						.toISOString()
						.slice(0, -5)
						.replace('T', ' ')
				} (+%backfilledLedgers in %time)`
			],
			data: {
				backfilledLedgers: 1
			}
		})

		// Yield to the event loop between ledgers so queued HTTP / WS / timers get a
		// slice — the apply tx is synchronous and can't yield mid-transaction, so this
		// per-ledger setImmediate is the only pacing when the loop is idle (mirrors
		// the forward-sync loop). Without it, backfill monopolises the loop.
		await new Promise(resolve => setImmediate(resolve))

		// Only actively throttle when the loop is genuinely under load; when it's idle
		// the yield above is enough and backfill runs at full speed. Gating on the lag
		// predicates (not raw httpLoadPending) avoids slowing backfill when requests
		// are in flight but the loop is keeping up.
		let pending = httpLoadPending()
		if(isLoopCritical())
			await wait(Math.min(500, 50 * (pending || 1)))
		else if(isLoopStressed() && pending > 0)
			await wait(Math.min(200, 25 * pending))
	}
}