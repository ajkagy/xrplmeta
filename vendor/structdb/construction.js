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

function tableExists({ database, name }){
	try{
		let rows = database.all({
			text: `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
			values: [name]
		})
		return rows.length > 0
	}catch{
		return false
	}
}

function existingColumns({ database, table }){
	try{
		let rows = database.all({
			text: `PRAGMA table_info("${table.replace(/"/g, '""')}")`,
			values: []
		})
		return new Set(rows.map(r => r.name))
	}catch{
		return new Set()
	}
}

// Add any columns declared in the schema that aren't already on the existing table.
// SQLite ADD COLUMN can't add PRIMARY KEY or UNIQUE constraints, but those are always
// part of the initial table create or live in separate CREATE INDEX statements — so
// nullable / defaulted fields work fine. We do NOT attempt to drop columns, change
// types, or alter PK/UNIQUE — those changes need a real migration.
function alterAddMissingColumns({ database, schema }){
	let existing = existingColumns({ database, table: schema.name })
	if(existing.size === 0) return  // table didn't exist; CREATE TABLE will handle it

	for(let field of Object.values(schema.fields)){
		if(existing.has(field.key)) continue
		if(field.id) continue  // can't add a primary key column post-hoc; skip silently

		let parts = [`ALTER TABLE "${schema.name.replace(/"/g, '""')}" ADD COLUMN "${field.key.replace(/"/g, '""')}" ${typeMap[field.type] || 'TEXT'}`]

		if(field.default !== undefined){
			let lit = typeof field.default === 'string'
				? `'${String(field.default).replace(/'/g, "''")}'`
				: field.default === true
					? '1'
					: field.default === false
						? '0'
						: String(field.default)
			parts.push(`DEFAULT ${lit}`)
		}

		if((field.default !== undefined || field.required) && !schema.foreign[field.key])
			parts.push('NOT NULL')

		try{
			database.run({ text: parts.join(' '), values: [] })
		}catch(e){
			// duplicate column race or unsupported add — leave it for an explicit migration
		}
	}
}

function constructTable({ database, schema }){
	let preexisted = tableExists({ database, name: schema.name })

	if(preexisted){
		alterAddMissingColumns({ database, schema })
	}else{
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
	}

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