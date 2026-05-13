// Drop-in replacement for @mwni/workers' `spawn(spec, args)`.
//
// `spec` has the form '[relativePath]:exportName'.
//   - 'foo/bar.js:run' resolves foo/bar.js relative to the calling file.
//   - ':run' resolves the caller's own file.
//
// All work runs in-process; the original package's worker_threads abstraction
// was used for log piping rather than CPU isolation.

export async function spawn(spec, args){
	let lastColon = spec.lastIndexOf(':')
	if(lastColon < 0)
		throw new Error(`spawn: bad spec "${spec}" — expected "[relPath]:exportName"`)
	let relPath = spec.slice(0, lastColon)
	let exportName = spec.slice(lastColon + 1)
	if(!exportName)
		throw new Error(`spawn: bad spec "${spec}" — missing export name after ':'`)

	let callerUrl = findCallerUrl()
	let resolvedUrl = relPath
		? new URL(relPath, callerUrl).href
		: callerUrl

	let mod = await import(resolvedUrl)
	let fn = mod[exportName]
	if(typeof fn !== 'function')
		throw new Error(`spawn: ${resolvedUrl} has no export "${exportName}"`)

	return await fn(args)
}

function findCallerUrl(){
	let err = new Error()
	let stack = err.stack || ''
	let lines = stack.split('\n').slice(1)

	for(let line of lines){
		// match file:// URL anywhere in the line, then strip optional :line:col suffix and trailing ')'
		let match = line.match(/(file:\/\/[^\s)]+)/)
		if(!match) continue
		let url = match[1].replace(/:\d+:\d+\)?$/, '').replace(/\)$/, '')
		if(url.endsWith('/lib/workers.js'))
			continue
		return url
	}

	throw new Error(`spawn: could not resolve caller URL from stack`)
}
