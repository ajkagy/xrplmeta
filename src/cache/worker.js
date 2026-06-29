import log from '../lib/log.js'
import { wait } from '../lib/time.js'
import { markSyncOperation, endSyncOperation } from '../lib/health.js'
import {
	updateCacheForAccountProps,
	updateCacheForTokenExchanges,
	updateCacheForTokenMetrics,
	updateCacheForTokenProps
} from './tokens.js'
import { updateIconCacheFor } from './icons.js'
import { updateCacheForNFTCollection } from './nfts.js'


// Throttling — better-sqlite3 is synchronous, so each cache update blocks the
// Node event loop while running its SQL. Without yielding, the cache worker
// monopolises CPU and HTTP requests time out at the upstream gateway.
//
// Environment overrides:
//   XRPLMETA_CACHE_YIELD_MS         — sleep between every todo (default 25)
//   XRPLMETA_CACHE_LOAD_AWARE       — if "0", disable HTTP-load-aware throttle
//   XRPLMETA_CACHE_COUNT_EVERY      — re-query remaining count every N todos (default 100)
const YIELD_MS = parseInt(process.env.XRPLMETA_CACHE_YIELD_MS || '25', 10)
const LOAD_AWARE = process.env.XRPLMETA_CACHE_LOAD_AWARE !== '0'
const COUNT_EVERY = parseInt(process.env.XRPLMETA_CACHE_COUNT_EVERY || '100', 10)


// Shared HTTP-load counter. The server-side request handler increments this on
// request entry and decrements on completion. Cache workers (and any other
// background task that does heavy synchronous SQL) back off when it's nonzero
// so user-facing requests aren't starved.
const httpLoad = { pending: 0 }
export function noteHttpRequestStart(){ httpLoad.pending++ }
export function noteHttpRequestEnd(){ if(httpLoad.pending > 0) httpLoad.pending-- }
export function httpLoadPending(){ return httpLoad.pending }


async function yieldToLoop(){
	// setImmediate lets Node service queued I/O (incoming HTTP, WS messages,
	// reconnect timers, etc.) before we grab the event loop again for the next
	// SQL-heavy todo.
	return new Promise(resolve => setImmediate(resolve))
}

async function throttleStep(){
	// If HTTP requests are in flight, give them more breathing room.
	if(LOAD_AWARE && httpLoad.pending > 0){
		// 25ms × pending requests, capped at 500ms — sliding scale.
		let extraDelay = Math.min(500, 25 * httpLoad.pending)
		await wait(extraDelay)
	}else if(YIELD_MS > 0){
		await wait(YIELD_MS)
	}else{
		await yieldToLoop()
	}
}


export async function startMetaCacheWorker({ ctx }){
	let running = true

	;(async () => {
		let remainingCount = 0
		let countStaleFor = 0
		let nonIconWhere = {
			NOT: { task: { in: ['account.icons', 'token.icons'] } }
		}

		while(running){
			let todo = ctx.db.cache.todos.readOne({ where: nonIconWhere })

			if(!todo){
				await wait(500)
				countStaleFor = COUNT_EVERY  // refresh count next time we have work
				continue
			}

			let blockStart = process.hrtime.bigint()
			markSyncOperation(`cache.${todo.task}#${todo.subject}`)
			try{
				switch(todo.task){
					case 'account.props':
						updateCacheForAccountProps({ ctx, account: { id: todo.subject } })
						break
					case 'token.props':
						updateCacheForTokenProps({ ctx, token: { id: todo.subject } })
						break
					case 'token.exchanges':
						updateCacheForTokenExchanges({ ctx, token: { id: todo.subject } })
						break
					case 'token.metrics.trustlines':
						updateCacheForTokenMetrics({ ctx, token: { id: todo.subject }, metrics: { trustlines: true } })
						break
					case 'token.metrics.holders':
						updateCacheForTokenMetrics({ ctx, token: { id: todo.subject }, metrics: { holders: true } })
						break
					case 'token.metrics.supply':
						updateCacheForTokenMetrics({ ctx, token: { id: todo.subject }, metrics: { supply: true } })
						break
					case 'token.metrics.marketcap':
						updateCacheForTokenMetrics({ ctx, token: { id: todo.subject }, metrics: { marketcap: true } })
						break
					case 'nftCollection.metrics':
						updateCacheForNFTCollection({ ctx, collection: { id: todo.subject } })
						break
				}
			}catch(error){
				log.warn(`cache update for token ${todo.subject} failed: ${error?.message || error}`)
			}finally{
				endSyncOperation()
			}

			let elapsedMs = Number(process.hrtime.bigint() - blockStart) / 1e6
			if(elapsedMs > 500)
				log.warn(`slow cache task: ${todo.task} for subject ${todo.subject} took ${elapsedMs.toFixed(0)}ms (THIS BLOCKED THE EVENT LOOP)`)

			ctx.db.cache.todos.deleteOne({ where: { id: todo.id } })

			// Refresh remaining-count rarely — it's a full table scan over the todos
			// queue (potentially hundreds of thousands of rows) and we only need it
			// for the log line.
			countStaleFor++
			if(countStaleFor >= COUNT_EVERY){
				remainingCount = ctx.db.cache.todos.count({ where: nonIconWhere })
				countStaleFor = 0
			}else if(remainingCount > 0){
				remainingCount--
			}

			log.accumulate.info({
				text: [`processed %cacheTasksProcessed cache updates in %time (~${remainingCount} remaining)`],
				data: { cacheTasksProcessed: 1 }
			})

			// Yield to the event loop so HTTP requests / WS / reconnects get a slice.
			await throttleStep()
		}
	})()

	return { stop(){ running = false } }
}


export async function startIconCacheWorker({ ctx }){
	let running = true

	;(async () => {
		let remainingCount = 0
		let countStaleFor = 0
		let iconWhere = { task: { in: ['account.icons', 'token.icons'] } }

		while(running){
			let todo = ctx.db.cache.todos.readOne({ where: iconWhere })

			if(!todo){
				await wait(2000)
				countStaleFor = COUNT_EVERY
				continue
			}

			try{
				switch(todo.task){
					case 'account.icons':
						await updateIconCacheFor({ ctx, account: { id: todo.subject } })
						break
					case 'token.icons':
						await updateIconCacheFor({ ctx, token: { id: todo.subject } })
						break
				}
			}catch(error){
				log.warn(`icon cache update for ${todo.task}/${todo.subject} failed: ${error?.message || error}`)
			}

			ctx.db.cache.todos.deleteOne({ where: { id: todo.id } })

			countStaleFor++
			if(countStaleFor >= COUNT_EVERY){
				remainingCount = ctx.db.cache.todos.count({ where: iconWhere })
				countStaleFor = 0
			}else if(remainingCount > 0){
				remainingCount--
			}

			log.accumulate.info({
				text: [`processed %iconCacheTasksProcessed icon cache updates in %time (~${remainingCount} remaining)`],
				data: { iconCacheTasksProcessed: 1 }
			})

			await throttleStep()
		}
	})()

	return { stop(){ running = false } }
}
