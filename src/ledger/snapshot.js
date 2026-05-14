import log from '../lib/log.js'
import { unixNow } from '../lib/time.js'
import { spawn } from '../lib/workers.js'
import { markSyncOperation, endSyncOperation } from '../lib/health.js'
import { fetch as fetchLedger } from '../xrpl/ledger.js'
import { applyLedgerStateFromObjects } from './state/index.js'
import { applyLedgerEvents } from './events/index.js'
import { updateAllDerived } from './derived/index.js'


export async function createSnapshot({ ctx }){
	ctx = {
		...ctx,
		snapshotState: ctx.db.core.snapshots.readLast(),
		ledgerSequence: 0
	}

	if(!ctx.snapshotState){
		await createSnapshotState({ ctx })
		log.info(`creating snapshot of ledger #${ctx.snapshotState.ledgerSequence} - this may take a long time`)
	}

	if(ctx.snapshotState.entriesCount === 0 || ctx.snapshotState.marker){
		try{
			await copyFromFeed({
				ctx,
				feed: await createFeed({
					ctx,
					ledgerSequence: ctx.snapshotState.ledgerSequence,
					marker: ctx.snapshotState.marker,
					node: ctx.snapshotState.originNode
				})
			})
		}catch(error){
			log.error(`fatal error while copying from ledger feed: ${error?.message || error}`)
			if(error?.stack) log.error(error.stack)
			throw error
		}
	}

	if(!ctx.snapshotState.completionTime){
		log.time.info(`snapshot.derivatives`, `creating derivative data ...`)
		markSyncOperation('snapshot.updateAllDerived')
		try{
			updateAllDerived({ ctx })
		}finally{
			endSyncOperation()
		}
		log.time.info(`snapshot.derivatives`, `created derivative data in %`)

		ctx.db.core.snapshots.updateOne({
			data: {
				completionTime: unixNow(),
				marker: null
			},
			where: {
				id: ctx.snapshotState.id
			}
		})

		log.info(`ledger snapshot complete`)
	}
}

async function createSnapshotState({ ctx }){
	let ledger = await fetchLedger({ 
		ctx, 
		sequence: 'validated'
	})

	applyLedgerEvents({ ctx, ledger })

	ctx.currentLedger = ledger
	ctx.snapshotState = ctx.db.core.snapshots.createOne({
		data: {
			ledgerSequence: ledger.sequence,
			creationTime: unixNow()
		}
	})
}

async function createFeed({ ctx, ledgerSequence, marker, node }){
	return await spawn(
		'../xrpl/snapshot.js:start', 
		{ 
			ctx, 
			ledgerSequence,
			marker,
			node
		}
	)
}

// Process each chunk in mini-batches of MINI_BATCH_SIZE objects, with a yield
// between batches. Each batch is its own SQLite transaction. Total work is the
// same; what changes is that the event loop gets a chance to service HTTP
// requests, WebSocket frames, and reconnect timers between batches — without
// this, a single 10000-object chunk blocks Node for 20+ seconds and the WS
// handshake to rippled times out internally (reported as code 1006).
const MINI_BATCH_SIZE = parseInt(process.env.XRPLMETA_SNAPSHOT_MINI_BATCH || '200', 10)

async function copyFromFeed({ ctx, feed }){
	let firstChunkSeen = false

	while(true){
		let chunk = await feed.next()

		if(!chunk)
			break

		if(!firstChunkSeen){
			firstChunkSeen = true
			log.info(`first snapshot chunk received (${chunk.objects.length} objects); ingesting in mini-batches of ${MINI_BATCH_SIZE}...`)
		}

		// Slice the chunk into mini-batches. Each batch is one tx.
		let total = chunk.objects.length
		let processedInChunk = 0

		for(let offset = 0; offset < total; offset += MINI_BATCH_SIZE){
			let batch = chunk.objects.slice(offset, offset + MINI_BATCH_SIZE)
			let isLastBatch = offset + batch.length >= total
			let batchStart = process.hrtime.bigint()

			markSyncOperation(`snapshot.batch(${batch.length} objects, offset ${offset}/${total})`)
			ctx.db.core.tx(() => {
				applyLedgerStateFromObjects({
					ctx,
					objects: batch
				})

				// Only update the marker on the LAST batch of the chunk. That way,
				// if we crash mid-chunk, snapshot resumes from the previous marker
				// and re-processes this chunk's objects from scratch. The state
				// writes are idempotent (upserts), so re-processing is safe.
				if(isLastBatch){
					ctx.snapshotState = ctx.db.core.snapshots.updateOne({
						data: {
							originNode: feed.node,
							marker: chunk.marker,
							entriesCount: ctx.snapshotState.entriesCount + total
						},
						where: { id: ctx.snapshotState.id }
					})
				}
			})

			endSyncOperation()
			processedInChunk += batch.length

			let batchMs = Number(process.hrtime.bigint() - batchStart) / 1e6
			if(batchMs > 1000)
				log.warn(`slow snapshot batch: ${batch.length} objects took ${batchMs.toFixed(0)}ms — blocked event loop`)

			// Yield between mini-batches. This is the critical change — the event
			// loop gets a chance every ~${MINI_BATCH_SIZE} objects instead of waiting
			// for the entire chunk (which can be 10000+ objects = 20+ seconds blocked).
			await new Promise(resolve => setImmediate(resolve))
		}

		log.accumulate.info({
			text: [
				`processed`,
				ctx.snapshotState.entriesCount,
				`ledger objects (+%objects in %time)`
			],
			data: {
				objects: total
			}
		})
	}

	log.flush()
	log.info(`reached end of ledger data`)
}