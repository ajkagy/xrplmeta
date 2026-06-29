// XLS-20 NFTokenID decoding.
//
// A 256-bit (64 hex char) NFTokenID packs:
//   bytes  0-1  (hex  0..4 )  Flags        (uint16)
//   bytes  2-3  (hex  4..8 )  TransferFee  (uint16, 1/100,000 units)
//   bytes  4-23 (hex  8..48)  Issuer       (20-byte AccountID)
//   bytes 24-27 (hex 48..56)  Taxon        (uint32, SCRAMBLED)
//   bytes 28-31 (hex 56..64)  Serial       (uint32, the token sequence)
//
// The taxon is XOR-scrambled with the token sequence so sequential mints don't
// produce visually-grouped ids. The cipher is its own inverse:
//   realTaxon = scrambledTaxon XOR ((384160001 * serial + 2459) mod 2^32)

import { encodeAccountID } from 'ripple-address-codec'


const UINT32 = 4294967296n


export function decodeNFTokenId(tokenId){
	if(typeof tokenId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(tokenId))
		throw new Error(`invalid NFTokenID: ${tokenId}`)

	let flags = parseInt(tokenId.slice(0, 4), 16)
	let transferFee = parseInt(tokenId.slice(4, 8), 16)
	let issuer = encodeAccountID(Buffer.from(tokenId.slice(8, 48), 'hex'))
	let scrambledTaxon = BigInt('0x' + tokenId.slice(48, 56))
	let serial = BigInt('0x' + tokenId.slice(56, 64))

	let taxon = Number(
		(scrambledTaxon ^ ((384160001n * serial + 2459n) % UINT32)) % UINT32
	)

	return {
		flags,
		transferFee,
		issuer,
		taxon,
		serial: Number(serial)
	}
}
