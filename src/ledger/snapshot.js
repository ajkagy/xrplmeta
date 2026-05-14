import log from '../lib/log.js'
import { unixNow } from '../lib/time.js'
import { spawn } from '../lib/workers.js'
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
		updateAllDerived({ ctx })
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

async function copyFromFeed({ ctx, feed }){
	let firstChunkSeen = false

	while(true){
		let chunk = await feed.next()

		if(!chunk)
			break

		if(!firstChunkSeen){
			firstChunkSeen = true
			log.info(`first snapshot chunk received (${chunk.objects.length} objects); ingesting...`)
		}

		ctx.db.core.tx(() => {
			applyLedgerStateFromObjects({
				ctx,
				objects: chunk.objects
			})

			ctx.snapshotState = ctx.db.core.snapshots.updateOne({
				data: {
					originNode: feed.node,
					marker: chunk.marker,
					entriesCount: ctx.snapshotState.entriesCount + chunk.objects.length
				},
				where: {
					id: ctx.snapshotState.id
				}
			})
		})

		log.accumulate.info({
			text: [
				`processed`,
				ctx.snapshotState.entriesCount,
				`ledger objects (+%objects in %time)`
			],
			data: {
				objects: chunk.objects.length
			}
		})
	}

	log.flush()
	log.info(`reached end of ledger data`)
}