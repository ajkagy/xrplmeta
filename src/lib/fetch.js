import { RateLimiter } from 'limiter'
import { sanitize, validate as validateURL } from './url.js'

const DEFAULT_MAX_BYTES = {
	json: 5 * 1024 * 1024,        // 5 MiB
	text: 1 * 1024 * 1024,        // 1 MiB
	binary: 10 * 1024 * 1024      // 10 MiB
}

const DEFAULT_MAX_REDIRECTS = 5

export function createFetch({ baseUrl, headers, ratelimit, timeout = 20, maxBytes, validateUrls = false } = {}){
	let limiter = ratelimit
		? new RateLimiter({
			tokensPerInterval: ratelimit,
			interval: 'minute'
		})
		: null

	let limits = { ...DEFAULT_MAX_BYTES, ...maxBytes }

	return async (url = '', options = {}) => {
		if(limiter)
			await limiter.removeTokens(1)

		let controller = new AbortController()
		let timeoutTimer = setTimeout(() => controller.abort(), timeout * 1000)
		let sanitizedUrl = sanitize(baseUrl ? `${baseUrl}/${url}` : url)
		let res

		try{
			res = await fetchWithSafeRedirects({
				url: sanitizedUrl,
				signal: controller.signal,
				headers: {
					'user-agent': 'XRPL-Meta-Node (https://xrplmeta.org)',
					...headers,
					...options.headers
				},
				validateUrls,
				maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
				redirect: options.redirect
			})
		}finally{
			clearTimeout(timeoutTimer)
		}

		if(options.raw)
			return res

		let contentType = res.headers.get('content-type') || ''
		let data = null

		try{
			if(contentType.includes('application/json')){
				data = await readJSONBounded(res, limits.json)
			}else if(/(image\/|video\/|application\/octet-stream)/.test(contentType)){
				data = await readBytesBounded(res, limits.binary)
			}else{
				data = await readTextBounded(res, limits.text)
			}
		}catch(error){
			if(error?.name === 'ResponseTooLarge')
				throw error
			data = null
		}

		return {
			status: res.status,
			headers: res.headers,
			data
		}
	}
}

async function fetchWithSafeRedirects({ url, signal, headers, validateUrls, maxRedirects, redirect }){
	if(redirect === 'follow' || redirect === undefined){
		let current = url
		for(let i=0; i<=maxRedirects; i++){
			if(validateUrls && !validateURL(current))
				throw new Error(`refused to fetch unsafe URL: ${current}`)

			let res = await fetch(current, {
				signal,
				headers,
				redirect: 'manual'
			})

			if(res.status >= 300 && res.status < 400 && res.headers.get('location')){
				current = new URL(res.headers.get('location'), current).toString()
				continue
			}

			return res
		}
		throw new Error(`exceeded ${maxRedirects} redirects`)
	}

	if(validateUrls && !validateURL(url))
		throw new Error(`refused to fetch unsafe URL: ${url}`)

	return await fetch(url, { signal, headers, redirect: redirect || 'manual' })
}

function tooLarge(){
	let err = new Error('response too large')
	err.name = 'ResponseTooLarge'
	return err
}

async function readBytesBounded(res, maxBytes){
	let contentLength = parseInt(res.headers.get('content-length') || '0', 10)
	if(contentLength > maxBytes)
		throw tooLarge()

	let reader = res.body.getReader()
	let chunks = []
	let received = 0

	while(true){
		let { done, value } = await reader.read()
		if(done) break
		received += value.byteLength
		if(received > maxBytes){
			try{ await reader.cancel() }catch{}
			throw tooLarge()
		}
		chunks.push(value)
	}

	return Buffer.concat(chunks.map(c => Buffer.from(c)))
}

async function readTextBounded(res, maxBytes){
	let buf = await readBytesBounded(res, maxBytes)
	return buf.toString('utf8')
}

async function readJSONBounded(res, maxBytes){
	let text = await readTextBounded(res, maxBytes)
	return text ? JSON.parse(text) : null
}
