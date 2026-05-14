import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000

// WebSocket upgrade handshake timeout. Generous because the bottleneck is often
// our own event loop being blocked by synchronous SQL — the TCP connection
// completes and rippled writes its 101 response within milliseconds, but our
// process can't read it until the loop unblocks. If we kill the connection
// before that happens, we end up in a permanent reconnect storm even though
// the network is fine. 90 seconds gives us tolerance for ~1-2 long sync blocks
// before giving up. Override with XRPLMETA_WS_HANDSHAKE_TIMEOUT_MS if needed.
const HANDSHAKE_TIMEOUT_MS = parseInt(process.env.XRPLMETA_WS_HANDSHAKE_TIMEOUT_MS || '90000', 10)

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
	let lastErrorInfo = null  // populated by 'error' event, consumed by 'close' to enrich the close record

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
		// Note: we DON'T add an extra "connectingTimer" wrapper on top of the ws
		// library's handshakeTimeout. The library reliably fires 'close' (with
		// code 1006 + errmsg "Opening handshake has timed out") when its timeout
		// expires, which triggers our reconnect path. Adding a second timer just
		// races to terminate the socket first, killing connections that were
		// about to succeed.
		ws = new WebSocket(url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS })

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

		// The `ws` library emits 'close' with TWO arguments (code, reason buffer),
		// not a single object. Earlier code assumed an event object, which silently
		// discarded the reason string — exactly the field that tells us *why*
		// rippled or a proxy decided to drop us.
		ws.on('close', (code, reasonBuf) => {
			let wasConnected = connected
			connected = false
			clearKeepalive()

			let reasonText = ''
			if(reasonBuf){
				try{
					reasonText = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf)
				}catch{}
			}

			let info = {
				code,
				reason: reasonText || undefined,
				wasConnected,
				lastErrorCode: lastErrorInfo?.code,
				lastErrorMessage: lastErrorInfo?.message
			}
			lastDisconnectReason = info
			failAllInflight(new Error(`socket closed: code=${code ?? 'unknown'}${reasonText ? ` "${reasonText}"` : ''}`))
			emitter.emit('close', info)

			if(!closedByUser){
				reconnectAttempts++
				let delay = reconnectDelay + Math.floor(Math.random() * 250)
				emitter.emit('reconnecting', { attempt: reconnectAttempts, delayMs: delay, lastCode: code, lastReason: reasonText })
				setTimeout(connect, delay)
				reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
			}
		})

		ws.on('error', err => {
			// Cache the most recent low-level error so the close handler can attach
			// it to the disconnect record. 1006 closes don't carry server-supplied
			// reasons, but the ws/network-layer error often has the actual cause
			// (ECONNRESET, EHOSTUNREACH, ETIMEDOUT, …).
			lastErrorInfo = {
				code: err?.code,
				message: err?.message,
				errno: err?.errno
			}
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
			let rs = ws?.readyState
			let readyState =
				rs === WebSocket.CONNECTING ? 'CONNECTING' :
				rs === WebSocket.OPEN       ? 'OPEN' :
				rs === WebSocket.CLOSING    ? 'CLOSING' :
				rs === WebSocket.CLOSED     ? 'CLOSED' :
				'UNKNOWN'
			return { connected, reconnectAttempts, lastDisconnectReason, readyState }
		},

		close(){
			closedByUser = true
			clearKeepalive()
			failAllInflight(new Error('socket closed by user'))
			try{ ws?.close() }catch{}
		}
	})
}
