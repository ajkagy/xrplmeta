// In-process replacement for @mwni/workers' `spawn(spec, args)`.
//
// `spec` has the form '[relativePath]:exportName'.
//   - 'foo/bar.js:run' resolves foo/bar.js relative to the calling file.
//   - ':run' resolves the caller's own file.
//
// Resolution is via stack-trace inspection. Resolved URLs are normalized via
// `new URL(...).href` so the ESM cache always hits — otherwise the imported
// module re-evaluates from the top, which on the entry point causes the whole
// app to start a second time.

const DEBUG = process.env.XRPLMETA_DEBUG_SPAWN === '1'

// Modules we must never report as the caller — they're not the spawn-er.
const NEVER_CALLER = [
	'/lib/workers.js',
	// run.js is the process entry. spawn is never called from run.js directly,
	// and importing it again would re-execute top-level code (full app restart).
	'/src/run.js',
]

export async function spawn(spec, args){
	let lastColon = spec.lastIndexOf(':')
	if(lastColon < 0)
		throw new Error(`spawn: bad spec "${spec}" — expected "[relPath]:exportName"`)
	let relPath = spec.slice(0, lastColon)
	let exportName = spec.slice(lastColon + 1)
	if(!exportName)
		throw new Error(`spawn: bad spec "${spec}" — missing export name after ':'`)

	let callerUrl = findCallerUrl()

	// Always run through new URL().href so the URL is normalized and our
	// dynamic import hits the ESM module cache instead of triggering a
	// second top-level evaluation.
	let resolvedUrl = new URL(relPath || '.', callerUrl)
	if(!relPath){
		// Empty relPath = caller's own file (not the directory).
		resolvedUrl = new URL(callerUrl)
	}
	let finalUrl = resolvedUrl.href

	if(DEBUG)
		console.error(`[spawn] spec="${spec}" caller=${callerUrl} resolved=${finalUrl} export=${exportName}`)

	let mod = await import(finalUrl)
	let fn = mod[exportName]
	if(typeof fn !== 'function')
		throw new Error(`spawn: ${finalUrl} has no export "${exportName}"`)

	return await fn(args)
}

function findCallerUrl(){
	let err = new Error()
	let stack = err.stack || ''
	let lines = stack.split('\n').slice(1)

	if(DEBUG)
		console.error(`[spawn] stack:\n${lines.slice(0, 6).join('\n')}`)

	for(let line of lines){
		let match = line.match(/(file:\/\/[^\s)]+)/)
		if(!match) continue
		let url = match[1].replace(/:\d+:\d+\)?$/, '').replace(/\)$/, '')
		if(NEVER_CALLER.some(suffix => url.endsWith(suffix)))
			continue
		return url
	}

	throw new Error(`spawn: could not resolve caller URL from stack:\n${stack}`)
}
