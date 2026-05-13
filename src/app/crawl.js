import log from '../lib/log.js'
import { spawn } from '../lib/workers.js'
import { openDB } from '../db/index.js'
import { startCrawlers } from '../crawl/init.js'


export async function run({ ctx }){
	await spawn(':runCrawl', { ctx })
}


export async function runCrawl({ ctx }){
	if(ctx.log)
		log.pipe(ctx.log)

	log.info('starting crawlers')

	return await startCrawlers({
		ctx: {
			...ctx,
			db: await openDB({ ctx })
		}
	})
}