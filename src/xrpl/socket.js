import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000

// Set XRPLMETA_DEBUG_WS=1 to log every request/response payload.
const DEBUG_WS = process.env.XRPLMETA_DEBUG_WS === '1'

// JSON replacer: convert BigInt to plain numbers when safe (this avoids
// "TypeError: Do not know how to serialize a BigInt" coming back from
// structdb-returned ledger sequences that better-sqlite3 hands back as BigInt).
function jsonReplacer(_, value){
	if(typeof value === 'bigint'){
		if(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER))
			return Number(value)
		return value.toString()
	}
	return value
}

// Thin rippled/clio WebSocket client with auto-reconnect and request/response correlation.
// Drop-in replacement for @xrplkit/socket's `createSocket({ url })`.
//
//   socket.request({ command, ... })  -> Promise<{ result, ... }>
//   socket.status()                   -> { connected: boolean }
//   socket.close()                    -> closes permanently (no reconnect)
//   socket.on('open' | 'close' | 'error' | 'ledgerClosed' | 'transaction', ...)
export default function createSocket({ url }){
	let emitter = new EventEmitter()
	let ws
	let nextRequestId = 1
	let inflight = new Map()
	let reconnectDelay = RECONNECT_BASE_MS
	let closedByUser = false
	let connected = false

	function connect(){
		ws = new WebSocket(url)

		ws.on('open', () => {
			connected = true
			reconnectDelay = RECONNECT_BASE_MS
			emitter.emit('open')
		})

		ws.on('message', data => {
			let msg
			try{
				msg = JSON.parse(data.toString('utf8'))
			}catch{
				return
			}

			if(msg.type === 'response' && msg.id != null){
				let pending = inflight.get(msg.id)
				if(!pending) return
				inflight.delete(msg.id)
				clearTimeout(pending.timer)
				if(DEBUG_WS)
					console.error(`[ws#${url}] <-- ${JSON.stringify(msg).slice(0, 500)}`)
				if(msg.status === 'success'){
					pending.resolve(msg.result)
				}else{
					let err = Object.assign(
						new Error(msg.error_message || msg.error || 'request failed'),
						{
							error: msg.error,
							error_code: msg.error_code,
							request: msg.request,
							sent: pending.sentBody
						}
					)
					pending.reject(err)
				}
				return
			}

			if(msg.type === 'transaction'){
				emitter.emit('transaction', msg)
				return
			}

			if(msg.type === 'ledgerClosed'){
				emitter.emit('ledgerClosed', msg)
				return
			}

			emitter.emit('message', msg)
		})

		ws.on('close', event => {
			connected = false
			let reason = typeof event === 'object' ? event : { code: event }
			failAllInflight(new Error(`socket closed: ${reason.code ?? 'unknown'}`))
			emitter.emit('close', reason)

			if(!closedByUser){
				setTimeout(connect, reconnectDelay)
				reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
			}
		})

		ws.on('error', err => {
			emitter.emit('error', err)
		})
	}

	function failAllInflight(error){
		for(let pending of inflight.values()){
			clearTimeout(pending.timer)
			pending.reject(error)
		}
		inflight.clear()
	}

	connect()

	return Object.assign(emitter, {
		request(payload){
			return new Promise((resolve, reject) => {
				if(!connected || !ws || ws.readyState !== WebSocket.OPEN){
					reject(new Error('socket not connected'))
					return
				}

				let id = nextRequestId++
				let timer = setTimeout(() => {
					inflight.delete(id)
					reject(new Error(`request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`))
				}, REQUEST_TIMEOUT_MS)

				let body
				try{
					body = JSON.stringify({ id, ...payload }, jsonReplacer)
				}catch(err){
					clearTimeout(timer)
					reject(err)
					return
				}

				// Set sentBody up-front (avoid races where the response arrives before we get
				// a chance to attach it after ws.send returns).
				inflight.set(id, { resolve, reject, timer, sentBody: body })

				if(DEBUG_WS)
					console.error(`[ws#${url}] --> ${body.slice(0, 500)}`)

				try{
					ws.send(body)
				}catch(err){
					inflight.delete(id)
					clearTimeout(timer)
					reject(err)
				}
			})
		},

		status(){
			return { connected }
		},

		close(){
			closedByUser = true
			failAllInflight(new Error('socket closed by user'))
			try{ ws?.close() }catch{}
		}
	})
}
