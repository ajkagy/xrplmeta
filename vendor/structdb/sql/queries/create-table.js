import { stringifyValue } from '../common.js'


export default function({ name, fields, foreigns }){
	return [
		{
			text: `CREATE TABLE IF NOT EXISTS "${name}"`
		},
		{
			text: `(%)`,
			join: `, `,
			items: [
				...fields.map(field => [
					`"${field.name}"`,
					field.type,
					field.notNull ? `NOT NULL` : null,
					field.primary ? `PRIMARY KEY` : null,
					field.autoincrement ? `AUTOINCREMENT` : null,
					field.default !== undefined ? `DEFAULT ${stringifyValue(field.default)}` : null,
				]),
				...foreigns.map(foreign => [
					`FOREIGN KEY("${foreign.key}")`,
					`REFERENCES`,
					`"${foreign.table}"("${foreign.references}")`,
					`ON UPDATE CASCADE`,
					`ON DELETE CASCADE`
				])
			]
		}
	]
}