// Informational amendment check.
//
// The indexer is designed to *gracefully* handle new ledger entry types and
// transaction types it doesn't recognize:
//   - Unknown LedgerEntryTypes are logged once and recorded in the
//     UnknownLedgerEntryType table by applyDeltas() — they don't crash sync.
//   - LedgerTxTypeCount.type is a free-form string with no enum, so any new
//     transaction type from a future amendment can be counted without schema
//     changes.
//   - State parsers use defensive field access; missing fields are tolerated.
//
// So this check is purely informational — it reports which network amendments
// xrplmeta has explicit handler support for, vs which ones are "unknown but
// handled-by-design". It's emitted at debug level by default; the only thing
// that surfaces at info level is a one-line summary count.
//
// If the indexer ever needs to be updated for a new amendment (e.g. to
// recognize new ledger entry types properly, or to produce richer derived
// data), that becomes obvious from the UnknownLedgerEntryType table —
// not from this startup check.

import log from '../lib/log.js'

// Amendments xrplmeta has explicit handler support for (state/*.js modules,
// schema fields, derived metrics). Anything else still works — just without
// the specialized handling.
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

		let unhandled = enabled.filter(name => !knownAmendments.has(name))

		log.info(
			`network has ${enabled.length} amendments enabled` +
			(unhandled.length > 0
				? ` (${unhandled.length} not in xrplmeta's explicit-handler set — these still work, but won't get specialized handling)`
				: ` — all in xrplmeta's explicit-handler set`)
		)

		// Per-amendment detail is debug-only — visible with --log debug if someone
		// wants to know specifically which amendments aren't handled.
		if(unhandled.length > 0){
			for(let name of unhandled){
				log.debug(`  amendment without explicit handler: ${name}`)
			}
		}
	}catch(error){
		log.debug(`amendment baseline check failed: ${error.message}`)
	}
}
