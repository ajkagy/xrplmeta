// Handler for the Oracle (PriceOracle) ledger entry type (amendment: PriceOracle, XLS-47).
// https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/oracle
//
// The Oracle's ledger-entry index (hash) is its identity. OracleDocumentID is used only
// at creation/lookup time — it's NOT stored on the entry itself.

export function parse({ index, entry }){
	if(!entry.Owner)
		return undefined

	return {
		oracleId: index,
		owner: { address: entry.Owner },
		provider: decodeMaybeHexUtf8(entry.Provider),
		assetClass: decodeMaybeHexUtf8(entry.AssetClass),
		uri: decodeMaybeHexUtf8(entry.URI),
		lastUpdateTime: entry.LastUpdateTime,
		priceDataSeries: Array.isArray(entry.PriceDataSeries) ? entry.PriceDataSeries.length : 0,
		ledgerSequence: entry.LedgerSequence
	}
}

export function diff({ ctx, previous, final }){
	if(!ctx.db?.core?.oracles)
		return

	if(final){
		ctx.db.core.oracles.createOne({
			data: {
				oracleId: final.oracleId,
				owner: final.owner,
				provider: final.provider,
				assetClass: final.assetClass,
				uri: final.uri,
				lastUpdateTime: final.lastUpdateTime,
				priceDataCount: final.priceDataSeries,
				ledgerSequence: final.ledgerSequence
			}
		})
	}else if(previous){
		try{
			ctx.db.core.oracles.deleteOne({
				where: { oracleId: previous.oracleId }
			})
		}catch{
			// already deleted or never recorded
		}
	}
}

function decodeMaybeHexUtf8(value){
	if(!value || typeof value !== 'string') return undefined
	if(!/^[0-9A-Fa-f]+$/.test(value)) return value
	try{
		return Buffer.from(value, 'hex').toString('utf8')
	}catch{
		return value
	}
}
