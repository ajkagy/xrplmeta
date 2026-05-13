export default function({ table, data }){
	return [
		{
			text: `INSERT INTO "${table}"`
		},
		{
			text: `(%)`,
			join: `, `,
			items: Object.keys(data)
				.map(key => `"${key}"`)
		},
		{
			text: `VALUES`
		},
		{
			text: `(%)`,
			join: `, `,
			items: Object.values(data)
				.map(value => ({ text: `?`, values: [value] }))
		},
		{
			text: `ON CONFLICT DO UPDATE SET`
		},
		{
			text: `%`,
			join: `, `,
			items: Object.keys(data)
				.map(key => `"${key}" = excluded."${key}"`)
		},
		{
			text: `RETURNING *`
		}
	]
}