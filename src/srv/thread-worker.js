// Real worker_threads entry point for HTTP/WS query procedures.
//
// Each worker opens its OWN read-only DB connections (better-sqlite3 is
// synchronous, so running queries here keeps the heavy SQL off the main event
// loop — the parallelism the in-process "workers" never actually provided).
//
// Protocol with the parent (see worker.js):
//   parent -> worker : { id, procedure, params }
//   worker -> parent : { id, ok: true,  result }          (success; result is plain data)
//                      { id, ok: false, error }           (failure; error preserves .expose)
//   worker -> parent : { ready: true } | { ready: false, error }   (startup handshake)

import { parentPort, workerData } from 'node:worker_threads'
import { openDB } from '../db/index.js'
import * as procedures from './api.js'


let ctx


parentPort.on('message', async msg => {
	let { id, procedure, params } = msg

	try{
		let func = procedures[procedure]

		if(typeof func !== 'function')
			throw new Error(`unknown procedure "${procedure}"`)

		let result = await func({ ...params, ctx })

		parentPort.postMessage({ id, ok: true, result })
	}catch(error){
		parentPort.postMessage({
			id,
			ok: false,
			// Preserve exposed (400) validation errors so the HTTP layer can still
			// surface them to the client; everything else is an opaque 500.
			error: error && error.expose
				? { type: error.type, message: error.message, expose: true }
				: { message: error?.message || String(error) }
		})
	}
})


async function init(){
	ctx = {
		config: workerData.config,
		db: await openDB({
			ctx: { config: workerData.config },
			coreReadOnly: true,
			cacheReadOnly: true
		})
	}

	parentPort.postMessage({ ready: true })
}


init().catch(error => {
	parentPort.postMessage({ ready: false, error: error?.message || String(error) })
})
