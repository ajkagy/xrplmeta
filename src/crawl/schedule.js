import log from '../lib/log.js'
import { unixNow, wait } from '../lib/time.js'


// Per-task failure-burst suppression. If a task keeps failing in similar ways
// (same error message), log the first one fully and then just a single
// "still failing (N attempts)" line every minute until it recovers.
let failureState = new Map()  // task -> { lastError, count, lastLogAt, sinceTs }

function logTaskFailure(task, error){
	let msg = formatError(error)
	let now = Date.now()
	let state = failureState.get(task)

	if(!state || state.lastError !== msg){
		failureState.set(task, { lastError: msg, count: 1, lastLogAt: now, sinceTs: now })
		log.warn(`scheduled task "${task}" failed: ${msg}`)
		return
	}

	state.count++
	if(now - state.lastLogAt > 60_000){
		log.warn(`scheduled task "${task}" still failing (${state.count} attempts in ${Math.floor((now - state.sinceTs) / 1000)}s): ${msg}`)
		state.lastLogAt = now
	}
}

function noteTaskRecovered(task){
	let state = failureState.get(task)
	if(state){
		log.info(`scheduled task "${task}" recovered after ${state.count} failure(s)`)
		failureState.delete(task)
	}
}

function formatError(error){
	if(!error) return 'unknown error'
	if(typeof error === 'string') return error
	if(error instanceof Error){
		// AbortError + TypeError("fetch failed") — strip giant stacks, keep the name + message.
		let name = error.name || 'Error'
		let msg = error.message || ''
		// undici's "fetch failed" frequently has a useful cause attached.
		let cause = error.cause?.code || error.cause?.message
		return cause ? `${name}: ${msg} (${cause})` : `${name}: ${msg}`
	}
	try{ return JSON.stringify(error) }catch{ return String(error) }
}


export async function scheduleGlobal({ ctx, task, interval, routine }){
	let duration = 0
	let previousOperation = ctx.db.core.operations.readOne({
		where: {
			subjectType: 'global',
			subjectId: 0,
			task
		}
	})

	if(previousOperation)
		duration = interval - unixNow() + previousOperation.time

	if(duration > 0)
		log.debug(`${task}:`, `waiting ${duration} seconds for next operation`)

	await wait(duration * 1000 + 1)

	try{
		await routine()
		noteTaskRecovered(task)

		ctx.db.core.operations.createOne({
			data: {
				subjectType: 'global',
				subjectId: 0,
				task,
				time: unixNow()
			}
		})
	}catch(error){
		logTaskFailure(task, error)
		await wait(4000)
	}
}

export async function scheduleIterator({ ctx, type, where, include, task, interval, concurrency = 1, routine }){
	let { table, ids } = collectItemIds({ ctx, type, where })

	log.debug(`${task}:`, ids.length, `items[${table}] to iterate`)

	await Promise.all(
		Array(concurrency)
			.fill(0)
			.map(async () => {
				while(ids.length > 0){
					let id = ids.shift()
					let item = ctx.db.core[table].readOne({
						where: {
							id
						},
						include
					})

					let previousOperation = ctx.db.core.operations.readOne({
						where: {
							subjectType: type,
							subjectId: item.id,
							task,
							time: {
								greaterThan: unixNow() - interval
							}
						}
					})

					if(previousOperation)
						continue

					try{
						await routine(item, ids.length)
						noteTaskRecovered(task)
					}catch(error){
						logTaskFailure(task, error)
						await wait(3000)
					}

					ctx.db.core.operations.createOne({
						data: {
							subjectType: type,
							subjectId: item.id,
							task,
							time: unixNow()
						}
					})
				}
			})
	)

	await wait(1)
}


export async function scheduleBatchedIterator({ ctx, type, where, include, task, interval, batchSize, accumulate, commit }){
	let queue = []
	let flush = async () => {
		let batch = queue.splice(0, batchSize)

		try{
			await commit(batch)
			noteTaskRecovered(task)
		}catch(error){
			logTaskFailure(task, error)
		}

		let time = unixNow()

		for(let { items } of batch){
			for(let item of items){
				ctx.db.core.operations.createOne({
					data: {
						subjectType: type,
						subjectId: item.id,
						task,
						time
					}
				})
			}
		}
	}

	let { table, ids } = collectItemIds({ ctx, type, where })
	let now = unixNow()

	log.debug(`${task}:`, ids.length, `items[${table}] to iterate`)

	for(let id of ids){
		let item = ctx.db.core[table].readOne({ 
			where: { id },
			include
		})

		let previousOperation = ctx.db.core.operations.readOne({
			where: {
				subjectType: type,
				subjectId: item.id,
				task,
				time: {
					greaterThan: now - interval
				}
			}
		})

		await wait(1)

		if(previousOperation)
			continue

		queue = accumulate(queue, item)

		if(queue.length >= batchSize)
			await flush()
	}

	if(queue.length > 0)
		await flush()

	await wait(1)
}

function collectItemIds({ ctx, type, where }){
	if(type === 'issuer'){
		return {
			table: 'accounts',
			ids: ctx.db.core.tokens.readMany({ 
				select: { issuer: true }, 
				distinct: ['issuer'],
				where
			})
				.map(row => row.issuer?.id)
				.filter(Boolean)
				.reverse()
		}
	}else{
		return {
			table: 'tokens',
			ids: ctx.db.core.tokens.readMany({
				select: { id: true },
				where
			})
				.map(row => row.id)
				.reverse()
		}
	}
}