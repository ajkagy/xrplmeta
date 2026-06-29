import { updateMarketcapFromExchange, updateMarketcapFromSupply } from './marketcap.js'


export function updateDerived({ ctx, newItems }){
	// Tokens whose supply changed this ledger get an authoritative marketcap from the
	// supply pass below (fresh supply × latest price, which already includes any new
	// exchange). Skip those in the exchange pass to avoid a divergent double-write of
	// the same (token, ledgerSequence) marketcap point.
	let supplyTokenIds = new Set(
		newItems.tokenSupply
			.map(supply => supply.token?.id)
			.filter(id => id != null)
	)

	for(let exchange of newItems.tokenExchanges){
		updateMarketcapFromExchange({ ctx, exchange, skipTokenIds: supplyTokenIds })
	}

	for(let supply of newItems.tokenSupply){
		updateMarketcapFromSupply({ ctx, supply })
	}
}

export function updateAllDerived({ ctx }){
	let exchanges = ctx.db.core.tokenExchanges.iter()

	for(let exchange of exchanges){
		updateMarketcapFromExchange({ ctx, exchange })
	}
}