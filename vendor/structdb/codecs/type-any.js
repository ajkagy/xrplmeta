export default {
	acceptsType: 'any',
	returnsType: 'string',
	returnsNull: true,
	
	encode(data){
		if(data === null || data === undefined)
			return null

		return JSON.stringify(data)
	},

	decode(data){
		if(!data)
			return null

		return JSON.parse(data)
	}
}