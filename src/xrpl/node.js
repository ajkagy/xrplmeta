import EventEmitter from 'events'
import createSocket from './socket.js'
import log from '../lib/log.js'


export default class Node extends EventEmitter{
	constructor(config){
		super()

		this.name = config.url
			.replace(/^wss?:\/\//, '')
			.replace(/:[0-9]+/, '')

		this.tasks = []
		this.socket = createSocket({ url: config.url })
		this.availableLedgers = []

		this.socket.on('transaction', tx => {
			this.emit('event', {hash: tx.transaction.hash, tx})
		})

		this.socket.on('ledgerClosed', ledger => {
			this.emit('event', {hash: ledger.ledger_hash, ledger})
			this.hasReportedClosedLedger = true
			this.updateAvailableLedgers(ledger.validated_ledgers)
		})

		this.socket.on('open', async () => {
			this.hasReportedClosedLedger = false
			this.availableLedgers = []
			this.emit('connected')

			try{
				// The subscribe response also includes validated_ledgers — use it to
				// mark the node ready immediately, without waiting for the first
				// ledgerClosed push (which may take 3-5s and never arrives if the
				// connection drops quickly).
				let result = await this.socket.request({
					command: 'subscribe',
					streams: ['ledger', 'transactions']
				})
				if(result?.validated_ledgers){
					this.updateAvailableLedgers(result.validated_ledgers)
					this.hasReportedClosedLedger = true
				}else{
					// No validated_ledgers in subscribe response — still mark ready so
					// requests can flow. The availableLedgers range check will simply
					// fall through to "bid 1" for unknown-range queries.
					this.hasReportedClosedLedger = true
				}
			}catch(error){
				log.warn(`failed to subscribe to node "${this.name}": ${error?.message || error}`)
			}
		})

		this.socket.on('close', async event => {
			this.error = event.reason
				? event.reason
				: `code ${event.code}`

			this.emit('disconnected', event)
		})

		this.socket.on('reconnecting', info => {
			this.emit('reconnecting', info)
		})

		this.socket.on('error', error => {
			this.error = error.message
				? error.message
				: `unknown connection failure`

			this.emit('error')
		})
	}

	get status(){
		return this.socket.status()
	}

	updateAvailableLedgers(validatedLedgers){
		if(!validatedLedgers || typeof validatedLedgers !== 'string') return
		this.availableLedgers = validatedLedgers
			.split(',')
			.map(range => range.split('-').map(i => parseInt(i, 10)))
			.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end))
	}

	bid(payload){
		if(this.busy || !this.status.connected)
			return 0

		// We used to also gate on hasReportedClosedLedger here, requiring a full
		// ledgerClosed event before bidding. That was too strict — if connections
		// flap on a fast cycle, the node never sees a close and never bids, and
		// the pool rejects every request with noNodeAcceptedRequest after 30s.
		// Now we accept bids as soon as the connection is open and subscribed;
		// the per-payload availableLedgers check below handles "do you have this
		// specific historical ledger" separately.

		if(payload.command){
			if(payload.ticket){
				if(this.tasks.some(task => task.ticket === payload.ticket))
					return Infinity
				else
					return 0
			}

			// Numeric ledger_index — check if we know this node has it.
			if(typeof payload.ledger_index === 'number' && this.availableLedgers.length > 0){
				let hasLedger = this.availableLedgers.some(
					([start, end]) => payload.ledger_index >= start && payload.ledger_index <= end
				)
				return hasLedger ? 2 : 0
			}

			// Relative ledger_index (validated/current/closed) — always accept
			if(payload.ledger_index === 'validated' || payload.ledger_index === 'current' || payload.ledger_index === 'closed')
				return 2

			// Numeric ledger_index but no availableLedgers data yet — bid low but bid
			if(typeof payload.ledger_index === 'number')
				return 1

			return 1
		}else if(payload.type === 'reserveTicket'){
			if(payload.node){
				if(payload.node !== this.name)
					return 0
			}

			return 1
		}
	}

	async do(payload){
		this.busy = true

		try{
			if(payload.command){
				// Strip pool-internal routing fields before forwarding to rippled —
				// `ticket` (and any other non-XRPL keys) cause "Invalid parameters" errors
				// from strictly-validating rippled/clio nodes.
				let { ticket, ...xrplPayload } = payload
				return await this.socket.request(xrplPayload)
			}else if(payload.type === 'reserveTicket'){
				let ticket = Math.random()
					.toString(16)
					.toUpperCase()
					.slice(2, 10)
	
				this.tasks.push({
					type: payload.task,
					ticket,
					node: this.name
				})
	
				return {ticket}
			}
		}catch(error){
			throw error
		}finally{
			this.busy = false
		}
	}

	disconnect(){
		this.socket.close()
	}
}