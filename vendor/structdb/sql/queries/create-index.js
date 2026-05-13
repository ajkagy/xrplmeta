export default function({ name, table, unique, fields }){
	return [
		{
			text: `CREATE`
		},
		{
			text: unique ? `UNIQUE INDEX` : `INDEX`
		},
		{
			text: `IF NOT EXISTS`
		},
		{
			text: `"${name}" ON ${table}`
		},
		{
			text: `(%)`,
			join: `, `,
			items: fields.map(
				({ key, order }) => order
					? `"${key}" ${order}`
					: `"${key}"`
			)
		}
	]
}