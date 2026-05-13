import fs from 'fs'
import { Database } from 'bun:sqlite'
import InternalSQLError from '../errors/internal-sql.js'


export default function createAdapter({ file, journalMode, timeout = 10000, readonly = false }){
	let connection
	let blank = !fs.existsSync(file)

	try{
		connection = new Database(file, readonly ? { readonly: true } : undefined)

		if(journalMode){
			connection.exec(`PRAGMA journal_mode = ${journalMode}`)
		}
	}catch(error){
		if(connection)
			connection.close()

		throw error
	}

	function prepare(sql){
		try{
			return connection.prepare(sql)
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
			throw new Error('database backup is not implemented for the bun adapter')
		},

		close(){
			connection.close()
		},

		compact(){
			connection.exec('PRAGMA wal_checkpoint(TRUNCATE)')
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
				affectedRows: prepare(text)
					.all(...values)
					.changes
			}
		},

		get({ text, values }){
			return prepare(text)
				.get(values)
		},
	
		all({ text, values }){
			return prepare(text)
				.all(values)
		},

		iter({ text, values }){
			return prepare(text)
				.iterate(values)
		},
	}
}