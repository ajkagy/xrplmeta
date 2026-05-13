import log from '../lib/log.js'
import { spawn } from '../lib/workers.js'
import { openDB } from '../db/index.js'
import { startServer } from '../srv/server.js'


export async function run({ ctx }){
	if(!ctx.config.server){
		log.warn(`config is missing [SERVER] stanza: disabling server`)
		return
	}

	await spawn(':runServer', { ctx })
}


export async function runServer({ ctx }){
	if(ctx.log)
		log.pipe(ctx.log)

	log.info('starting server')

	return await startServer({
		ctx: {
			...ctx,
			db: await openDB({ ctx })
		}
	})
}