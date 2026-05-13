import commonCodecs from './common/index.js'


export function create({ schema, codecs }){
	let fieldEncoders = {}
	let fieldDecoders = {}

	for(let [key, prop] of Object.entries(schema.properties)){
		let def = select({ schema: prop, codecs: [...commonCodecs, ...codecs] })

		if(!def)
			continue

		fieldEncoders[key] = value => def.encode(value, prop)
		fieldDecoders[key] = value => def.decode(value, prop)
	}

	return {
		encode(data){
			let encoded = { ...data }

			for(let [k, v] of Object.entries(data)){
				if(k in fieldEncoders)
					encoded[k] = fieldEncoders[k](v)
			}

			return encoded
		},

		encodeField(key, data){
			return fieldEncoders[key]
				? fieldEncoders[key](data)
				: data
		},

		decode(data){
			let decoded = { ...data }

			for(let [k, v] of Object.entries(data)){
				if(k in fieldDecoders)
					decoded[k] = fieldDecoders[k](v)
			}

			return decoded
		},

		decodeField(key, data){
			return fieldDecoders[key]
				? fieldDecoders[key](data)
				: data
		},
	}
}

export function select({ schema, codecs }){
	return codecs.find(codec => {
		if(codec.accepts && !codec.accepts(schema))
			return false

		if(codec.acceptsType && codec.acceptsType !== schema.type)
			return false

		if(codec.acceptsFormat && codec.acceptsFormat !== schema.format)
			return false

		return true
	})
}