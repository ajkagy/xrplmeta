import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000

// WebSocket-level keepalive ping. Off by default because some rippled / proxy
// configurations don't pong reliably under load, and a missing pong with the
// heartbeat enabled tears down the connection (causing exactly the 1006 disconnect
// loop we were trying to avoid). Set XRPLMETA_WS_KEEPALIVE=1 to enable, with
// optional XRPLMETA_WS_PING_INTERVAL_MS (default 60_000) and
// XRPLMETA_WS_PONG_TIMEOUT_MS (default 20_000).
const KEEPALIVE_ENABLED = process.env.XRPLMETA_WS_KEEPALIVE === '1'
const PING_INTERVAL_MS = parseInt(process.env.XRPLMETA_WS_PING_INTERVAL_MS || '60000', 10)
const PONG_TIMEOUT_MS = parseInt(process.env.XRPLMETA_WS_PONG_TIMEOUT_MS || '20000', 10)

// Set XRPLMETA_DEBUG_WS=1 to log every request/response payload.
const DEBUG_WS = process.env.XRPLMETA_DEBUG_WS === '1'

function jsonReplacer(_, value){
	if(typeof value === 'bigint'){
		if(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER))
			return Number(value)
		return value.toString()
	}
	return value
}

// Thin rippled/clio WebSocket client with auto-reconnect and request/response correlation.
//
//   socket.request({ command, ... })  -> Promise<.result of XRPL response>
//   socket.status()                   -> { connected, reconnectAttempts, lastDisconnectReason }
//   socket.close()                    -> closes permanently (no reconnect)
//   socket.on('open' | 'close' | 'error' | 'reconnecting' | 'ledgerClosed' | 'transaction', ...)
export default function createSocket({ url }){
	let emitter = new EventEmitter()
	let ws
	let nextRequestId = 1
	let inflight = new Map()
	let reconnectDelay = RECONNECT_BASE_MS
	let reconnectAttempts = 0
	let closedByUser = false
	let connected = false
	let lastDisconnectReason = null

	let pingTimer = null
	let pongTimer = null

	function clearKeepalive(){
		if(pingTimer){ clearInterval(pingTimer); pingTimer = null }
		if(pongTimer){ clearTimeout(pongTimer); pongTimer = null }
	}

	function startKeepalive(){
		clearKeepalive()
		if(!KEEPALIVE_ENABLED) return  // off by default — see env vars at top
		pingTimer = setInterval(() => {
			if(!ws || ws.readyState !== WebSocket.OPEN) return
			try{
				ws.ping()
			}catch{
				return
			}
			if(pongTimer) clearTimeout(pongTimer)
			pongTimer = setTimeout(() => {
				try{ ws.terminate() }catch{}
			}, PONG_TIMEOUT_MS)
		}, PING_INTERVAL_MS)
		if(pingTimer?.unref) pingTimer.unref()
	}

	function connect(){
		ws = new WebSocket(url)

		ws.on('open', () => {
			connected = true
			let wasReconnect = reconnectAttempts > 0
			reconnectAttempts = 0
			reconnectDelay = RECONNECT_BASE_MS
			lastDisconnectReason = null
			startKeepalive()
			emitter.emit('open', { wasReconnect })
		})

		ws.on('pong', () => {
			if(pongTimer){ clearTimeout(pongTimer); pongTimer = null }
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
			let wasConnected = connected
			connected = false
			clearKeepalive()
			let reason = typeof event === 'object' ? event : { code: event }
			lastDisconnectReason = reason
			failAllInflight(new Error(`socket closed: code=${reason.code ?? 'unknown'}${reason.reason ? ` (${reason.reason})` : ''}`))
			emitter.emit('close', { ...reason, wasConnected })

			if(!closedByUser){
				reconnectAttempts++
				let delay = reconnectDelay + Math.floor(Math.random() * 250)  // jitter to avoid 5 sockets all hammering at the same instant
				emitter.emit('reconnecting', { attempt: reconnectAttempts, delayMs: delay, lastCode: reason.code })
				setTimeout(connect, delay)
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
			return { connected, reconnectAttempts, lastDisconnectReason }
		},

		close(){
			closedByUser = true
			clearKeepalive()
			failAllInflight(new Error('socket closed by user'))
			try{ ws?.close() }catch{}
		}
	})
}
