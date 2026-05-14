import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import createStructDB from '../../vendor/structdb/index.js'
import log from '../lib/log.js'
import { markSyncOperation, endSyncOperation } from '../lib/health.js'
import codecs from './codecs/index.js'
import TokenType from '../xrpl/tokentype.js'


const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)


export async function openDB({ ctx, coreReadOnly=false, inMemory=false }){
	return {
		core: await openCoreDB({
			ctx,
			readOnly: coreReadOnly,
			inMemory
		}),
		cache: await openCacheDB({
			ctx,
			inMemory
		})
	}
}

async function timeStage(name, fn){
	markSyncOperation(name)
	let start = process.hrtime.bigint()
	try{
		return await fn()
	}finally{
		endSyncOperation()
		let ms = Number(process.hrtime.bigint() - start) / 1e6
		if(ms > 500)
			log.warn(`slow ${name} took ${ms.toFixed(0)}ms`)
	}
}

export async function openCoreDB({ ctx, readOnly=false, inMemory=false }){
	let db = await timeStage('openCoreDB.createStructDB', async () => createStructDB({
		file: inMemory
			? ':memory:'
			: `${ctx.config.node.dataDir}/core.db`,
		schema: JSON.parse(
			fs.readFileSync(
				path.join(__dirname, 'schemas/core.json')
			)
		),
		journalMode: 'WAL',
		timeout: 600000,
		debug: ctx.config.debug?.queries,
		codecs,
		readOnly
	}))

	await timeStage('openCoreDB.loadExtension', async () => {
		db.loadExtension(
			path.join(__dirname, '..', '..', 'deps', 'build', 'Release', 'sqlite-xfl.node')
		)
	})

	if(!readOnly){
		await timeStage('openCoreDB.createXRP', async () => {
			db.tokens.createOne({
				data: {
					currency: 'XRP',
					issuer: null,
					tokenType: TokenType.XRP
				}
			})
		})
	}

	return db
}

export async function openCacheDB({ ctx, inMemory=false }){
	return await timeStage('openCacheDB.createStructDB', async () => createStructDB({
		file: inMemory
			? ':memory:'
			: `${ctx.config.node.dataDir}/cache.db`,
		schema: JSON.parse(
			fs.readFileSync(
				path.join(__dirname, 'schemas/cache.json')
			)
		),
		journalMode: 'WAL',
		debug: ctx.config.debug?.queries,
		codecs
	}))
}