// The XLS-26 standard adds additional asset metadata fields to the existing xrp-ledger.toml standard,
// https://github.com/XRPLF/XRPL-Standards/discussions/71
// This package provides an implementation for a parser according to this standard.
// Version 5 from 2025-06-06.


import { parse as parseToml } from 'smol-toml'

const validUrlRegex = /^(https?)|(ipfs):\/\/.*$/
const validUrlTypes = {
	website: 'website',
	social: 'social',
	docs: 'docs',
	other: 'other',
	info: 'website',
	socialmedia: 'social',
	community: 'social',
	support: 'website',
	whitepaper: 'docs',
	certificate: 'docs',
}

const validAssetClasses = [
	'rwa',
	'memes',
	'wrapped',
	'gaming',
	'defi',
	'other'
]

const validAssetSubClasses = [
	'stablecoin',
	'commodity',
	'real_estate',
	'private_credit',
	'equity',
	'treasury',
	'other'
]

const legacyAssetClasses = {
	fiat: { asset_class: 'rwa', asset_subclass: 'stablecoin' },
	commodity: { asset_class: 'rwa', asset_subclass: 'commodity' },
	equity: { asset_class: 'rwa', asset_subclass: 'equity' },
	// Used by some trustlists (e.g. unhosted.exchange/tokens.toml) for wrapped/native
	// cryptocurrency tokens. Maps to the "other" class — these aren't RWA, memes,
	// gaming, or DeFi assets specifically, so "other" is the closest current bucket.
	cryptocurrency: { asset_class: 'other' },
}

const validAdvisoryTypes = [
	'scam',
	'spam',
	'illegal',
	'offensive',
	'hijacked'
]

const issuerFields = [
	{
		key: 'address',
		required: true,
		validate: v => {
			if(!/^[rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz]{25,35}$/.test(v))
				throw 'is not a valid XRPL address'
		},
	},
	{
		key: 'name',
		validate: v => {
			if(typeof v !== 'string' || v.length === 0)
				throw 'must be a non empty string'
		}
	},
	{
		key: 'desc',
		alternativeKeys: ['description'],
		validate: v => {
			if(typeof v !== 'string' || v.length === 0)
				throw 'must be a non empty string'
		}
	},
	{
		key: 'domain',
		validate: v => {
			if(typeof v !== 'string' || v.length === 0)
				throw 'must be a non empty string'
		}
	},
	{
		key: 'icon',
		alternativeKeys: ['avatar'],
		validate: v => {
			if(!validUrlRegex.test(v))
				throw 'must be a valid URL that starts with "http" or "ipfs"'
		}
	},
	{
		key: 'trust_level',
		validate: v => {
			if(v !== parseInt(v))
				throw 'must be a integer'

			if(v < 0 || v > 3)
				throw 'must be between 0 and 3'
		}
	}
]

const iouTokenFields = [
	{
		key: 'currency',
		alternativeKeys: ['code'],
		required: true,
		validate: v => {
			if(typeof v !== 'string' && v.length < 3)
				throw 'is not a valid XRPL currency code'
		}
	},
	{
		key: 'issuer',
		required: true,
		validate: v => {
			if(!/^[rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz]{25,35}$/.test(v))
				throw 'is not a valid XRPL address'
		}
	},
	{
		key: 'name',
		validate: v => {
			if(typeof v !== 'string' || v.length === 0)
				throw 'must be a non empty string'
		}
	},
	{
		key: 'desc',
		alternativeKeys: ['description'],
		validate: v => {
			if(typeof v !== 'string' || v.length === 0)
				throw 'must be a non empty string'
		}
	},
	{
		key: 'icon',
		alternativeKeys: ['avatar'],
		validate: v => {
			if(!validUrlRegex.test(v))
				throw 'must be a valid URL starting with "http" or "ipfs"'
		}
	},
	{
		key: 'trust_level',
		validate: v => {
			if(v !== parseInt(v))
				throw 'must be a integer'

			if(v < 0 || v > 3)
				throw 'must be between 0 and 3'
		}
	},
	{
		key: 'asset_class',
		validate: v => {
			if(!legacyAssetClasses[v] && !validAssetClasses.includes(v))
				throw `must be one of: ${validAssetClasses.join(', ')}`
		}
	},
	{
		key: 'asset_subclass',
		validate: v => {
			if(!validAssetSubClasses.includes(v))
				throw `must be one of: ${validAssetSubClasses.join(', ')}`
		}
	}
]

const mpTokenFields = [
	{
		key: 'mpt_issuance_id',
		required: true,
		validate: v => {
			if(!/^[0-9a-fA-F]{48}$/.test(v))
				throw 'is not a valid mpt_issuance_id'
		}
	},	
	{
		key: 'trust_level',
		required: true,
		validate: v => {
			if(v !== parseInt(v))
				throw 'must be a integer'

			if(v < 0 || v > 3)
				throw 'must be between 0 and 3'
		}
	}
]

const urlFields = [
	{
		key: 'url',
		required: true,
		validate: v => {
			if(!validUrlRegex.test(v))
				throw 'must be a valid URL starting with "http" or "ipfs"'
		}
	},
	{
		key: 'type',
		validate: v => {
			if(!validUrlTypes[v])
				throw `must be one of: ${Array.from(new Set(Object.values(validUrlTypes))).join(', ')}`
		},
		transform: v => {
			return validUrlTypes[v]
		}
	},
	{
		key: 'title',
		validate: v => {
			if(typeof v !== 'string' || v.length === 0)
				throw 'must be a non empty string'
		}
	},
]

const advisoryFields = [
	{
		key: 'address',
		required: true,
		validate: v => {
			if(!/^[rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz]{25,35}$/.test(v))
				throw 'is not a valid XRPL address'
		},
	},
	{
		key: 'type',
		validate: v => {
			if(!validAdvisoryTypes.includes(v))
				throw `must be one of: ${validAdvisoryTypes.join(', ')}`
		}
	},
	{
		key: 'description',
		alternativeKeys: ['desc'],
		validate: v => {
			if(typeof v !== 'string' || v.length === 0)
				throw 'must be a non empty string'
		}
	}
]

export function parse(str){
	if(typeof str !== 'string'){
		// Some callers pass a Buffer here (when the upstream fetch identifies the
		// content-type as binary). Coerce so smol-toml — which only accepts string —
		// doesn't blow up with a generic TypeError that hides the actual issue.
		if(str && typeof str.toString === 'function'){
			str = str.toString('utf8')
		}else{
			throw new Error(`Failed to parse .toml: input is not a string (got ${typeof str})`)
		}
	}
	if(str.length === 0)
		throw new Error(`Failed to parse .toml: input is empty`)

	let { toml, repairs } = parseWithRepairs(str)

	let issuers = []
	let tokens = []
	let issues = []
	let advisories = []


	for(let stanza of (toml.ISSUERS || toml.ACCOUNTS || [])){
		let { valid, parsed: issuer, issues: issuerIssues } = parseStanza(stanza, issuerFields)

		issues.push(
			...issuerIssues.map(
				issue => `[[ISSUERS]] ${issue}`
			)
		)

		if(valid)
			issuers.push(issuer)
		else
			continue

		for(let substanza of (stanza.URLS || stanza.WEBLINKS || [])){
			let { valid, parsed: url, issues: urlIssues } = parseStanza(substanza, urlFields)

			if(valid){
				issuer.urls = [
					...(issuer.urls || []),
					url
				]
			}

			issues.push(
				...urlIssues.map(
					issue => `[[ISSUERS.URLS]] ${issue}`
				)
			)
		}
	}

	for(let stanza of (toml.TOKENS || toml.CURRENCIES || [])){
		let { valid, parsed: token, issues: tokenIssues } = parseStanza(stanza, stanza['mpt_issuance_id'] != null ? mpTokenFields : iouTokenFields)

		issues.push(
			...tokenIssues.map(
				issue => `[[TOKENS]] ${issue}`
			)
		)

		if(valid)
			tokens.push(token)
		else
			continue

		for(let substanza of (stanza.URLS || stanza.WEBLINKS || [])){
			let { valid, parsed: url, issues: urlIssues } = parseStanza(substanza, urlFields)

			if(valid){
				token.urls = [
					...(token.urls || []),
					url
				]
			}

			issues.push(
				...urlIssues.map(
					issue => `[[TOKENS.URLS]] ${issue}`
				)
			)
		}
	}

	if(toml.ADVISORIES){
		for(let stanza of toml.ADVISORIES){
			let { valid, parsed: advisory, issues: advisoryIssues } = parseStanza(stanza, advisoryFields)

			if(valid)
				advisories.push(advisory)
				
			issues.push(
				...advisoryIssues.map(
					issue => `[[ADVISORIES]] ${issue}`
				)
			)
		}
	}

	// Issuer URLs have been dropped since Version 5
	// Issuer URLs now get mapped to respective tokens

	for(let issuer of issuers){
		if(!issuer.urls)
			continue

		for(let token of tokens){
			if(token.issuer !== issuer.address)
				continue

			token.urls = [
				...issuer.urls,
				...(token.urls || [])
			] 
		}

		delete issuer.urls
	}

	for(let token of tokens){
		if(!legacyAssetClasses[token.asset_class])
			continue

		Object.assign(token, legacyAssetClasses[token.asset_class])
	}

	return {
		issuers,
		tokens,
		issues,
		advisories,
		repairs
	}
}

function parseStanza(stanza, schemas){
	let parsed = {}
	let issues = []
	let valid = true

	for(let { key, alternativeKeys, required, validate, transform } of schemas){
		let keys = [key]

		if(alternativeKeys)
			keys.push(...alternativeKeys)

		for(let k of keys){
			if(stanza[k] === undefined)
				continue

			let value = stanza[k]

			if(validate){
				try{
					validate(value)
				}catch(issue){
					issues.push(`${k} field: ${issue}`)
					break
				}
			}

			if(transform)
				value = transform(value)

			parsed[key] = value
			break
		}

		if(required && parsed[key] === undefined){
			issues.push(`${key} field missing: skipping stanza`)
			valid = false
		}
	}

	return { valid, parsed, issues }
}

// --- TOML parse-failure helpers ----------------------------------------------

// smol-toml's TomlError message already contains the codeblock with the offending
// lines. Use just that and don't append it a second time. The Error we throw
// stays a one-shot summary line so callers don't dump giant blobs to the log.
function formatTomlError(error, suffix){
	let s = suffix ? ` ${suffix}` : ''
	if(error?.line !== undefined && error?.column !== undefined){
		// Strip the "Invalid TOML document: " prefix smol-toml adds, since we add our own.
		let cleanMessage = (error.message || '').split('\n')[0].replace(/^Invalid TOML document:\s*/, '')
		let codeblock = error.codeblock ? `\n${error.codeblock}` : ''
		return new Error(`Failed to parse .toml at line ${error.line}:${error.column}${s} — ${cleanMessage}${codeblock}`)
	}
	return new Error(`Failed to parse .toml${s}: ${error?.message || error}`)
}

// Some trustlists in the wild contain basic strings that span multiple physical
// lines without using TOML's triple-quoted multi-line syntax — e.g.
//
//   desc = "first line of a long sentence
//   that continues here."
//
// Strict TOML 1.0 rejects this with "newlines are not allowed in strings".
// We make a best-effort fix: if a logical line has an odd number of unescaped
// double-quote characters (i.e. an unterminated string), we join with subsequent
// lines until quotes balance, replacing the newline with a single space.
//
// We avoid touching:
//   - lines inside triple-quoted blocks (`"""..."""`)
//   - inline-table / array continuations (the heuristic only triggers on quotes)
//   - quotes inside comments (we strip `# ...` from quote-counting only)
function normalizeUnterminatedStrings(str){
	let lines = str.split(/\r\n|\n|\r/)
	let out = []
	let inTripleQuote = false
	let i = 0

	while(i < lines.length){
		let line = lines[i]

		if(line.includes('"""')){
			let triples = (line.match(/"""/g) || []).length
			if(triples % 2 === 1) inTripleQuote = !inTripleQuote
			out.push(line)
			i++
			continue
		}
		if(inTripleQuote){
			out.push(line)
			i++
			continue
		}

		// Strip everything after an unquoted '#' so quotes inside comments don't confuse us.
		let codeOnly = stripTrailingComment(line)
		let quoteCount = countUnescapedDoubleQuotes(codeOnly)

		if(quoteCount % 2 === 0){
			out.push(line)
			i++
			continue
		}

		// Unterminated string — concatenate next lines until quotes balance.
		let joined = line
		let total = quoteCount
		let j = i + 1
		while(j < lines.length && total % 2 === 1){
			joined += ' ' + lines[j]
			total += countUnescapedDoubleQuotes(stripTrailingComment(lines[j]))
			j++
			if(j - i > 50) break  // safety: don't merge arbitrarily far
		}
		out.push(joined)
		i = j
	}

	return out.join('\n')
}

function stripTrailingComment(line){
	// Drop everything from the first '#' that isn't inside a string. Walk char by char,
	// toggle in-string on unescaped " and bail at # while not in-string.
	const BACKSLASH = String.fromCharCode(92)
	let inString = false
	let prev = ''
	for(let k = 0; k < line.length; k++){
		let c = line[k]
		if(c === '"' && prev !== BACKSLASH) inString = !inString
		else if(c === '#' && !inString) return line.slice(0, k)
		prev = c
	}
	return line
}

function countUnescapedDoubleQuotes(line){
	const BACKSLASH = String.fromCharCode(92)
	let count = 0
	let prev = ''
	for(let k = 0; k < line.length; k++){
		if(line[k] === '"' && prev !== BACKSLASH) count++
		prev = line[k]
	}
	return count
}


// --- TOML repair pipeline ----------------------------------------------------
//
// Trustlists are user-curated files served by third parties. We *cannot* assume
// they're spec-perfect, but we also don't want to drop the entire file because
// one issuer has a stray newline. The repair pipeline tries successively more
// aggressive fixes, then falls back to per-stanza parsing so a single broken
// section doesn't poison the whole file.
//
// Repair stages (cumulative):
//   1. byte hygiene       : strip BOM, normalize CRLF→LF, drop NUL bytes
//   2. multi-line strings : join unterminated basic strings across newlines
//   3. stanza isolation   : split file into [[Section]] blocks, parse each
//                           one independently, keep the survivors
function parseWithRepairs(originalStr){
	let repairs = []
	let stages = [
		{ name: 'as-is',              fn: s => s },
		{ name: 'byte-hygiene',       fn: applyByteHygiene },
		{ name: 'multi-line-strings', fn: normalizeUnterminatedStrings },
	]

	let str = originalStr
	let lastError

	for(let stage of stages){
		let next = stage.fn(str)
		if(stage.name !== 'as-is' && next === str) continue
		str = next

		try{
			let toml = parseToml(str)
			if(stage.name !== 'as-is')
				repairs.push(`applied repair: ${stage.name}`)
			return { toml, repairs }
		}catch(error){
			lastError = error
		}
	}

	let { toml, repairs: stanzaRepairs } = parseByStanzaIsolation(str, lastError)
	if(toml){
		repairs.push(...stanzaRepairs)
		return { toml, repairs }
	}

	throw formatTomlError(lastError)
}

function applyByteHygiene(str){
	let out = str
	// Strip UTF-8 BOM if present
	if(out.charCodeAt(0) === 0xFEFF) out = out.slice(1)
	// Strip NUL bytes (some text editors leave them)
	out = out.split(String.fromCharCode(0)).join('')
	// Normalize line endings
	out = out.replace(/\r\n|\r/g, '\n')
	return out
}

// Split into top-level [[Section]] blocks (e.g. [[ISSUERS]], [[TOKENS]]) and
// parse each independently. Sub-tables like [[ISSUERS.WEBLINKS]] stay attached
// to the immediately preceding parent block.
function parseByStanzaIsolation(str, originalError){
	let lines = str.split('\n')
	let repairs = []
	let blocks = []
	let current = null

	for(let line of lines){
		let m = line.match(/^\s*\[\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]\]\s*$/)
		if(m){
			if(current) blocks.push(current)
			current = { name: m[1], lines: [line] }
		}else if(current){
			current.lines.push(line)
		}
	}
	if(current) blocks.push(current)

	if(blocks.length === 0)
		return { toml: null, repairs: [] }

	let grouped = {}
	let dropped = 0
	for(let block of blocks){
		let body = block.lines.join('\n')
		let attempts = [
			body,
			applyByteHygiene(body),
			normalizeUnterminatedStrings(body),
			normalizeUnterminatedStrings(applyByteHygiene(body)),
		]

		let parsedBlock = null
		for(let attempt of attempts){
			try{
				let mini = parseToml(attempt)
				let arr = mini[block.name]
				if(Array.isArray(arr) && arr.length > 0){
					parsedBlock = arr
					break
				}
			}catch{
				// try next repair
			}
		}

		if(parsedBlock){
			if(!grouped[block.name]) grouped[block.name] = []
			grouped[block.name].push(...parsedBlock)
		}else{
			dropped++
			let preview = block.lines.slice(0, 2).join(' / ').trim().slice(0, 80)
			repairs.push(`dropped malformed [[${block.name}]] block near "${preview}"`)
		}
	}

	if(Object.keys(grouped).length === 0)
		return { toml: null, repairs: [] }

	repairs.unshift(
		`stanza-isolation fallback (top-level parse failed: ${(originalError?.message || '').split('\n')[0]})`
	)
	if(dropped > 0){
		let kept = Object.values(grouped).reduce((a, b) => a + b.length, 0)
		repairs.push(`stanza-isolation: kept ${kept} stanzas, dropped ${dropped}`)
	}

	return { toml: grouped, repairs }
}
