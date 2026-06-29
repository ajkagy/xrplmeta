import { expect } from 'chai'
import os from 'os'
import fs from 'fs'
import path from 'path'
import log from '../../src/lib/log.js'
import { openDB } from '../../src/db/index.js'
import { spawnWorkers, executeProcedure } from '../../src/srv/worker.js'


log.config({ level: 'error' })


// Real worker_threads need a shared on-disk DB (each thread opens its own
// read-only connection), so this uses a file-based data dir rather than :memory:.
describe('HTTP worker_threads pool', function(){
	this.timeout(20000)

	let dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrplmeta-wt-'))
	let ctx
	let workers = []

	before(async () => {
		let baseCtx = { config: { node: { dataDir }, server: { workers: 2 } } }

		// Construct the DB files (read-write) and seed the implicit XRP token row.
		let db = await openDB({ ctx: baseCtx })
		ctx = { ...baseCtx, db }

		// server_info / list procedures need at least one ledger for the available range.
		db.core.ledgers.createOne({
			data: { sequence: 100, hash: 'AB'.repeat(32), closeTime: 1000000000, txCount: 0 }
		})

		workers = await spawnWorkers({ ctx })
		ctx.workers = workers
	})

	after(async () => {
		for(let worker of workers)
			await worker.terminate()
	})

	it('spawns the configured number of workers', () => {
		expect(workers.length).to.equal(2)
	})

	it('executes a read procedure inside a worker thread and returns JSON', async () => {
		let body = await executeProcedure({ ctx, procedure: 'server_info', params: {} })
		let parsed = JSON.parse(body)

		expect(parsed).to.have.property('total_tokens')
		expect(parsed.total_tokens).to.be.a('number')
	})

	it('handles concurrent requests across the pool without mixing up responses', async () => {
		let bodies = await Promise.all([
			executeProcedure({ ctx, procedure: 'server_info', params: {} }),
			executeProcedure({ ctx, procedure: 'tokens', params: { limit: 10 } }),
			executeProcedure({ ctx, procedure: 'server_info', params: {} })
		])

		expect(JSON.parse(bodies[0])).to.have.property('total_tokens')
		expect(() => JSON.parse(bodies[1])).to.not.throw()
		expect(JSON.parse(bodies[2])).to.have.property('total_tokens')
	})

	it('excludes a terminated worker from dispatch and still serves from the rest', async () => {
		await workers[0].terminate()
		expect(workers[0].dead).to.equal(true)

		// Should route to a live worker rather than hang on the dead one.
		let body = await executeProcedure({ ctx, procedure: 'server_info', params: {} })
		expect(JSON.parse(body)).to.have.property('total_tokens')
	})
})
