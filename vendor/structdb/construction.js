import sql from './sql/index.js'


const typeMap = {
	"integer": "INTEGER",
	"string": "TEXT",
	"number": "REAL",
	"bigint": "INTEGER",
	"boolean": "INTEGER",
	"blob": "BLOB",
	"any": "TEXT"
}


export function construct({ database, tables }){
	for(let schema of tables){
		constructTable({ database, schema })
	}
}

function constructTable({ database, schema }){
	database.run(
		sql.createTable({
			name: schema.name,
			foreigns: Object.entries(schema.foreign)
				.map(([key, foreign]) => ({
					key,
					table: foreign.name,
					references: foreign.idKey
				})),
			fields: Object.values(schema.fields)
				.map(field => {
					let { key, type, required, id, default: defaultValue } = field
					let foreign = schema.foreign[key]

					return {
						name: key,
						primary: !!id,
						type: typeMap[type],
						autoincrement: id && type === 'integer' && !defaultValue && !required,
						default: defaultValue,
						notNull: defaultValue !== undefined || required,
					}
				})
		})
	)

	for(let { name, unique, fields } of schema.indices){
		database.run(
			sql.createIndex({
				name,
				table: schema.name,
				unique,
				fields: fields.map(field => {
					if(field.endsWith(':asc'))
						return {
							key: field.slice(0, -4),
							order: 'asc'
						}
					else if(field.endsWith(':desc'))
						return {
							key: field.slice(0, -5),
							order: 'desc'
						}
					else
						return {
							key: field
						}
				})
			})
		)
	}
}