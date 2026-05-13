const pseudoTransactionTypes = [
	'EnableAmendment',
	'SetFee',
	'UNLModify'
]


export function applyLedgerStats({ ctx, ledger }){
	let baseData = {
		sequence: ledger.sequence,
		hash: ledger.hash,
		closeTime: ledger.closeTime,
		txCount: ledger.transactions.length,
	}

	if(ledger.transactions.length === 0){
		ctx.db.core.ledgers.createOne({
			data: baseData
		})
	}else{
		let types = {}
		let fees = []

		for(let transaction of ledger.transactions){
			if(pseudoTransactionTypes.includes(transaction.TransactionType))
				continue

			if(!types[transaction.TransactionType])
				types[transaction.TransactionType] = 0

			types[transaction.TransactionType]++

			let fee = parseInt(transaction.Fee, 10)
			if(Number.isFinite(fee))
				fees.push(fee)
		}

		let feeStats = fees.length > 0
			? {
				minFee: Math.min(...fees),
				maxFee: Math.max(...fees),
				avgFee: Math.floor(
					fees.reduce((total, fee) => total + fee, 0) / fees.length
				)
			}
			: {
				minFee: 0,
				maxFee: 0,
				avgFee: 0
			}

		ctx.db.core.ledgers.createOne({
			data: {
				...baseData,
				txTypeCounts: Object.entries(types)
					.map(([type, count]) => ({ type, count })),
				...feeStats
			}
		})
	}
}