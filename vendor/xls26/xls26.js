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

	try{
		var toml = parseToml(str)
	}catch(error){
		// smol-toml's TomlError has .line/.column; other errors don't. Cover both.
		let line = error?.line
		let col = error?.column
		let snippet = error?.codeblock ? `\n${error.codeblock}` : ''
		if(line !== undefined && col !== undefined)
			throw new Error(`Failed to parse .toml at line ${line}:${col} — ${error.message}${snippet}`)
		throw new Error(`Failed to parse .toml: ${error?.message || error}`)
	}

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
		advisories
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