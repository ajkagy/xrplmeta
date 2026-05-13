export default function({ table, tableAlias, where, limit }){
	return [
		{
			text: tableAlias
				? `DELETE FROM "${table}" AS "${tableAlias}"`
				: `DELETE FROM "${table}"`
		},
		{
			text: `WHERE %`,
			items: where.items.length > 0
				? [where]
				: ['1']
		},
		limit 
			? {text: `LIMIT ?`, values: [limit]} 
			: null
	]
}