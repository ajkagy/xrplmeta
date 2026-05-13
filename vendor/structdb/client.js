import { generate as generateStruct } from './struct.js'
import { construct as constructTables } from './construction.js'
import { create as createModel } from './model/index.js'
import databaseCodecs from './codecs/index.js'


export async function createStructDB({ file, schema, codecs = [], ...options }){
	let { default: createAdapter } = process.versions.bun
		? await import('./adapters/bun.js')
		: await import('./adapters/better-sqlite3.js')

	let { struct, tables } = generateStruct({ schema, codecs: [...databaseCodecs, ...codecs] })
	let database = createAdapter({ file, ...options })
	let models = {}

	if(database.blank){
		constructTables({ database, tables })
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