import fs from 'fs'
import BetterSQLite3 from 'better-sqlite3'
import InternalSQLError from '../errors/internal-sql.js'


export default function createAdapter({ file, journalMode, timeout = 10000, readonly = false, readOnly = false }){
	// Pragma sizing only: the app opens its read-only connections with capital-O
	// `readOnly` (see src/db/index.js), which this adapter's `readonly` param never
	// saw — so those connections used to be sized like writers. Resolve the intent
	// here. We deliberately do NOT feed this into the BetterSQLite3 constructor:
	// flipping those connections to true SQLite read-only mode also changes
	// file-creation semantics, which is a separate, independently-tested change.
	let readOnlyIntent = readonly || readOnly
	let connection
	let blank = !fs.existsSync(file)
	let statementCache = {}

	try{
		connection = new BetterSQLite3(file, {
			timeout,
			readonly
		})

		connection.defaultSafeIntegers(true)
		connection.unsafeMode(true)

		if(journalMode){
			connection.pragma(`journal_mode = ${journalMode}`)
		}

		// --- Performance pragmas -------------------------------------------------
		// Applied to every connection this adapter opens — including clone()s and
		// the in-process worker connections — because they all re-enter here.
		//
		// temp_store=MEMORY keeps ORDER BY / GROUP BY spill B-trees off disk.
		connection.pragma('temp_store = MEMORY')

		if(readOnlyIntent){
			// Read-only clones (API worker threads, per-iteration iter() clones,
			// the cache worker's core reader) run many-at-once inside ONE process,
			// so keep each cache small to bound RSS.
			connection.pragma('cache_size = -8192')          // 8 MiB
		}else{
			// synchronous=NORMAL is the SQLite-recommended pairing for WAL: it drops
			// the per-COMMIT fsync (the dominant per-ledger backfill cost on networked
			// disks) while staying crash-safe — on power loss at most the last
			// un-checkpointed transactions are lost (never corruption), and this
			// indexer re-derives any lost ledgers from the chain on restart.
			connection.pragma('synchronous = NORMAL')
			// The 2 MB default page cache thrashes on a multi-GB DB, re-faulting
			// interior/index pages every transaction and degrading as the DB grows.
			// 64 MiB holds the hot working set; raise it if the host has spare RAM.
			connection.pragma('cache_size = -65536')         // 64 MiB
			// Raise the auto-checkpoint threshold so the synchronous mid-commit
			// checkpoint runs less often and amortized; kept as a backstop so the
			// WAL stays bounded even if nothing else drives a checkpoint.
			connection.pragma('wal_autocheckpoint = 10000')  // ~40 MB
		}
	}catch(error){
		if(connection)
			connection.close()

		throw error
	}

	function prepare(sql, useCache){
		if(useCache){
			let cached = statementCache[sql]

			if(cached)
				return cached
		}

		try{
			return statementCache[sql] = connection.prepare(sql)
		}catch(error){
			throw new InternalSQLError({
				message: error.message,
				sql
			})
		}
	}

	return {
		get blank(){
			return blank
		},

		loadExtension(path){
			return connection.loadExtension(path)
		},

		clone(overrides = {}){
			// Forward the resolved read-only intent so clones inherit the right cache
			// sizing; an explicit override in `overrides` still wins.
			return createAdapter({ file, journalMode, readonly: readOnlyIntent, ...overrides })
		},

		backup({ destinationFile, lockDatabase, progress }){
			let promise = connection.backup(destinationFile, {
				progress: ({ totalPages, remainingPages }) => {
					progress(1 - remainingPages / totalPages)
				}
			})

			if(lockDatabase){
				let lockConnection = new DatabaseAdapter(file, { timeout })

				lockConnection.exec('BEGIN EXCLUSIVE')

				promise.finally(
					() => {
						lockConnection.exec('ROLLBACK')
						lockConnection.close()
					}
				)
			}

			return promise
		},

		close(){
			connection.close()
		},

		compact(){
			connection.pragma('wal_checkpoint(TRUNCATE)')
		},

		tx(executor){
			if(connection.inTransaction)
				return executor()
	
			connection.exec('BEGIN IMMEDIATE')
			
			try{
				var ret = executor()

				// Async executors are unsupported: better-sqlite3 is synchronous, so a
				// returned Promise would COMMIT here before the async work settled —
				// leaving the transaction open across the event loop and turning any
				// rejection into an unhandled one. Fail loudly instead of corrupting state.
				if(ret instanceof Promise)
					throw new Error(`structdb tx() executor must be synchronous — it returned a Promise`)

				connection.exec('COMMIT')
			}catch(error){
				connection.exec('ROLLBACK')

				if(error.stack)
					error.stack = `${error.stack}\n\n[[The error occured inside a transaction, which was rolled back]]\n`
					
				throw error
			}
	
			return ret
		},
	
		run({ text, values }){
			return {
				affectedRows: prepare(text, true)
					.run(values)
					.changes
			}
		},

		get({ text, values }){
			return prepare(text, true)
				.get(values)
		},
	
		all({ text, values }){
			return prepare(text, true)
				.all(values)
		},

		iter({ text, values }){
			return prepare(text, false)
				.iterate(values)
		},
	}
}