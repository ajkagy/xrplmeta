import { expect } from 'chai'
import { isHostPublic, validate } from '../../src/lib/url.js'


describe(
	'SSRF host validation',
	() => {
		it(
			'rejects private/loopback/metadata IP literals',
			async () => {
				for(let host of [
					'127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1',
					'100.64.1.1', '100.127.255.1',            // CGNAT (RFC 6598)
					'[64:ff9b::7f00:1]', '[2002:7f00:1::]'    // NAT64 / 6to4 embedding 127.0.0.1
				]){
					expect(await isHostPublic(host.replace(/[\[\]]/g, '')), host).to.equal(false)
				}
			}
		)

		it(
			'rejects hostnames that resolve to loopback (DNS-rebinding guard)',
			async () => {
				// localhost resolves to a loopback address; the textual validate() would
				// not catch a resolved-to-private hostname, but isHostPublic does.
				expect(await isHostPublic('localhost')).to.equal(false)
			}
		)

		it(
			'validate() still blocks obvious unsafe URLs textually',
			() => {
				expect(validate('http://127.0.0.1/x')).to.equal(false)
				expect(validate('http://localhost/x')).to.equal(false)
				expect(validate('ftp://example.org')).to.equal(false)
				expect(validate('https://example.org')).to.equal(true)
			}
		)
	}
)
