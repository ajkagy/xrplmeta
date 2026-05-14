import log from '../lib/log.js'
import { run as runLedgerApp } from './ledger.js'
import { run as runCrawlApp } from './crawl.js'
import { run as runCacheApp } from './cache.js'
import { run as runServerApp } from './server.js'
import createIPC from '../lib/ipc.js'


function fatal(message, error){
	log.error(message)

	// Surface every dimension of the error so the pm2 error log is actionable.
	if(error){
		if(error instanceof Error){
			log.error(`  message: ${error.message}`)
			if(error.code) log.error(`  code: ${error.code}`)
			if(error.cause) log.error(`  cause: ${error.cause?.message || error.cause}`)
			if(error.stack) log.error(`  stack:\n${error.stack}`)
		}else if(typeof error === 'string'){
			log.error(`  ${error}`)
		}else{
			log.error(error)
		}
	}

	log.flush()

	// Give a moment for stdout/stderr to drain before pm2 sees the exit.
	setTimeout(() => process.exit(1), 200)
}

// Catch every escape hatch so pm2's error log is never empty when we restart.
process.on('uncaughtException', err => fatal('uncaughtException', err))
process.on('unhandledRejection', reason => fatal('unhandledRejection', reason))


export default async function({ config, args }){
	const ctx = {
		ipc: createIPC(),
		config,
		log,
	}


	if(!args['only-server']){
		await runLedgerApp({ ctx })
			.catch(error => fatal('ledger app crashed due to fatal error:', error))

		log.info(`bootstrap complete`)

		runCrawlApp({ ctx })
			.catch(error => {
				log.error(`crawl app crashed due to fatal error:`)
				log.error(error?.stack || error)
				log.warn(`attempting to continue without it`)
			})

		runCacheApp({ ctx })
			.catch(error => {
				log.error(`cache app crashed due to fatal error:`)
				log.error(error?.stack || error)
				log.warn(`attempting to continue without it`)
			})
	}

	runServerApp({ ctx })
		.catch(error => {
			log.error(`server app crashed:`)
			log.error(error?.stack || error)
			log.warn(`attempting to continue without it`)
		})


	return {
		async terminate(){
			log.info(`shutting down`)
			process.exit()
		}
	}
}
