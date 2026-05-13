import fs from 'fs'
import BetterSQLite3 from 'better-sqlite3'
import InternalSQLError from '../errors/internal-sql.js'


export default function createAdapter({ file, journalMode, timeout = 10000, readonly = false }){
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
			return createAdapter({ file, journalMode, readonly, ...overrides })
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
	
				if(ret instanceof Promise){
					ret
						.then(ret => {
							connection.exec('COMMIT')
						})
						.catch(error => {
							throw error
						})
				}else{
					connection.exec('COMMIT')
				}
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