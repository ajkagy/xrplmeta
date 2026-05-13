import { readAmmPools, readAmmPoolByAccount, readAmmPoolSeries } from '../../db/helpers/amm.js'
import { isValidClassicAddress } from 'ripple-address-codec'


export function serveAmmList(){
	return ({ ctx, token, sequence, limit, offset }) => {
		return readAmmPools({
			ctx,
			ledgerSequence: sequence,
			limit,
			offset,
			token
		})
	}
}

export function serveAmmByAccount(){
	return ({ ctx, account, sequence }) => {
		if(!account || typeof account !== 'string' || !isValidClassicAddress(account))
			throw { type: 'invalidParam', message: `invalid account address`, expose: true }

		let pool = readAmmPoolByAccount({ ctx, address: account, ledgerSequence: sequence })

		if(!pool)
			throw { type: 'notFound', message: `no AMM pool found for account ${account}`, expose: true }

		return pool
	}
}

export function serveAmmSeries(){
	return ({ ctx, account, sequence, time, points }) => {
		if(!account || typeof account !== 'string' || !isValidClassicAddress(account))
			throw { type: 'invalidParam', message: `invalid account address`, expose: true }

		let result = readAmmPoolSeries({ ctx, address: account, sequence, time, points })

		if(!result)
			throw { type: 'notFound', message: `no AMM pool found for account ${account} or missing range`, expose: true }

		return result
	}
}
