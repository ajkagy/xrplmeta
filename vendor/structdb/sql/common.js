export function stringifyValue(value){
	if(typeof value === 'bigint')
		return value.toString()
	else
		return JSON.stringify(value)
}