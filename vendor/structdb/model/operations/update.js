import sql from '../../sql/index.js'
import { read } from './read.js'
import { composeFilter } from '../common.js'


export function update({ database, struct, data: inputData, where, limit }){
	let tableData = {}

	for(let [key, value] of Object.entries(inputData)){
		let childConf = struct.nodes[key]
		let fieldConf = struct.table.fields[key]

		if(childConf && value){
			if(childConf.many){
				if(!Array.isArray(value)){
					throw new TypeError(`field "${key}" has to be an array, as defined in the schema`)
				}

				throw Error(`array updates not yet implemented`)
			}else{
				if(typeof value !== 'object'){
					throw new TypeError(`field "${key}" has to be a object, as defined in the schema`)
				}

				if(value[childConf.table.idKey] !== undefined && Object.keys(value).length !== 1){
					tableData[key] = value[childConf.table.idKey]
				}else{
					throw Error(`recursive updates not yet implemented`)
				}
			}
		}else if(fieldConf){
			tableData[key] = value
		}
	}

	database.run(
		sql.update({
			table: struct.table.name,
			tableAlias: 'T',
			data: struct.encode(tableData),
			where: composeFilter({ where, struct }),
			limit
		})
	)

	return read({
		database,
		struct,
		where: {
			...where,
			...inputData
		},
		include: inputData
	})
}


