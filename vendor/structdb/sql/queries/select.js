export default function({ fields, distinct, count, table, tableAlias, where, joins, orderBy, groupBy, limit, offset }){
	let selection
	let limitation

	if(count && distinct){
		selection = {
			text: `COUNT(DISTINCT %)`,
			join: `, `,
			items: distinct
				.map(formatField)
		}
	}else if(count){
		selection = {
			text: `COUNT(1)`
		}
	}else if(distinct){
		selection = {
			text: `DISTINCT %`,
			join: `, `,
			items: distinct
				.map(formatField)
		}
	}else if(fields){
		selection = {
			text: `%`,
			join: `, `,
			items: fields
				.map(formatField)
		}
	}else{
		selection = {
			text: `*`
		}
	}

	if(orderBy){
		orderBy = {
			text: `ORDER BY %`,
			join: `, `,
			items: Object.entries(orderBy)
				.map(([key, dir]) => `"${key}" ${dir}`)
		}
	}

	if(groupBy){
		groupBy = {
			text: `GROUP BY %`,
			join: `, `,
			items: groupBy
				.map(key => `"${key}"`)
		}
	}

	if(limit || offset){
		limitation = {
			text: `LIMIT ?, ?`,
			values: [
				offset || 0,
				limit
			]
		}
	}

	joins = (joins || [])
		.map(formatJoin)

	return [
		{
			text: `SELECT`
		},
		selection,
		{
			text: tableAlias
				? `FROM "${table}" AS "${tableAlias}"`
				: `FROM "${table}"`
		},
		...joins,
		{
			text: `WHERE %`,
			items: where?.items?.length
				? [where]
				: ['1']
		},
		groupBy,
		orderBy,
		limitation
	]
}

function formatField(field){
	if(field === '*')
		return '*'

	if(typeof field === 'string')
		field = { name: field }

	let key = field.table
			? `"${field.table}"."${field.name}"`
			: `"${field.name}"`

	return [
		field.function
			? `${field.function}(${key})`
			: key,
		field.nameAlias
			? `AS "${field.nameAlias}"`
			: null
	]
}

function formatJoin(join){
	return [
		`LEFT JOIN "${join.table}"`,
		join.tableAlias
			? `AS "${join.tableAlias}"`
			: null,
		{
			text: `ON (%)`,
			items: join.condition
		}
	]
}