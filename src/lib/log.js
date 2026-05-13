// Lightweight logger compatible with @mwni/log surface area used by the codebase.
//   log.info / warn / error / debug (variadic args, formatted with util.inspect)
//   log.config({ level })
//   log.time.LEVEL(label, ...msg)            // call once with label to start; again with label + msg to log elapsed
//   log.accumulate.LEVEL({ text, data })     // batches messages + counters; auto-flushes periodically
//   log.flush()                               // emits accumulated lines immediately
//   log.pipe(transport)                       // forward log records to another log instance (no-op here)

import util from 'node:util'

const LEVELS = ['debug', 'info', 'warn', 'error']
const LEVEL_INDEX = Object.fromEntries(LEVELS.map((l, i) => [l, i]))

// Auto-flush accumulators every N ms so long-running batched workloads (snapshot,
// backfill catch-up) still show progress instead of going silent until something
// else triggers a flush.
const ACCUMULATE_AUTOFLUSH_MS = 5_000

let currentLevel = LEVEL_INDEX.info
let timers = new Map()
let accumulators = {}     // level -> { text: string[], data: { key: number }, startedAt: bigint }
let autoFlushTimer = null

function format(args){
	return args
		.map(a => {
			if(typeof a === 'string') return a
			if(a instanceof Error) return a.stack || a.message
			return util.inspect(a, { depth: 4, colors: false })
		})
		.join(' ')
}

function emit(level, args){
	if(LEVEL_INDEX[level] < currentLevel) return
	let timestamp = new Date().toISOString()
	let line = `${timestamp} ${level.toUpperCase().padEnd(5)} ${format(args)}`
	if(level === 'error' || level === 'warn'){
		process.stderr.write(line + '\n')
	}else{
		process.stdout.write(line + '\n')
	}
}

function timeMethod(level){
	return function(label, ...msg){
		if(msg.length === 0){
			timers.set(label, process.hrtime.bigint())
			return logger
		}
		let start = timers.get(label)
		let elapsed = start
			? formatElapsed(process.hrtime.bigint() - start)
			: '?'
		timers.delete(label)
		let rendered = msg
			.map(s => typeof s === 'string' ? s.replace('%', elapsed) : s)
		emit(level, rendered)
		return logger
	}
}

function formatElapsed(ns){
	let ms = Number(ns) / 1e6
	if(ms < 1000) return `${ms | 0}ms`
	let s = ms / 1000
	if(s < 60) return `${s.toFixed(1)}s`
	let m = s / 60
	return `${m.toFixed(1)}m`
}

function scheduleAutoFlush(){
	if(autoFlushTimer) return
	autoFlushTimer = setTimeout(() => {
		autoFlushTimer = null
		logger.flush()
	}, ACCUMULATE_AUTOFLUSH_MS)
	// Don't keep the event loop alive just for the flush timer.
	if(typeof autoFlushTimer.unref === 'function')
		autoFlushTimer.unref()
}

function accumulateMethod(level){
	return function(entry){
		let acc = accumulators[level]
		if(!acc){
			acc = accumulators[level] = { text: [], data: {}, startedAt: process.hrtime.bigint() }
		}
		if(entry?.text){
			let parts = Array.isArray(entry.text) ? entry.text : [entry.text]
			acc.text.push(parts)
		}
		if(entry?.data){
			for(let [k, v] of Object.entries(entry.data))
				acc.data[k] = (acc.data[k] || 0) + v
		}
		scheduleAutoFlush()
		return logger
	}
}

const logger = {
	debug(...args){ emit('debug', args); return logger },
	info(...args){ emit('info', args); return logger },
	warn(...args){ emit('warn', args); return logger },
	error(...args){ emit('error', args); return logger },

	config({ level } = {}){
		if(level && LEVEL_INDEX[level] !== undefined)
			currentLevel = LEVEL_INDEX[level]
		return logger
	},

	pipe(){
		return logger
	},

	time: {
		debug: timeMethod('debug'),
		info: timeMethod('info'),
		warn: timeMethod('warn'),
		error: timeMethod('error'),
	},

	accumulate: {
		debug: accumulateMethod('debug'),
		info: accumulateMethod('info'),
		warn: accumulateMethod('warn'),
		error: accumulateMethod('error'),
	},

	flush(){
		for(let [level, acc] of Object.entries(accumulators)){
			if(acc.text.length === 0 && Object.keys(acc.data).length === 0)
				continue
			let elapsed = formatElapsed(process.hrtime.bigint() - acc.startedAt)
			for(let parts of acc.text){
				let rendered = parts.map(p => {
					if(typeof p !== 'string') return p
					return p.replace(/%time\b/g, elapsed)
						.replace(/%(\w+)/g, (m, k) => acc.data[k] ?? m)
				})
				emit(level, rendered)
			}
		}
		accumulators = {}
		if(autoFlushTimer){
			clearTimeout(autoFlushTimer)
			autoFlushTimer = null
		}
		return logger
	}
}

export default logger
