import { expect } from 'chai'
import { decodeAccountID } from 'ripple-address-codec'
import { decodeNFTokenId } from '../../src/xrpl/nftoken.js'


// Build a synthetic NFTokenID from known components (applying the same XOR cipher
// rippled uses) so the decode — especially the taxon unscramble — is self-checking.
function buildNFTokenId({ flags, transferFee, issuer, taxon, serial }){
	let scrambled = (BigInt(taxon) ^ ((384160001n * BigInt(serial) + 2459n) % 4294967296n)) % 4294967296n

	let hex =
		flags.toString(16).padStart(4, '0') +
		transferFee.toString(16).padStart(4, '0') +
		Buffer.from(decodeAccountID(issuer)).toString('hex') +
		scrambled.toString(16).padStart(8, '0') +
		serial.toString(16).padStart(8, '0')

	return hex.toUpperCase()
}


describe(
	'decodeNFTokenId',
	() => {
		const ISSUER = 'rMrCiKUV4wUNXYJvZn2zQwd7BkSim2JJ3A'

		it(
			'round-trips flags / fee / issuer / taxon / serial (incl. taxon unscramble)',
			() => {
				let id = buildNFTokenId({ flags: 8, transferFee: 314, issuer: ISSUER, taxon: 1337, serial: 42 })
				let decoded = decodeNFTokenId(id)

				expect(decoded.flags).to.equal(8)
				expect(decoded.transferFee).to.equal(314)
				expect(decoded.issuer).to.equal(ISSUER)
				expect(decoded.taxon).to.equal(1337)
				expect(decoded.serial).to.equal(42)
			}
		)

		it(
			'unscrambles taxon 0 correctly across serials',
			() => {
				for(let serial of [0, 1, 2, 999999]){
					let id = buildNFTokenId({ flags: 0, transferFee: 0, issuer: ISSUER, taxon: 0, serial })
					expect(decodeNFTokenId(id).taxon, `serial ${serial}`).to.equal(0)
				}
			}
		)

		it(
			'handles a max-value taxon without overflow',
			() => {
				let id = buildNFTokenId({ flags: 0, transferFee: 0, issuer: ISSUER, taxon: 4294967295, serial: 7 })
				expect(decodeNFTokenId(id).taxon).to.equal(4294967295)
			}
		)

		it(
			'rejects malformed ids',
			() => {
				expect(() => decodeNFTokenId('nothex')).to.throw()
				expect(() => decodeNFTokenId('00'.repeat(10))).to.throw()
			}
		)
	}
)
