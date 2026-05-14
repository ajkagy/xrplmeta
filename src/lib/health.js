// Event-loop lag monitor + lightweight health metrics.
//
// Sampling: every 250ms we schedule an immediate task and measure how long it
// took to fire vs how long we expected. The delta is the event-loop lag — i.e.
// how long synchronous work (better-sqlite3 queries, JSON parsing, etc.) is
// blocking the loop. If lag is high, HTTP requests can't complete; that's the
// signal to shed load.
//
// All exported state is process-local. Import wherever you need to read it.

const SAMPLE_INTERVAL_MS = 250

// Rolling window of the last N lag samples. Used to compute mean / p95.
const WINDOW_SIZE = 60   // 60 samples × 250ms = 15s rolling window
let lagWindow = []
let lastLagMs = 0
let peakLagMsLastMin = 0
let peakLagResetAt = Date.now()

let monitorStarted = false


export function startHealthMonitor(){
	if(monitorStarted) return
	monitorStarted = true

	let lastSampleAt = Date.now()
	function sample(){
		let now = Date.now()
		let lag = Math.max(0, now - lastSampleAt - SAMPLE_INTERVAL_MS)
		lastSampleAt = now
		lastLagMs = lag

		lagWindow.push(lag)
		if(lagWindow.length > WINDOW_SIZE) lagWindow.shift()

		// Track peak lag over last minute (resets every 60s)
		if(now - peakLagResetAt > 60_000){
			peakLagMsLastMin = lag
			peakLagResetAt = now
		}else if(lag > peakLagMsLastMin){
			peakLagMsLastMin = lag
		}

		// Schedule next sample
		setTimeout(sample, SAMPLE_INTERVAL_MS)
	}

	// First sample after one interval — use setTimeout so we don't block module load
	setTimeout(sample, SAMPLE_INTERVAL_MS)
}


export function getEventLoopLag(){
	if(lagWindow.length === 0)
		return { current: 0, p50: 0, p95: 0, peak1m: 0, samples: 0 }

	let sorted = [...lagWindow].sort((a, b) => a - b)
	let p50 = sorted[Math.floor(sorted.length * 0.5)]
	let p95 = sorted[Math.floor(sorted.length * 0.95)]
	return {
		current: lastLagMs,
		p50,
		p95,
		peak1m: peakLagMsLastMin,
		samples: lagWindow.length
	}
}

// Convenience predicates for load-shedding decisions.
export function isLoopStressed(){
	return lastLagMs > 500  // 500ms+ lag is severe
}

export function isLoopCritical(){
	return lastLagMs > 2000  // 2s+ lag — refuse new HTTP
}


// --- Misc process-level metrics ---------------------------------------------

export function getProcessSnapshot(){
	let mem = process.memoryUsage()
	return {
		uptime_s: Math.floor(process.uptime()),
		rss_mb: Math.round(mem.rss / 1024 / 1024),
		heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
		heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
		external_mb: Math.round(mem.external / 1024 / 1024)
	}
}
