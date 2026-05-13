import sql from '../../sql/index.js'
import { composeFilter } from '../common.js'


export function remove({ database, struct, where = {}, limit }){
	return database.run(
		sql.delete({
			table: struct.table.name,
			tableAlias: 'T',
			where: composeFilter({ where, struct }),
			limit
		})
	)
}