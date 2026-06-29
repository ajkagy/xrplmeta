import { expect } from 'chai'
import { fromString, toString } from '../../vendor/xfl/conversion/string.js'


describe(
	'XFL string conversion',
	() => {
		it(
			'parses leading-dot decimals without throwing',
			() => {
				expect(toString(fromString('.5'))).to.equal('0.5')
				expect(toString(fromString('-.5'))).to.equal('-0.5')
				expect(toString(fromString('0.5'))).to.equal('0.5')
			}
		)

		it(
			'still rejects a bare "." (empty mantissa)',
			() => {
				expect(() => fromString('.')).to.throw()
			}
		)

		it(
			'preserves sign of negative values on exponent underflow (clamp branch)',
			() => {
				expect(toString(fromString('-1e-120')).startsWith('-')).to.equal(true)
				expect(toString(fromString('-5e-110')).startsWith('-')).to.equal(true)
			}
		)

		it(
			'preserves sign of negative values on exponent overflow (clamp branch)',
			() => {
				expect(toString(fromString('-1e100')).startsWith('-')).to.equal(true)
			}
		)

		it(
			'round-trips ordinary signed decimals',
			() => {
				for(let s of ['1', '-1', '123.456', '-123.456', '0.0001', '-0.0001']){
					expect(toString(fromString(s))).to.equal(s)
				}
			}
		)
	}
)
