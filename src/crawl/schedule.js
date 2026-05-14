import log from '../lib/log.js'
import { unixNow, wait } from '../lib/time.js'
import { withSyncOp } from '../lib/health.js'


// Yield to the event loop without adding arbitrary delay. setTimeout(0) is
// clamped to 1ms in Node, which would add ~74s of pure waiting across a
// 74k-item crawl. setImmediate runs after pending I/O in the current poll
// phase, so HTTP / WebSocket / timer callbacks can interleave between
// iterations at microsecond cost.
function yieldLoop(){
	return new Promise(resolve => setImmediate(resolve))
}


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
	let { table, ids } = withSyncOp(
		`scheduleIterator.${task}.collectItemIds`,
		() => collectItemIds({ ctx, type, where })
	)

	log.debug(`${task}:`, ids.length, `items[${table}] to iterate`)

	await Promise.all(
		Array(concurrency)
			.fill(0)
			.map(async () => {
				while(ids.length > 0){
					let id = ids.shift()

					let { item, previousOperation } = withSyncOp(
						`scheduleIterator.${task}.lookup`,
						() => {
							let item = ctx.db.core[table].readOne({
								where: { id },
								include
							})
							let previousOperation = item
								? ctx.db.core.operations.readOne({
									where: {
										subjectType: type,
										subjectId: item.id,
										task,
										time: {
											greaterThan: unixNow() - interval
										}
									}
								})
								: null
							return { item, previousOperation }
						}
					)

					if(previousOperation || !item){
						// Critical: yield on the skip path. Without this, we tight-loop
						// through items whose ops are still fresh, doing two sync DB
						// reads per item with no chance for HTTP / WebSocket / timer
						// callbacks to fire. With 74k+ items this becomes a 21+ second
						// solid block of the event loop — the exact stall pattern we
						// were chasing under "no sync op currently marked".
						await yieldLoop()
						continue
					}

					try{
						await routine(item, ids.length)
						noteTaskRecovered(task)
					}catch(error){
						logTaskFailure(task, error)
						await wait(3000)
					}

					withSyncOp(
						`scheduleIterator.${task}.markDone`,
						() => ctx.db.core.operations.createOne({
							data: {
								subjectType: type,
								subjectId: item.id,
								task,
								time: unixNow()
							}
						})
					)
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

	let { table, ids } = withSyncOp(
		`scheduleBatchedIterator.${task}.collectItemIds`,
		() => collectItemIds({ ctx, type, where })
	)
	let now = unixNow()

	log.debug(`${task}:`, ids.length, `items[${table}] to iterate`)

	for(let id of ids){
		let { item, previousOperation } = withSyncOp(
			`scheduleBatchedIterator.${task}.lookup`,
			() => {
				let item = ctx.db.core[table].readOne({
					where: { id },
					include
				})
				let previousOperation = item
					? ctx.db.core.operations.readOne({
						where: {
							subjectType: type,
							subjectId: item.id,
							task,
							time: {
								greaterThan: now - interval
							}
						}
					})
					: null
				return { item, previousOperation }
			}
		)

		// setImmediate-based yield. Was `await wait(1)` which adds 1ms × N items
		// of pure latency (74s for a 74k-item crawl). setImmediate yields the
		// loop in microseconds while still letting I/O callbacks interleave.
		await yieldLoop()

		if(previousOperation || !item)
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