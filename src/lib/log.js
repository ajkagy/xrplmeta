// Lightweight logger compatible with @mwni/log surface area used by the codebase.
//   log.info / warn / error / debug (variadic args, formatted with util.inspect)
//   log.config({ level, dir?, root? })
//   log.time.LEVEL(label, ...msg)            // call once with label to start; again with label + msg to log elapsed
//   log.accumulate.LEVEL({ text, data })     // batches messages and counters until flush
//   log.flush()                               // emits accumulated lines
//   log.pipe(transport)                       // forward log records to another log instance (no-op here)

import util from 'node:util'

const LEVELS = ['debug', 'info', 'warn', 'error']
const LEVEL_INDEX = Object.fromEntries(LEVELS.map((l, i) => [l, i]))

let currentLevel = LEVEL_INDEX.info
let timers = new Map()
let accumulators = {}   // level -> { text: string[], data: { key: number } }

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
			? `${Number(process.hrtime.bigint() - start) / 1e6 | 0}ms`
			: '?'
		timers.delete(label)
		let rendered = msg
			.map(s => typeof s === 'string' ? s.replace('%', elapsed) : s)
		emit(level, rendered)
		return logger
	}
}

function accumulateMethod(level){
	return function(entry){
		let acc = accumulators[level] ||= { text: [], data: {} }
		if(entry?.text){
			let parts = Array.isArray(entry.text) ? entry.text : [entry.text]
			acc.text.push(parts)
		}
		if(entry?.data){
			for(let [k, v] of Object.entries(entry.data))
				acc.data[k] = (acc.data[k] || 0) + v
		}
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
			for(let parts of acc.text){
				let rendered = parts.map(p => {
					if(typeof p !== 'string') return p
					return p.replace(/%(\w+)/g, (m, k) => acc.data[k] ?? m)
				})
				emit(level, rendered)
			}
		}
		accumulators = {}
		return logger
	}
}

export default logger
