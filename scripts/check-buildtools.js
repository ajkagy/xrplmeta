#!/usr/bin/env node
// Preflight: verify node-gyp can find a C compiler + Python before we try to build the xfl extension.

import { spawnSync } from 'node:child_process'
import process from 'node:process'

const platform = process.platform
const isCI = process.env.CI === 'true' || process.env.CI === '1'

function tryRun(cmd, args){
	try{
		let r = spawnSync(cmd, args, { stdio: 'ignore', shell: false })
		return r.status === 0
	}catch{
		return false
	}
}

function fail(msg){
	console.error(`\n[xrplmeta build preflight] ${msg}\n`)
	console.error(`The native sqlite-xfl extension cannot be built without these tools.`)
	console.error(`See https://github.com/nodejs/node-gyp#installation for setup instructions.\n`)
	process.exit(1)
}

let hasPython = tryRun('python3', ['--version']) || tryRun('python', ['--version'])
if(!hasPython)
	fail(`Python is required by node-gyp but was not found on PATH.`)

if(platform === 'win32'){
	let hasMSVC = !!process.env.VCINSTALLDIR
		|| !!process.env.VSINSTALLDIR
		|| tryRun('where', ['cl.exe'])
	if(!hasMSVC && !isCI){
		console.warn(`[xrplmeta build preflight] Visual Studio C++ Build Tools were not detected.`)
		console.warn(`If the build fails, install them: https://aka.ms/vs/17/release/vs_BuildTools.exe`)
	}
}else if(platform === 'darwin'){
	let hasCC = tryRun('xcode-select', ['-p']) || tryRun('clang', ['--version'])
	if(!hasCC)
		fail(`Xcode Command Line Tools are required (run: xcode-select --install).`)
}else{
	let hasCC = tryRun('cc', ['--version']) || tryRun('gcc', ['--version']) || tryRun('clang', ['--version'])
	if(!hasCC)
		fail(`A C compiler (gcc/clang) is required.`)
}
