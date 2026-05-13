import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import createStructDB from '../../vendor/structdb/index.js'


describe('structdb auto-migrate', () => {
	let dataDir

	beforeEach(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrplmeta-automigrate-'))
	})

	function schemaFor(extra){
		return {
			type: 'object',
			properties: {
				widgets: { type: 'array', items: { $ref: '#/definitions/Widget' } }
			},
			definitions: {
				Widget: {
					type: 'object',
					properties: {
						id: { type: 'integer', id: true },
						name: { type: 'string' },
						...(extra || {})
					},
					required: ['name']
				}
			}
		}
	}

	it('adds a new column to an existing table without dropping data', async () => {
		let file = path.join(dataDir, 'test.db')

		let oldDb = await createStructDB({ file, schema: schemaFor() })
		oldDb.widgets.createOne({ data: { name: 'first' } })
		oldDb.widgets.createOne({ data: { name: 'second' } })
		oldDb.close()

		let newDb = await createStructDB({
			file,
			schema: schemaFor({ color: { type: 'string', default: 'red' } })
		})

		// Existing rows survived and have the default for the new column
		let rows = newDb.widgets.readMany({})
		expect(rows.length).to.equal(2)
		expect(rows.find(r => r.name === 'first').color).to.equal('red')
		expect(rows.find(r => r.name === 'second').color).to.equal('red')

		// New writes can specify the new column
		newDb.widgets.createOne({ data: { name: 'third', color: 'blue' } })
		let third = newDb.widgets.readOne({ where: { name: 'third' } })
		expect(third.color).to.equal('blue')

		newDb.close()
	})

	it('idempotent: opening with the same schema twice is a no-op', async () => {
		let file = path.join(dataDir, 'test.db')
		let schema = schemaFor()

		let db1 = await createStructDB({ file, schema })
		db1.widgets.createOne({ data: { name: 'A' } })
		db1.close()

		let db2 = await createStructDB({ file, schema })
		let rows = db2.widgets.readMany({})
		expect(rows.length).to.equal(1)
		expect(rows[0].name).to.equal('A')
		db2.close()
	})
})
