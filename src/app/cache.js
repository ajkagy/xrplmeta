import log from '../lib/log.js'
import { spawn } from '../lib/workers.js'
import { openDB } from '../db/index.js'
import { startMetaCacheWorker, startIconCacheWorker } from '../cache/worker.js'


export async function run({ ctx }){
	log.info('starting cache worker')

	await spawn(':runMetaCacheWorker', { ctx })
	await spawn(':runIconCacheWorker', { ctx })
}

export async function runMetaCacheWorker({ ctx }){
	if(ctx.log)
		log.pipe(ctx.log)

	return await startMetaCacheWorker({
		ctx: {
			...ctx,
			db: await openDB({
				ctx,
				coreReadOnly: true
			})
		}
	})
}

export async function runIconCacheWorker({ ctx }){
	if(ctx.log)
		log.pipe(ctx.log)

	return await startIconCacheWorker({
		ctx: {
			...ctx,
			db: await openDB({
				ctx,
				coreReadOnly: true
			})
		}
	})
}