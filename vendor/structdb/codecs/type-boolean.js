export default {
	acceptsType: 'boolean',
	returnsType: 'integer',
	
	encode(data){
		return data ? 1 : 0
	},

	decode(data){
		return !!data
	}
}