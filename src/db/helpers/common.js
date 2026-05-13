const maxLedgerSequence = 1_000_000_000_000


export function readPoint({ table, selector, ledgerSequence, expirable }){
	if(ledgerSequence === undefined){
		return table.readOne({
			where: selector,
			orderBy: {
				ledgerSequence: 'desc'
			}
		})
	}else if(expirable){
		return table.readOne({
			where: {
				...selector,
				ledgerSequence: {
					lessOrEqual: ledgerSequence
				},
				lastLedgerSequence: {
					greaterOrEqual: ledgerSequence
				}
			},
			orderBy: {
				ledgerSequence: 'desc'
			}
		})
	}else{
		return table.readOne({
			where: {
				...selector,
				ledgerSequence: {
					lessOrEqual: ledgerSequence
				}
			},
			orderBy: {
				ledgerSequence: 'desc'
			}
		})
	}
}

export function writePoint({ table, selector, ledgerSequence, backwards, data, expirable }){
	let point = readPoint({
		table,
		selector,
		ledgerSequence,
		expirable
	})

	if(point){
		let replace = point.ledgerSequence === ledgerSequence

		if(data){
			let changes = {}

			for(let [key, value] of Object.entries(data)){
				let a = value != null ? value.toString() : value
				let b = point[key] != null ? point[key].toString() : point[key]

				if(a != b){
					changes[key] = value
				}
			}

			if(Object.keys(changes).length === 0)
				return

			if(replace){
				return table.updateOne({
					data: changes,
					where: {
						id: point.id
					}
				})
			}
		}else{
			if(replace){
				return table.deleteOne({
					where: {
						id: point.id
					}
				})
			}
		}

		if(expirable){
			table.updateOne({
				data: {
					lastLedgerSequence: ledgerSequence - 1
				},
				where: {
					id: point.id
				}
			})
		}
	}

	if(!data && expirable)
		return

	if(!data && !expirable && !point)
		return

	return table.createOne({
		data: {
			...selector, 
			...(
				expirable
				? {
					ledgerSequence,
					lastLedgerSequence: maxLedgerSequence
				}
				: {
					ledgerSequence
				}
			),
			...data
		}
	})
}

// Whitelist of Account fields safe to use in a WHERE clause. Callers sometimes pass
// "rich" parsed objects (containing balance/ledgerSequence/pseudo/etc.) — we filter
// down to schema-recognized lookup fields so structdb doesn't throw on unknowns.
const ACCOUNT_LOOKUP_FIELDS = ['id', 'address']
const TOKEN_LOOKUP_FIELDS   = ['id', 'currency', 'issuer', 'mptIssuanceId', 'tokenType']

function pickLookup(obj, fields){
	let where = {}
	for(let key of fields){
		if(obj[key] !== undefined && obj[key] !== null)
			where[key] = obj[key]
	}
	return where
}

export function getAccountId({ ctx, account }){
	if(!account) return undefined
	if(account.id != null) return account.id

	let where = pickLookup(account, ACCOUNT_LOOKUP_FIELDS)
	if(Object.keys(where).length === 0) return undefined

	return ctx.db.core.accounts.readOne({
		where,
		select: { id: true }
	})?.id
}

export function getTokenId({ ctx, token }){
	if(!token) return undefined
	if(token.id != null) return token.id

	let where = pickLookup(token, TOKEN_LOOKUP_FIELDS)
	if(Object.keys(where).length === 0) return undefined

	return ctx.db.core.tokens.readOne({
		where,
		select: { id: true }
	})?.id
}