export default {
	accepts: schema => schema.enum,
	returnsType: 'integer',
	returnsNull: true,
	
	encode(data, schema){
		if(data === null || data === undefined)
			return null

		let index = schema.enum.indexOf(data)

		if(index === -1)
			throw new RangeError(`Value "${data}" lies outside of enum [${schema.enum}]`)

		return index
	},

	decode(data, schema){
		if(data == null)
			return null

		return schema.enum[data]
	}
}