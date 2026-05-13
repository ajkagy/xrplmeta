export default {
	acceptsType: 'array',
	returnsType: 'string',
	returnsNull: true,
	
	encode(data){
		if(data === null || data === undefined)
			return null

		if(!Array.isArray(data))
			throw new Error(`Value must be an array.`)

		return JSON.stringify(data)
	},

	decode(data){
		if(!data)
			return null

		return JSON.parse(data)
	}
}