import log from '../../../src/lib/log.js'
import { parse as parseXLS26 } from '../../../vendor/xls26/xls26.js'
import { createFetch } from '../../../src/lib/fetch.js'
import { fetchToml } from '../../../src/crawl/crawlers/domains.js'


export default async ({ config, args }) => {
	let domain = args._[1]
	let fetch = createFetch()

	if(!domain)
		throw new Error(`no domain provided. use: npm livetest toml.read [domain]`)

	let xls26 = await fetchToml({ domain, fetch })

	log.info(`parsed xls26:\n`, xls26)
}