// URL sanitization + SSRF-safe hostname validation.
//
// `validate` returns true iff the URL points at a public internet endpoint:
//   - protocol is http: or https:
//   - hostname is not a loopback, link-local, private, broadcast, or reserved IP
//   - hostname is not localhost or a .local mDNS name

import dns from 'node:dns/promises'

export function sanitize(url){
	if(typeof url !== 'string')
		return url
	if(url.length < 8)
		return url
	return url.slice(0, 8) + url.slice(8)
		.replace(/\/\//g, '/')
		.replace(/\/\.$/, '')
		.replace(/\/$/, '')
		.replace(/\?$/, '')
}

export function validate(url){
	let parsed
	try{
		parsed = new URL(url)
	}catch{
		return false
	}

	if(parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
		return false

	let hostname = parsed.hostname.toLowerCase()

	if(hostname === ''
		|| hostname === 'localhost'
		|| hostname.endsWith('.local')
		|| hostname.endsWith('.localhost')
		|| hostname.endsWith('.internal'))
		return false

	if(isIPv4Literal(hostname)){
		return !isPrivateIPv4(hostname)
	}

	if(isIPv6Literal(parsed.hostname)){
		return !isPrivateIPv6(parsed.hostname)
	}

	if(/^[\d.]+$/.test(hostname))
		return false

	return true
}

// Resolve `hostname` and return true only if EVERY resolved address is public.
// `validate()` above only inspects the textual host, so a normal hostname whose
// DNS A/AAAA record points at a private/loopback/metadata IP would pass it — the
// classic DNS-rebinding SSRF. This closes that gap by checking the resolved IPs.
// NOTE: undici resolves DNS again independently when it connects, so a tiny
// TOCTOU window remains; eliminating it entirely would require a custom dispatcher
// that pins the connection to the vetted IP.
export async function isHostPublic(hostname){
	if(!hostname)
		return false

	if(isIPv4Literal(hostname))
		return !isPrivateIPv4(hostname)

	if(isIPv6Literal(hostname))
		return !isPrivateIPv6(hostname)

	let addresses
	try{
		addresses = await dns.lookup(hostname, { all: true, verbatim: true })
	}catch{
		return false
	}

	if(!addresses.length)
		return false

	for(let { address, family } of addresses){
		if(family === 4 && isPrivateIPv4(address))
			return false
		if(family === 6 && isPrivateIPv6(address))
			return false
	}

	return true
}

function isIPv4Literal(host){
	return /^(\d{1,3}\.){3}\d{1,3}$/.test(host)
}

function isIPv6Literal(host){
	if(!host) return false
	let h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
	return h.includes(':') && /^[0-9a-fA-F:.]+$/.test(h)
}

function ipv4Octets(host){
	let parts = host.split('.').map(s => parseInt(s, 10))
	if(parts.length !== 4) return null
	for(let p of parts) if(!(p >= 0 && p <= 255)) return null
	return parts
}

function isPrivateIPv4(host){
	let octets = ipv4Octets(host)
	if(!octets) return true
	let [a, b] = octets
	if(a === 0) return true                       // 0.0.0.0/8
	if(a === 10) return true                      // 10.0.0.0/8
	if(a === 127) return true                     // 127.0.0.0/8 loopback
	if(a === 169 && b === 254) return true        // 169.254.0.0/16 link-local (AWS metadata!)
	if(a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT (RFC 6598)
	if(a === 172 && b >= 16 && b <= 31) return true  // 172.16.0.0/12
	if(a === 192 && b === 168) return true        // 192.168.0.0/16
	if(a === 192 && b === 0 && octets[2] === 0) return true // 192.0.0.0/24 (assigned)
	if(a === 198 && (b === 18 || b === 19)) return true     // 198.18.0.0/15 benchmarking
	if(a >= 224) return true                      // multicast + reserved
	return false
}

function isPrivateIPv6(host){
	let h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
	let lower = h.toLowerCase()
	if(lower === '::' || lower === '::1') return true
	// IPv4-mapped IPv6 (::ffff:0:0/96) — block the entire range; legitimate use is rare
	// and attackers leverage this to bypass IPv4 filters. Spec form: ::ffff:a.b.c.d, normalized: ::ffff:hex:hex.
	if(lower.startsWith('::ffff:')) return true
	if(lower.startsWith('64:ff9b:')) return true                       // NAT64 (embeds IPv4 dest)
	if(lower.startsWith('2002:')) return true                          // 6to4 (embeds IPv4 dest)
	if(lower.startsWith('fc') || lower.startsWith('fd')) return true   // unique local
	if(lower.startsWith('fe8') || lower.startsWith('fe9')
		|| lower.startsWith('fea') || lower.startsWith('feb')) return true // link-local
	if(lower.startsWith('ff')) return true                              // multicast
	return false
}
