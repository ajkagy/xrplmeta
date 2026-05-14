import { EventEmitter } from 'node:events'
import log from '../lib/log.js'
import { wait } from '../lib/time.js'
import { format as formatLedger } from './ledger.js'
import Node from './node.js'


export function createPool(sources){
	let events = new EventEmitter()
	let seenHashes = []
	let queue = []
	let nodes = []
	let latestLedger
	let closed = false
	
	async function workQueue(){
		while(!closed){
			for(let i=0; i<queue.length; i++){
				let request = queue[i]
				let [ bestBid ] = nodes
					.map(node => ({node, bid: node.bid(request.payload)}))
					.sort((a, b) => b.bid - a.bid)

				if(bestBid.bid <= 0)
					continue

				request.accepted()
			
				bestBid.node.do(request.payload)
					.then(result => request.resolve({result, node: bestBid.node.name}))
					.catch(error => request.reject({
						error: error.message || error.stack || error.error_message, 
						node: bestBid.node.name
					}))

				queue.splice(i--, 1)
			}

			await wait(100)
		}
	}

	function sawHash(hash){
		if(seenHashes.includes(hash))
			return true

		seenHashes.push(hash)

		if(seenHashes.length > 10000)
			seenHashes.shift()
	}

	function warnAllLost(){
		if(nodes.some(node => node.status.connected))
			return

		log.warn(`lost connection to all nodes`)
	}


	log.info(`using nodes:`)

	for(let spec of sources){
		let connections = spec.connections || 1

		for(let i=0; i<connections; i++){
			let node = new Node(spec)
			let firstConnect = true
			let connectionIndex = i + 1
			let connectionLabel = connections > 1 ? `${spec.url} (${connectionIndex}/${connections})` : spec.url

			node.on('connected', () => {
				if(firstConnect){
					log.info(`connected to ${connectionLabel}`)
				}else{
					let { reconnectAttempts } = node.status
					log.info(`reconnected to ${connectionLabel}${reconnectAttempts > 1 ? ` (after ${reconnectAttempts} attempts)` : ''}`)
				}
				firstConnect = false
			})

			node.on('disconnected', event => {
				let code = event?.code
				let level = code === 1000 ? 'info' : 'warn'
				let parts = [`code ${code ?? '?'}`]
				if(event?.reason) parts.push(`reason "${event.reason}"`)
				if(event?.lastErrorCode) parts.push(`err=${event.lastErrorCode}`)
				if(event?.lastErrorMessage && !event?.reason)
					parts.push(`errmsg="${event.lastErrorMessage}"`)
				log[level](`lost connection to ${connectionLabel}: ${parts.join(', ')}`)
				warnAllLost()
			})

			node.on('reconnecting', ({ attempt, delayMs, lastCode }) => {
				// Log first attempt at info; subsequent silent unless debug — avoids spam
				// during long outages with the 60s backoff. Final summary comes on connect.
				if(attempt === 1)
					log.info(`reconnecting to ${connectionLabel} in ${(delayMs/1000).toFixed(1)}s (last code: ${lastCode})`)
				else
					log.debug(`reconnect attempt #${attempt} to ${connectionLabel} in ${(delayMs/1000).toFixed(1)}s`)
			})

			node.on('error', () => {
				log.debug(`failed to connect to ${connectionLabel}: ${node.error}`)
			})

			node.on('event', ({ hash, tx, ledger }) => {
				if(sawHash(hash))
					return

				if(ledger){
					latestLedger = { ...ledger, transactions: [] }
				}

				if(latestLedger){
					if(tx){
						latestLedger.transactions.push(tx)
					}

					if(latestLedger.transactions.length === latestLedger.txn_count){
						events.emit('ledger', formatLedger(latestLedger))
					}
				}
			})

			nodes.push(node)
		}

		log.info(` -> ${spec.url}`)
	}

	workQueue()

	return Object.assign(
		events,
		{
			request(payload){
				return new Promise((resolve, reject) => {
					let timeout = setTimeout(() => {
						let snapshot = nodes.map(node => {
							let status = node.status
							return {
								node: node.name,
								state: status?.readyState,
								connected: status?.connected,
								reconnectAttempts: status?.reconnectAttempts,
								lastDisconnect: status?.lastDisconnectReason?.code,
								available: node.availableLedgers?.length || 0,
								busy: !!node.busy,
								bid: node.bid(payload)
							}
						})

						// Helpful summary message — let users diagnose the most-likely cause at a glance.
						let allConnecting = snapshot.every(s => s.state === 'CONNECTING')
						let allClosed = snapshot.every(s => s.state === 'CLOSED' || s.state === 'UNKNOWN')
						let cause = allConnecting
							? 'all sockets stuck in handshake — rippled may be accepting TCP but not completing the WebSocket upgrade'
							: allClosed
								? 'all sockets closed — check rippled is reachable and process logs at this timestamp'
								: 'mixed states — see per-node details below'

						log.warn(
							`noNodeAcceptedRequest after 30s for ${payload.command || payload.type}: ${cause}`
						)
						log.warn(`  node states: ${JSON.stringify(snapshot)}`)
						reject('noNodeAcceptedRequest')
					}, 30000)
					let accepted = () => clearTimeout(timeout)

					queue.push({
						payload,
						resolve,
						reject,
						accepted
					})
				})
			},
			close(){
				closed = true
				
				for(let node of nodes){
					node.disconnect()
				}
			},
			get connectionsCount(){
				return nodes.length
			}
		}
	)
}