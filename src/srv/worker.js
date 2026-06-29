import { Worker } from 'node:worker_threads'
import log from '../lib/log.js'
import * as procedures from './api.js'


const WORKER_URL = new URL('./thread-worker.js', import.meta.url)


// Spawn the HTTP/WS query worker pool as real worker_threads. Each worker opens
// its own read-only DB connections, so synchronous better-sqlite3 query work runs
// off the main event loop (true parallelism). Resolves once every worker has
// finished opening its DB (the "ready" handshake). A crashed/exited worker is
// excluded from dispatch and a replacement is respawned into its slot so a single
// crash can't poison the pool.
export async function spawnWorkers({ ctx }){
	let num = ctx.config.server.workers || 3

	// workerData is structured-cloned; round-trip through JSON to guarantee the
	// config carries no non-cloneable values.
	let config = JSON.parse(JSON.stringify(ctx.config))
	let pool = []

	let onDead = deadManager => {
		let slot = pool.indexOf(deadManager)
		if(slot === -1)
			return

		log.info(`respawning crashed server worker (slot ${slot + 1})`)
		createWorker({ config, index: slot + 1, onDead })
			.then(replacement => { pool[slot] = replacement })
			.catch(error => log.warn(`failed to respawn server worker: ${error?.message || error}`))
	}

	log.info(`spawning ${num} worker thread(s)`)

	for(let i = 0; i < num; i++)
		pool.push(await createWorker({ config, index: i + 1, onDead }))

	return pool
}


function createWorker({ config, index, onDead }){
	return new Promise((resolveReady, rejectReady) => {
		let worker = new Worker(WORKER_URL, { workerData: { config } })
		let pending = new Map()
		let nextId = 1
		let ready = false
		let dead = false

		let manager = {
			busy: false,
			lastRequestTime: 0,

			get dead(){
				return dead
			},

			execute({ procedure, params }){
				if(dead)
					return Promise.reject({ message: `server worker is no longer alive` })

				return new Promise((resolve, reject) => {
					let id = nextId++
					pending.set(id, { resolve, reject })
					worker.postMessage({ id, procedure, params })
				})
			},

			terminate(){
				dead = true
				return worker.terminate()
			}
		}

		let die = reason => {
			if(dead)
				return

			dead = true

			for(let { reject } of pending.values())
				reject(reason)
			pending.clear()

			if(onDead)
				onDead(manager)
		}

		worker.on('message', msg => {
			if(msg.ready !== undefined){
				if(msg.ready){
					ready = true
					resolveReady(manager)
				}else{
					dead = true
					rejectReady(new Error(`server worker #${index} failed to start: ${msg.error}`))
				}
				return
			}

			let entry = pending.get(msg.id)
			if(!entry)
				return

			pending.delete(msg.id)

			if(msg.ok)
				entry.resolve(msg.result)
			else
				entry.reject(msg.error)
		})

		worker.on('error', error => {
			log.warn(`server worker #${index} error: ${error?.message || error}`)
			if(!ready)
				rejectReady(error)
			die({ message: `worker crashed: ${error?.message || error}` })
		})

		worker.on('exit', code => {
			if(code !== 0)
				log.warn(`server worker #${index} exited with code ${code}`)
			die({ message: `worker exited (code ${code})` })
		})
	})
}


export async function executeProcedure({ ctx, procedure, params, requestId }){
	let func = procedures[procedure]

	// Procedures that need per-connection state (ctx.client subscription map) run
	// on the main thread; everything else is dispatched to a worker.
	if(func.mustRunMainThread){
		return json(await func({ ...params, ctx }), requestId)
	}

	let now = Date.now()
	let live = ctx.workers.filter(worker => !worker.dead)

	if(live.length === 0)
		throw new Error(`no live server workers available`)

	let ranking = live
		.map(worker => ({ worker, score: now - (worker.lastRequestTime || 0) - (!!worker.busy) * 1000000000 }))
		.sort((a, b) => b.score - a.score)

	log.debug(`available for handling ${procedure}`, ranking.map(({ worker, score }) => ({ busy: worker.busy, score })))

	let worker = ranking.at(0).worker

	worker.busy = true
	worker.lastRequestTime = now

	try{
		let result = await worker.execute({ procedure, params })
		return json(result, requestId)
	}finally{
		worker.busy = false
	}
}


function json(data, requestId){
	if(requestId)
		data = { result: data, id: requestId }

	return JSON.stringify(data, null, 2)
}
