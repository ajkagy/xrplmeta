// Pseudo-accounts are XRPL accounts owned by protocol features (AMM, SingleAssetVault, ...)
// rather than human users. Their RippleState trustlines shouldn't be counted as token holders,
// since locked liquidity is part of the pool, not a wallet.
//
// Detection sources (in priority order):
//   1) AccountRoot.Flags & lsfAMM (0x02000000)                           -> source 'amm'
//   2) Vault.Account field (the pool's pseudo-account)                   -> source 'vault'
//   3) Account.pseudo persisted in DB from a previous ledger (fallback)  -> source whatever was recorded

const LSF_AMM = 0x02000000

// Returns Map<address, source>. The Map shape lets us track both presence AND attribution
// in a single pre-scan, which is important because the same address can only be one kind
// of pseudo at a time.
export function collectPseudoFromDeltas(deltas){
	let map = new Map()

	for(let { type, final } of deltas){
		if(!final) continue

		if(type === 'AccountRoot'){
			let flags = final.Flags || 0
			if((flags & LSF_AMM) !== 0 && final.Account)
				map.set(final.Account, 'amm')
		}else if(type === 'Vault'){
			// The Vault entry's Account field is the vault's pseudo-account address.
			if(final.Account)
				map.set(final.Account, 'vault')
		}
	}

	return map
}

// Cached lookup. ctx.pseudoAccounts is populated from this ledger's deltas;
// ctx.pseudoAccountsCache memoizes DB lookups for prior-ledger pseudo accounts.
export function isPseudoAccount({ ctx, address }){
	return pseudoAccountInfo({ ctx, address }).pseudo
}

// Returns { pseudo: boolean, pseudoSource: string|undefined }
export function pseudoAccountInfo({ ctx, address }){
	if(!address) return { pseudo: false, pseudoSource: undefined }

	if(ctx.pseudoAccounts){
		// Map (current implementation) — has(addr) → true means pseudo
		if(typeof ctx.pseudoAccounts.get === 'function'){
			if(ctx.pseudoAccounts.has(address))
				return { pseudo: true, pseudoSource: ctx.pseudoAccounts.get(address) }
		}else if(typeof ctx.pseudoAccounts.has === 'function'){
			// Set (older callers) — treat as unknown source
			if(ctx.pseudoAccounts.has(address))
				return { pseudo: true, pseudoSource: undefined }
		}
	}

	if(ctx.pseudoAccountsCache && ctx.pseudoAccountsCache.has(address))
		return ctx.pseudoAccountsCache.get(address)

	let info = { pseudo: false, pseudoSource: undefined }
	try{
		let acc = ctx.db?.core?.accounts?.readOne({ where: { address } })
		if(acc?.pseudo)
			info = { pseudo: true, pseudoSource: acc.pseudoSource || undefined }
	}catch{
		// DB miss — default to false
	}
	ctx.pseudoAccountsCache?.set(address, info)
	return info
}
