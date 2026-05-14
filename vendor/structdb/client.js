import { generate as generateStruct } from './struct.js'
import { construct as constructTables } from './construction.js'
import { create as createModel } from './model/index.js'
import databaseCodecs from './codecs/index.js'


// Per-file in-progress construction lock. Many workers calling openDB() in
// parallel at startup all want to run CREATE TABLE / ALTER / CREATE INDEX on
// the same file — they'd otherwise serialize on SQLite's write lock for
// ~150 statements × N connections, causing 20+ second event-loop stalls.
//
// This map holds the Promise of an IN-PROGRESS construction; subsequent
// openers during that window await the same Promise instead of re-running
// the statements. The lock is released the moment construction finishes,
// so a later open() in the same process (e.g. after close+reopen, including
// the auto-migrate test) still runs construction normally.
const inProgressConstructions = new Map()


export async function createStructDB({ file, schema, codecs = [], ...options }){
	let { default: createAdapter } = process.versions.bun
		? await import('./adapters/bun.js')
		: await import('./adapters/better-sqlite3.js')

	let { struct, tables } = generateStruct({ schema, codecs: [...databaseCodecs, ...codecs] })
	let database = createAdapter({ file, ...options })
	let models = {}

	if(!options.readOnly){
		// In-memory databases are unique per instance — each :memory: file is a
		// fresh, isolated database. Always construct.
		let isInMemory = !file || file === ':memory:'
		if(isInMemory){
			constructTables({ database, tables })
		}else{
			let inProgress = inProgressConstructions.get(file)
			if(inProgress){
				// Another opener is currently running construction on this file —
				// wait for them to finish. Their CREATE TABLE / ALTER statements
				// are visible to our connection via SQLite's shared schema cache.
				await inProgress
			}else{
				// First concurrent opener — set the lock BEFORE running construct,
				// then yield once (via setImmediate) so any concurrent openers see
				// the lock. After construct returns, clear the lock so a *later*
				// open (e.g. after this DB has been closed and reopened) can run
				// migrations on a changed schema.
				let resolveLock
				let lock = new Promise(r => { resolveLock = r })
				inProgressConstructions.set(file, lock)

				try{
					await new Promise(resolve => setImmediate(resolve))
					constructTables({ database, tables })
				}finally{
					inProgressConstructions.delete(file)
					resolveLock()
				}
			}
		}
	}

	for(let [key, node] of Object.entries(struct.nodes)){
		models[key] = createModel({ database, struct: node })
	}

	return {
		file,
		database,
		...models,

		loadExtension(path){
			return database.loadExtension(path)
		},

		close(){
			database.close()
		},

		compact(){
			database.compact()
		},

		tx(executor){
			return database.tx(executor)
		},
	}
}
