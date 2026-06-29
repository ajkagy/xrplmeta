// XLS-24 NFT metadata: URI resolution, JSON parsing, and media-type classification.
//
// On-chain NFToken URIs (after hex-decode) can be ipfs://, ar://, http(s)://, a
// data: URI, or a bare CID. Off-chain metadata follows the loose XLS-24 / OpenSea
// convention: { name, description, image, animation_url, collection, attributes }.
//
// IMPORTANT (storage policy): only IMAGE media is ever eligible for the local
// thumbnail cache; video / audio / 3D / html media is URL-only and never downloaded.


const EXTENSION_TYPE = {
	png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image', bmp: 'image',
	mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', mkv: 'video', ogv: 'video',
	mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio',
	glb: 'model', gltf: 'model',
	html: 'html', htm: 'html'
}


// Turn an on-chain URI into a fetchable https URL (or a data: URI verbatim).
// Returns null for unsupported / unresolvable schemes.
export function resolveUri(uri, gateways = []){
	if(typeof uri !== 'string')
		return null

	let u = uri.trim()
	if(u.length === 0)
		return null

	if(u.startsWith('data:'))
		return u

	let gateway = (gateways[0] || '').replace(/\/+$/, '')

	if(u.startsWith('ipfs://')){
		if(!gateway)
			return null
		let rest = u.slice('ipfs://'.length).replace(/^ipfs\//, '')
		return `${gateway}/ipfs/${rest}`
	}

	if(u.startsWith('ar://'))
		return `https://arweave.net/${u.slice('ar://'.length)}`

	if(u.startsWith('https://') || u.startsWith('http://'))
		return u

	// Bare CID with no scheme — treat as IPFS.
	if(/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[0-9a-z]{20,})(\/|$)/.test(u))
		return gateway ? `${gateway}/ipfs/${u}` : null

	return null
}


export function classifyMediaType(url, declaredType){
	if(declaredType){
		let t = String(declaredType).toLowerCase()
		if(t.startsWith('image/')) return 'image'
		if(t.startsWith('video/')) return 'video'
		if(t.startsWith('audio/')) return 'audio'
		if(t.startsWith('model/')) return 'model'
		if(t.startsWith('text/html')) return 'html'
	}

	if(typeof url === 'string'){
		let dataMatch = url.match(/^data:([^;,]+)/)
		if(dataMatch)
			return classifyMediaType(null, dataMatch[1])

		let ext = url.split('?')[0].split('#')[0].split('.').pop().toLowerCase()
		if(EXTENSION_TYPE[ext])
			return EXTENSION_TYPE[ext]
	}

	return 'other'
}


function firstString(values){
	for(let v of values)
		if(typeof v === 'string' && v.length > 0)
			return v
	return undefined
}


export function parseNFTMetadata(json){
	if(!json || typeof json !== 'object' || Array.isArray(json))
		return {}

	let collection = json.collection
	let collectionName = typeof collection === 'string'
		? collection
		: (collection?.name || collection?.family || undefined)

	return {
		name: typeof json.name === 'string' ? json.name : undefined,
		description: typeof json.description === 'string' ? json.description : undefined,
		image: firstString([json.image, json.image_url, json.imageUrl]),
		animationUrl: firstString([json.animation_url, json.animation, json.video, json.audio]),
		declaredType: typeof json.type === 'string' ? json.type : undefined,
		collectionName: typeof collectionName === 'string' ? collectionName : undefined,
		attributes: Array.isArray(json.attributes) ? json.attributes : undefined
	}
}


// From parsed metadata, choose the primary media URL + type, and the image URL
// eligible for thumbnailing (only when the image is actually an image).
export function selectMedia(parsed, gateways = []){
	let imageUrl = parsed.image ? resolveUri(parsed.image, gateways) : null
	let animationUrl = parsed.animationUrl ? resolveUri(parsed.animationUrl, gateways) : null

	let mediaUrl = null
	let mediaType = null

	if(animationUrl){
		mediaUrl = animationUrl
		mediaType = classifyMediaType(animationUrl, parsed.declaredType)
	}else if(imageUrl){
		mediaUrl = imageUrl
		mediaType = classifyMediaType(imageUrl, parsed.declaredType)
	}

	return {
		mediaUrl,
		mediaType,
		// Only set imageUrl when it classifies as an image — that's the only media
		// the thumbnail cache will ever fetch/store.
		imageUrl: imageUrl && classifyMediaType(imageUrl) === 'image' ? imageUrl : null
	}
}


function parseDataUriJson(dataUri){
	let comma = dataUri.indexOf(',')
	if(comma === -1)
		throw new Error(`malformed data URI`)

	let meta = dataUri.slice('data:'.length, comma)
	let payload = dataUri.slice(comma + 1)
	let text = /;base64/i.test(meta)
		? Buffer.from(payload, 'base64').toString('utf8')
		: decodeURIComponent(payload)

	return JSON.parse(text)
}


// Resolve + fetch + parse an NFT's metadata. `fetch` is injected (createFetch
// instance) so the pure logic above stays unit-testable without the network.
export async function fetchNFTMetadata({ uri, gateways, fetch }){
	let url = resolveUri(uri, gateways)
	if(!url)
		throw new Error(`unresolvable NFT URI`)

	let json
	if(url.startsWith('data:')){
		json = parseDataUriJson(url)
	}else{
		let { status, data } = await fetch(url)
		if(status !== 200)
			throw new Error(`HTTP ${status}`)

		if(data && typeof data === 'object' && !Buffer.isBuffer(data))
			json = data
		else
			json = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
	}

	let parsed = parseNFTMetadata(json)
	return { ...parsed, ...selectMedia(parsed, gateways) }
}
