// Migration runner. Each migration is { id, name, up({ db, log }) }.
// Migrations run after structdb has created/synchronised tables from the JSON schema,
// and are intended for additive changes that the JSON schema cannot express
// (data backfills, ALTER TABLE for fields we *cannot* express in JSON schema, etc.).
//
// Migration IDs are integers. Applied IDs are tracked in the SchemaMigration table.
// The set of migration files is the source of truth; the table records which have run.

import log from '../../lib/log.js'

// Add new migrations to this list in ID order. Never renumber existing entries.
const migrations = [
	// {
	//   id: 1,
	//   name: 'example',
	//   up: ({ db }) => db.prepare('CREATE INDEX IF NOT EXISTS ...').run()
	// }
]

export function runMigrations({ db, name = 'core' }){
	ensureMigrationTable({ db })

	let applied = new Set(
		db.prepare('SELECT id FROM SchemaMigration').all().map(r => r.id)
	)

	let ran = 0
	for(let migration of migrations){
		if(applied.has(migration.id))
			continue

		log.info(`[migrate:${name}] running #${migration.id} ${migration.name}`)

		let runTx = db.transaction(() => {
			migration.up({ db, log })
			db.prepare('INSERT INTO SchemaMigration (id, name, appliedAt) VALUES (?, ?, ?)')
				.run(migration.id, migration.name, Math.floor(Date.now() / 1000))
		})

		runTx()
		ran++
	}

	if(ran > 0)
		log.info(`[migrate:${name}] applied ${ran} migration(s)`)
}

function ensureMigrationTable({ db }){
	db.prepare(`
		CREATE TABLE IF NOT EXISTS SchemaMigration (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			appliedAt INTEGER NOT NULL
		)
	`).run()
}
