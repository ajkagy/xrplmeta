import log from '../../lib/log.js'
import { parse as parseXLS26 } from '../../../vendor/xls26/xls26.js'
import { scheduleGlobal } from '../schedule.js'
import { createFetch } from '../../lib/fetch.js'
import { diffMultiAccountProps, diffMultiTokenProps } from '../../db/helpers/props.js'
import { currencyUTF8ToHex } from '../../xrpl/tokens.js'
import { issuerFromMPTIssuanceId } from '../../xrpl/mpt.js'
import { withSyncOp } from '../../lib/health.js'
import TokenType from '../../xrpl/tokentype.js'

export default async function({ ctx }){
	let configs = ctx.config.trustlist

	if(!configs || configs.length == 0){
		throw new Error(`disabled by config`)
	}

	await Promise.all(
		configs
			.filter(config => !config.disabled)
			.map(config => crawlList({ ctx, ...config }))
	)
}

async function crawlList({ ctx, id, url, fetchInterval = 600, trustLevel = 0, ignoreAdvisories = false }){
	let fetch = createFetch({
		baseUrl: url
	})

	while(true){
		await scheduleGlobal({
			ctx,
			task: `trustlist.${id}`,
			interval: fetchInterval,
			routine: async () => {
				log.info(`reading ${url}`)

				let tokens = []
				let accounts = []

				let res = await fetch()
				let { status, data } = res

				if(status !== 200){
					throw new Error(`${url}: HTTP ${status}`)
				}

				// Only reject genuinely-missing bodies. Buffer is fine — xls26.parse()
				// coerces it. Strings are obviously fine.
				if(data == null){
					let bodyErr = res.bodyError
					throw new Error(`${url}: empty/missing response body${bodyErr ? ` (body read error: ${bodyErr.message})` : ''}`)
				}

				try{
					// parseXLS26 is fully synchronous; large trustlists (xrplmeta tokens.toml
					// has thousands of stanzas) and malformed files that fall through to the
					// stanza-isolation repair stage can block the loop for seconds.
					let size = data?.length ?? 0
					var { issuers: declaredIssuers, tokens: declaredTokens, issues, advisories, repairs } = withSyncOp(
						`crawler.trustlist.${id}.parseXLS26(len=${size})`,
						() => parseXLS26(data)
					)
				}catch(error){
					log.debug(`trustlist [${id}] parse error: ${error?.message}`)
					if(data && data.length > 0){
						let preview = Buffer.isBuffer(data) ? data.toString('utf8', 0, 200) : String(data).slice(0, 200)
						log.debug(`trustlist [${id}] first 200 chars: ${preview}`)
					}
					throw error
				}

				if(repairs && repairs.length > 0){
					log.info(`trustlist [${id}] auto-repaired: ${repairs.length} fix(es) applied`)
					for(let r of repairs)
						log.debug(`  trustlist [${id}] repair: ${r}`)
				}

				if(issues.length > 0){
					log.debug(`trustlist [${id}] has ${issues.length} field issue(s):`)
					for(let issue of issues)
						log.debug(`  - ${issue}`)
				}
				
				for(let { address, ...props } of declaredIssuers){
					if(props.hasOwnProperty('trust_level'))
						props.trust_level = Math.min(props.trust_level, trustLevel)

					accounts.push({
						address,
						props
					})
				}

				for(let { currency, issuer, mpt_issuance_id, ...props } of declaredTokens){
					if(props.hasOwnProperty('trust_level'))
						props.trust_level = Math.min(props.trust_level, trustLevel)

					tokens.push({
						currency: mpt_issuance_id == null ? currencyUTF8ToHex(currency) : null,
						issuer: {
							address: mpt_issuance_id == null ? issuer : issuerFromMPTIssuanceId(mpt_issuance_id)
						},
						mptIssuanceId: mpt_issuance_id,
						tokenType: mpt_issuance_id == null ? TokenType.IOU : TokenType.MPT,
						props
					})
				}

				let advisoryUpdates = 0

				if(!ignoreAdvisories && trustLevel > 0){
					let groupedAdvisories = {}

					for(let { address, ...props } of advisories){
						if(!groupedAdvisories[address])
							groupedAdvisories[address] = []

						groupedAdvisories[address].push(props)
					}

					for(let [address, advisories] of Object.entries(groupedAdvisories)){
						advisoryUpdates++
						accounts.push({
							address,
							props: {
								advisories
							}
						})
					}
				}
				
				diffMultiAccountProps({
					ctx,
					accounts,
					source: `trustlist/${id}`
				})

				diffMultiTokenProps({
					ctx,
					tokens,
					source: `trustlist/${id}`
				})

				log.info(`trustlist [${id}] synced (issuers: ${declaredIssuers.length}, tokens: ${tokens.length}, advisories: ${advisoryUpdates}${issues.length > 0 ? `, field issues: ${issues.length}` : ''})`)
			}
		})
	}
}