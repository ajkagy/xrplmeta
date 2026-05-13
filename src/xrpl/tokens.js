import { div } from '../../vendor/xfl/wrappers/class.js'

// XRPL currency codes:
//   - "XRP" itself is the special XRP code.
//   - 3-char ASCII ISO codes like "USD" are encoded as standard 40-char hex
//     (one byte of 0x00 type + 12 bytes of zero padding + 3 ASCII bytes + 4 bytes of zero pad).
//   - Anything else is a 40-char hex token code. The first byte's high nibble selects the type:
//     0x00 = ASCII payload (read until first 0x00 byte), 0x01 = demurraged, etc.

export function currencyHexToUTF8(code){
	if(typeof code !== 'string')
		return code

	if(code.length === 3)
		return code

	if(code.length !== 40)
		return code

	let upper = code.toUpperCase()
	let typeNibble = upper.slice(0, 2)

	if(typeNibble === '00'
		&& upper.slice(0, 24) === '000000000000000000000000'
		&& upper.slice(30, 40) === '0000000000'){
		let asciiHex = upper.slice(24, 30)
		let asciiBytes = Buffer.from(asciiHex, 'hex').toString('ascii')
		if(/^[\x20-\x7E]{3}$/.test(asciiBytes))
			return asciiBytes
	}

	let bytes = Buffer.from(upper, 'hex')
	let end = bytes.length
	while(end > 0 && bytes[end - 1] === 0) end--
	let str = bytes.slice(0, end).toString('utf8')
	if(/^[\x09\x0A\x0D\x20-�]*$/u.test(str))
		return str

	return upper
}

export function currencyUTF8ToHex(str){
	if(str === 'XRP')
		return str

	if(typeof str !== 'string')
		return str

	if(/^[0-9A-Fa-f]{40}$/.test(str))
		return str.toUpperCase()

	if(str.length === 3)
		return str

	let bytes = Buffer.from(str, 'utf8')
	if(bytes.length > 20)
		throw new Error(`currency string too long for non-standard currency code: ${str}`)

	let padded = Buffer.alloc(20)
	bytes.copy(padded)
	return padded.toString('hex').toUpperCase()
}

export function amountFromRippled(amount){
	if(typeof amount === 'string'){
		return {
			currency: 'XRP',
			value: div(amount, '1000000')
		}
	}

	if(amount && typeof amount === 'object'){
		if(amount.mpt_issuance_id){
			return {
				mpt_issuance_id: amount.mpt_issuance_id,
				value: amount.value
			}
		}

		return {
			currency: amount.currency,
			issuer: amount.issuer,
			value: amount.value
		}
	}

	throw new Error(`unrecognized amount format: ${JSON.stringify(amount)}`)
}

export function isSameToken(a, b){
	if(!a || !b)
		return false

	if(a.mptIssuanceId || b.mptIssuanceId)
		return a.mptIssuanceId === b.mptIssuanceId

	if(a.currency !== b.currency)
		return false

	if(a.currency === 'XRP')
		return true

	let aIssuer = a.issuer?.address ?? a.issuer
	let bIssuer = b.issuer?.address ?? b.issuer
	return aIssuer === bIssuer
}
