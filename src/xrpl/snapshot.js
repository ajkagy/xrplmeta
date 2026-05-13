import log from '../lib/log.js'
import { wait } from '../lib/time.js'

// rippled's ledger_data limit caps on non-admin (public) connections:
//   binary=false → 256, binary=true → 2048
// Admin / no_rate_limit / clio-admin connections have no enforced upper bound.
// Default behaviour: respect whatever the config sets, with a safe fallback.
// If you're on a public endpoint and set it too high, rippled returns
// "Invalid parameters" and we'll auto-halve the chunk size and retry.
const PUBLIC_LIMIT_JSON = 256
const DEFAULT_CHUNK = PUBLIC_LIMIT_JSON
const MIN_CHUNK_FLOOR = 64

export async function start({ ctx, ledgerSequence, marker, node }){
	if(ctx.log)
		log.pipe(ctx.log)

	let chunkSize = ctx.config.ledger.snapshotChunkSize || DEFAULT_CHUNK

	let queue = []

	let { result, node: assignedNode } = await ctx.xrpl.request({
		type: 'reserveTicket',
		task: 'snapshot',
		ledgerSequence,
		node
	})

	let ticket = result.ticket
	let fetching = true
	let resolveNext

	log.info(`reserved snapshot ticket with node`, assignedNode)

	let promise = (async() => {
		while(true){
			while(queue.length >= 10)
				await wait(100)

			try{
				let { result } = await ctx.xrpl.request({
					command: 'ledger_data',
					ledger_index: ledgerSequence,
					limit: chunkSize,
					binary: false,
					marker,
					ticket
				})

				queue.push({ 
					objects: result.state, 
					marker: result.marker 
				})

				marker = result.marker

				if(resolveNext)
					resolveNext()
					
			}catch(e){
				let detail = e?.error || e?.message || e
				let isInvalidParams = e?.error === 'invalidParams'
					|| /invalid\s*param/i.test(String(detail))

				if(isInvalidParams && chunkSize > MIN_CHUNK_FLOOR){
					let next = Math.max(MIN_CHUNK_FLOOR, Math.floor(chunkSize / 2))
					log.warn(`rippled rejected chunk size ${chunkSize} as invalidParams — halving to ${next} (likely a non-admin endpoint cap)`)
					chunkSize = next
					continue
				}

				log.warn(`could not fetch ledger chunk (limit=${chunkSize}, marker=${marker || 'start'}): ${detail}`)
				await wait(2500)
				continue
			}

			if(!marker){
				fetching = false
				break
			}
		}
	})()

	return {
		ledgerSequence,
		node: assignedNode,
		async next(){
			if(queue.length > 0)
				return queue.shift()

			if(!fetching)
				return

			await new Promise(resolve => resolveNext = resolve)

			return queue.shift()
		}
	}
}