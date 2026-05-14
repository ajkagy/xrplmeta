import log from '../lib/log.js'
import { wait } from '../lib/time.js'
import { fetch as fetchLedger } from './ledger.js'



export async function createForwardStream({ ctx, startSequence }){
	if(ctx.log)
		log.pipe(ctx.log)

	let latestLedger

	while(!latestLedger){
		try{
			latestLedger = await fetchLedger({ 
				ctx,
				sequence: 'validated' 
			})
		}catch(error){
			log.warn(`cannot start forward stream, unable get latest ledger: \n${error}`)
			await wait(1000)
		}
	}

	let stream = createRegistry({
		name: 'live',
		startSequence,
		targetSequence: latestLedger.sequence,
		maxSize: ctx.config.ledger.streamQueueSize || 100
	})

	ctx.xrpl.on('ledger', ledger => {
		stream.extend(ledger)
	})

	createFiller({ ctx, stream, stride: 1 })
	
	return stream
}

export async function createBackwardStream({ ctx, startSequence }){
	if(ctx.log)
		log.pipe(ctx.log)

	let stream = createRegistry({
		name: 'backfill',
		startSequence,
		targetSequence: ctx.config.ledger.backfillToLedger || 0,
		maxSize: ctx.config.ledger.streamQueueSize || 100
	})

	createFiller({ ctx, stream, stride: -1 })
	
	return stream
}


function createRegistry({ name, startSequence, targetSequence, maxSize }){
	let currentSequence = startSequence
	let ledgers = {}
	let resolveNext = () => 0

	return {
		get currentSequence(){
			return currentSequence
		},

		get targetSequence(){
			return targetSequence
		},

		get queueSize(){
			return Object.keys(ledgers).length
		},

		has(sequence){
			return !!ledgers[sequence]
		},

		accepts(sequence){
			return Math.abs(sequence - currentSequence) <= maxSize
		},

		extend(ledger){
			targetSequence = Math.max(targetSequence, ledger.sequence)

			if(this.accepts(ledger.sequence))
				this.put(ledger)
		},

		put(ledger){
			ledgers[ledger.sequence] = ledger
			resolveNext()

			if(this.queueSize > 1){
				log.accumulate.debug({
					text: [
						`${name} queue has`,
						this.queueSize,
						`ledgers`,
						`(+%${name}QueueAdd in %time)`
					],
					data: {
						[`${name}QueueAdd`]: 1
					}
				})
			}
		},

		status(){
			return {
				currentSequence,
				targetSequence
			}
		},

		async next(){
			while(!ledgers[currentSequence]){
				await new Promise(resolve => resolveNext = resolve)
			}

			let ledger = ledgers[currentSequence]

			delete ledgers[currentSequence]

			currentSequence += targetSequence >= currentSequence ? 1 : -1

			return {
				ledger,
				ledgersBehind: targetSequence - currentSequence
			}
		}
	}
}

function createFiller({ ctx, stream, stride }){
	let reservations = {}

	// Rate-limit fetch-failure logging during a sustained outage. When all nodes
	// are disconnected, each filler worker would otherwise log a "failed to fetch"
	// line per ledger attempt — 5 workers × ledgers/sec = spam. Track outage state
	// and emit one rolled-up warning every 30 seconds instead.
	let lastOutageWarnAt = 0
	let outageFailureCount = 0
	let inOutage = false
	const OUTAGE_WARN_INTERVAL_MS = 30_000

	function logFetchFailure(sequence, error){
		let detail = error?.error || error?.message || error
		let isNoNode = /noNodeAcceptedRequest|socket not connected|all nodes/i.test(String(detail))

		if(isNoNode){
			outageFailureCount++
			let now = Date.now()
			if(!inOutage){
				inOutage = true
				lastOutageWarnAt = now
				log.warn(`ledger fetch stalled — no nodes available (first failure on #${sequence})`)
			}else if(now - lastOutageWarnAt > OUTAGE_WARN_INTERVAL_MS){
				lastOutageWarnAt = now
				log.warn(`ledger fetch still stalled — ${outageFailureCount} failures since outage started, waiting for nodes to reconnect`)
			}
			return
		}

		// A real fetch error from a connected node — recover from outage state and log it
		if(inOutage){
			inOutage = false
			log.info(`ledger fetch resumed (after ${outageFailureCount} failures during outage)`)
			outageFailureCount = 0
		}
		log.warn(`failed to fetch ledger #${sequence}: ${detail}`)
	}

	for(let n=0; n<ctx.xrpl.connectionsCount; n++){
		(async () => {
			let sequence = stream.currentSequence

			while(true){
				let stepsToTarget = (stream.targetSequence - sequence) * stride
				let stepsBehindCurrent = (stream.currentSequence - sequence) * stride

				if(stepsToTarget < 0){
					await wait(100)
					continue
				}

				if(!stream.accepts(sequence)){
					await wait(1000)
					continue
				}

				if(stepsBehindCurrent > 0 || reservations[sequence] || stream.has(sequence)){
					sequence += stride
					continue
				}

				reservations[sequence] = true

				try{
					stream.put(
						await fetchLedger({
							ctx,
							sequence
						})
					)
					// Successful fetch — recover from outage state if we were in one
					if(inOutage){
						inOutage = false
						log.info(`ledger fetch resumed after ${outageFailureCount} failures during outage`)
						outageFailureCount = 0
					}
				}catch(error){
					logFetchFailure(sequence, error)
					await wait(1000)
				}finally{
					delete reservations[sequence]
				}
			}
		})()
	}
}