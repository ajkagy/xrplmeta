export default function({ table, tableAlias, data, where, limit }){
	return [
		{
			text: tableAlias
				? `UPDATE "${table}" AS "${tableAlias}"`
				: `UPDATE "${table}"`
		},
		{
			text: `SET %`,
			join: `, `,
			items: Object.entries(data)
				.map(([key, value]) => ({
					text: `"${key}" = ?`,
					values: [value]
				})),
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