import log from '../../lib/log.js'
import { parse as parseXLS26 } from '../../../vendor/xls26/xls26.js'
import { parse as parseURL } from 'url'
import { sanitize as sanitizeURL } from '../../lib/url.js'
import { scheduleIterator } from '../schedule.js'
import { createFetch } from '../../lib/fetch.js'
import { clearAccountProps, clearTokenProps, readAccountProps, writeAccountProps, writeTokenProps } from '../../db/helpers/props.js'
import { currencyUTF8ToHex } from '../../xrpl/tokens.js'
import { reduceProps } from '../../srv/procedures/token.js'
import { withSyncOp } from '../../lib/health.js'
import TokenType from '../../xrpl/tokentype.js'


const tomlStandardPath = '.well-known/xrp-ledger.toml'


export default async function({ ctx }){
	let config = ctx.config.tomls

	if(!config || config.disabled){
		throw new Error(`disabled by config`)
	}
	
	let fetch = createFetch({
		timeout: config.connectionTimeout || 20,
		// Issuer domains are fully attacker-controlled (anyone can issue a token and
		// set its domain), so the SSRF guard in lib/url.js must run on the initial
		// URL and every redirect hop. (Note: this blocks IP-literal hosts; a hostname
		// that DNS-resolves to a private IP is a separate, deeper mitigation.)
		validateUrls: true
	})

	while(true){
		await scheduleIterator({
			ctx,
			type: 'issuer',
			task: 'domains',
			where: {
                tokenType: TokenType.IOU
            },
			interval: config.fetchInterval,
			concurrency: 3,
			routine: async ({ id, address }, remaining) => {
				let { domain } = reduceProps({
					props: readAccountProps({ 
						ctx, 
						account: { id } 
					}),
					sourceRanking: [
						'trustlist',
						'ledger',
						'issuer/domain',
						'xaman',
						'bithomp',
						'xrpscan',
						'x'
					]
				})

				if(domain){
					try{
						var xls26 = await fetchToml({ domain, fetch })
					}catch(error){
						log.debug(`issuer (${address}): ${error.message}`)
						return
					}finally{
						log.accumulate.info({
							text: [`%xrplTomlLookups xrp-ledger.toml lookups in %time (${remaining} remaining)`],
							data: {
								xrplTomlLookups: 1
							}
						})
					}

					let publishedIssuers = 0
					let publishedTokens = 0
					
					for(let { address: issuer, ...props } of xls26.issuers){
						if(issuer !== address)
							continue

						delete props.trust_level

						writeAccountProps({
							ctx,
							account: {
								address: issuer
							},
							props,
							source: `issuer/domain/${address}`
						})

						publishedIssuers++
					}

					for(let { currency, issuer, ...props } of xls26.tokens){
						if(issuer !== address)
							continue

						delete props.trust_level

						writeTokenProps({
							ctx,
							token: {
								currency: currencyUTF8ToHex(currency),
								issuer: {
									address: issuer
								},
								tokenType: TokenType.IOU
							},
							props,
							source: `issuer/domain/${address}`
						})

						publishedTokens++
					}

					log.debug(`issuer (${address}) valid xls26:`, xls26)

					if(publishedIssuers || publishedTokens){
						log.accumulate.info({
							text: [`%domainIssuersUpdated issuers and %domainTokensUpdated tokens updated in %time`],
							data: {
								domainIssuersUpdated: publishedIssuers,
								domainTokensUpdated: publishedTokens,
							}
						})
					}
				}else{
					clearAccountProps({
						ctx,
						account: { id },
						source: `issuer/domain/${address}`
					})

					for(let token of ctx.db.core.tokens.readMany({ 
						where: {
							issuer: { id }
						}
					})){
						clearTokenProps({
							ctx,
							token,
							source: `issuer/domain/${address}`
						})
					}
				}
			}
		})
	}
}

export async function fetchToml({ domain, fetch }){
	let { protocol, host, pathname } = parseURL(domain)

	if(protocol && protocol !== 'https:' && protocol !== 'http:')
		throw new Error(`unsupported protocol: ${domain}`)

	if(!host)
		host = ''

	if(!pathname)
		pathname = ''

	let tomlUrls = (protocol ? [protocol] : ['https:', 'http:'])
		.map(protocol => `${protocol}//${host}${pathname}/${tomlStandardPath}`)
		.map(sanitizeURL)

	for(let tomlUrl of tomlUrls){
		log.debug(`fetching ${tomlUrl}`)

		try{
			let { status, data } = await fetch(tomlUrl)

			if(status !== 200)
				throw new Error(`HTTP ${status}`)

			// parseXLS26 is fully synchronous and can be expensive on malformed
			// inputs that fall through to the stanza-isolation repair stage
			// (re-parses each [[Section]] block up to 4 times). Wrap it so any
			// long stall here gets attributed in the lag-monitor log line.
			let size = data?.length ?? 0
			return withSyncOp(`crawler.domains.parseXLS26(${tomlUrl}, len=${size})`, () => parseXLS26(data))
		}catch(error){
			log.debug(`failed ${tomlUrl}: ${error.message}`)

			if(error.message === 'HTTP 404' || tomlUrl === tomlUrls.at(-1))
				throw new Error(
					error.message.includes(tomlUrl)
						? error.message
						: `${tomlUrl} -> ${error.message}`
				)
		}
	}
}