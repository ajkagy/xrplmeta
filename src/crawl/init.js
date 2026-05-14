import log from '../lib/log.js'
import { spawn } from '../lib/workers.js'
import { openDB } from '../db/index.js'
import crawlers from './crawlers/index.js'


export async function startCrawlers({ ctx }){
	if(ctx.config.crawl?.disabled){
		log.warn(`skipping all crawlers (disabled by config)`)
		return
	}

	for(let { name } of crawlers){
		spawn(':spawnCrawler', { ctx, name })
	}
}

export async function spawnCrawler({ ctx, name }){
	let { start } = crawlers.find(crawler => crawler.name === name)
	let crashed = false

	log.pipe(ctx.log)

	ctx = {
		...ctx,
		db: await openDB({ ctx })
	}

	start({ ctx })
		.catch(error => {
			log.warn(`skipping crawler [${name}]: ${error?.message || error}`)
			crashed = true
		})

	// Give the crawler 100ms to throw its initial "disabled by config" / auth /
	// connection error synchronously, so we can log a single tidy line.
	await new Promise(resolve => setTimeout(resolve, 100))

	if(!crashed){
		log.info(`started crawler [${name}]`)
	}
	// If it did crash, the warn line above is enough. Do NOT exit the process —
	// other crawlers, the ledger sync, and the server are all running in this
	// same node process. Killing it on a single crawler's startup failure would
	// (and did, previously) put pm2 into a restart loop.
}