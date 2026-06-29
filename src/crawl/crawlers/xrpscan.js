import log from '../../lib/log.js'
import { scheduleGlobal } from '../schedule.js'
import { createFetch } from '../../lib/fetch.js'
import { diffMultiAccountProps } from '../../db/helpers/props.js'


export default async function({ ctx }){
	let config = ctx.config.xrpscan

	if(!config || config.disabled){
		throw new Error(`disabled by config`)
	}
	
	let fetch = createFetch({
		baseUrl: 'https://api.xrpscan.com/api/v1'
	})

	while(true){
		await scheduleGlobal({
			ctx,
			task: 'xrpscan.well-known',
			interval: config.fetchInterval,
			routine: async () => {
				log.info(`fetching well-known list...`)

				let accounts = []
				let { data } = await fetch('names/well-known')

				if(!Array.isArray(data)){
					log.warn(`well-known list response was not an array (got ${typeof data}) — skipping this run`)
					return
				}

				log.info(`got`, data.length, `well known`)

				for(let entry of data){
					if(!entry || typeof entry !== 'object' || !entry.account)
						continue

					let { account, name, domain, twitter } = entry
					let urls = undefined

					if(twitter){
						urls = [{
							url: `https://x.com/${twitter}`,
							type: `social`
						}]
					}

					accounts.push({
						address: account,
						props: {
							name,
							domain,
							urls
						},
					})
				}

				await diffMultiAccountProps({
					ctx,
					accounts,
					source: 'xrpscan/well-known'
				})

				log.info(`updated`, accounts.length, `issuers`)
			}
		})
	}
}