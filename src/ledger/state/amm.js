// Handler for the AMM ledger entry type (amendment: AMM).
// https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/amm
//
// An AMM entry represents an Automated Market Maker pool. Each AMM has its own
// pseudo-account (Account field) which holds the pool's reserves as ordinary
// RippleState / AccountRoot balances. Tracking the AMM pool's existence lets us:
//   1) attribute liquidity to a pool rather than counting the pseudo-account as a holder
//   2) surface pool composition + fee to API consumers

import { amountFromRippled } from '../../xrpl/tokens.js'
import TokenType from '../../xrpl/tokentype.js'

export function parse({ entry }){
	if(!entry.Account || !entry.Asset || !entry.Asset2)
		return undefined

	return {
		account: { address: entry.Account },
		asset1: tokenFromAsset(entry.Asset),
		asset2: tokenFromAsset(entry.Asset2),
		lpTokenCurrency: entry.LPTokenBalance?.currency,
		tradingFee: entry.TradingFee || 0,
		ledgerSequence: entry.LedgerSequence
	}
}

export function diff({ ctx, previous, final }){
	if(!ctx.db?.core?.ammPools)
		return

	if(final){
		ctx.db.core.ammPools.createOne({
			data: {
				account: final.account,
				asset1Token: final.asset1,
				asset2Token: final.asset2,
				lpTokenCurrency: final.lpTokenCurrency,
				tradingFee: final.tradingFee,
				ledgerSequence: final.ledgerSequence
			}
		})
	}else if(previous){
		try{
			ctx.db.core.ammPools.deleteOne({
				where: { account: previous.account }
			})
		}catch{
			// already deleted or never recorded
		}
	}
}

function tokenFromAsset(asset){
	if(!asset) return undefined
	if(asset.currency === 'XRP' || (!asset.currency && !asset.mpt_issuance_id)){
		return { currency: 'XRP', tokenType: TokenType.XRP }
	}
	if(asset.mpt_issuance_id){
		return { mptIssuanceId: asset.mpt_issuance_id, tokenType: TokenType.MPT }
	}
	return {
		currency: asset.currency,
		issuer: asset.issuer ? { address: asset.issuer } : undefined,
		tokenType: TokenType.IOU
	}
}
