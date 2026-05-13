// Known-amendment baseline. Generated against rippled 3.1.x (May 2026 snapshot).
// On startup, the indexer queries `feature` on the connected node and warns about
// any enabled amendment that isn't in this list — that's the signal to update
// state/index.js handlers + the schema before they start producing wrong data.

import log from '../lib/log.js'

export const knownAmendments = new Set([
	'AMM',
	'AMMClawback',
	'Batch',
	'Clawback',
	'Credentials',
	'DID',
	'DeepFreeze',
	'DelegateV1',
	'DynamicMPT',
	'DynamicNFT',
	'Escrow',
	'ExpandedSignerList',
	'FeeEscalation',
	'fixAMMClawbackRounding',
	'fixDelegateV1_1',
	'fixIncludeKeyletFields',
	'fixMPTDeliveredAmount',
	'fixNFTokenPageLinks',
	'fixPriceOracleOrder',
	'fixTokenEscrowV1',
	'LendingProtocol',
	'MPTokensV1',
	'NFTokenMintOffer',
	'NegativeUNL',
	'NonFungibleTokensV1_1',
	'PermissionedDEX',
	'PermissionedDomains',
	'PriceOracle',
	'SingleAssetVault',
	'XChainBridge'
])

export async function checkLiveAmendments({ ctx }){
	try{
		let { result } = await ctx.xrpl.request({
			command: 'feature'
		})
		let features = result?.features
		if(!features) return

		let enabled = []
		for(let [id, info] of Object.entries(features)){
			if(info?.enabled){
				let name = info.name || id
				enabled.push(name)
			}
		}

		let unknown = enabled.filter(name => !knownAmendments.has(name))
		if(unknown.length > 0){
			log.warn(`live network has ${unknown.length} amendment(s) not in xrplmeta's baseline:`)
			for(let name of unknown){
				log.warn(`  - ${name}`)
			}
			log.warn(`Indexer may need updates to handle new ledger entry types or transaction types.`)
		}else{
			log.info(`live network amendments all match xrplmeta baseline`)
		}
	}catch(error){
		log.debug(`amendment baseline check failed: ${error.message}`)
	}
}
