export default {
	acceptsType: 'string',
	acceptsFormat: 'hex',
	acceptsNull: true,
	returnsType: 'blob',
	returnsNull: true,
	
	encode(data){
		return data ? Buffer.from(data, 'hex') : data
	},

	decode(data){
		return data ? data.toString('hex').toUpperCase() : data
	}
}