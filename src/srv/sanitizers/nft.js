import { isValidClassicAddress } from 'ripple-address-codec'


const collectionSortKeymap = {
	supply: 'supply',
	holders: 'holders',
	floor: 'floor',
	volume_24h: 'volume24H',
	volume_7d: 'volume7D',
	volume_all: 'volumeAll',
	trades_24h: 'trades24H',
	trades_7d: 'trades7D'
}


export function sanitizeNFTCollection({ issuerKey = 'issuer', taxonKey = 'taxon' } = {}){
	return ({ ctx, ...args }) => {
		let issuer = args[issuerKey]
		let taxon = args[taxonKey]

		if(!isValidClassicAddress(issuer))
			throw {
				type: `invalidParam`,
				message: `The issuer address "${issuer}" is malformed.`,
				expose: true
			}

		let parsedTaxon = typeof taxon === 'number' ? taxon : parseInt(taxon, 10)

		if(!Number.isFinite(parsedTaxon) || parsedTaxon < 0 || parsedTaxon > 4294967295)
			throw {
				type: `invalidParam`,
				message: `The taxon must be a 32-bit unsigned integer.`,
				expose: true
			}

		return {
			...args,
			ctx,
			[issuerKey]: issuer,
			[taxonKey]: parsedTaxon
		}
	}
}

export function sanitizeNFTokenId({ key = 'tokenId' } = {}){
	return ({ ctx, ...args }) => {
		let id = args[key]

		if(typeof id !== 'string' || !/^[0-9A-Fa-f]{64}$/.test(id))
			throw {
				type: `invalidParam`,
				message: `The NFTokenID "${id}" is malformed (expected 64 hex characters).`,
				expose: true
			}

		return {
			...args,
			ctx,
			[key]: id.toUpperCase()
		}
	}
}

export function sanitizeNFTCollectionSortBy(){
	return ({ ctx, sort_by, ...args }) => {
		if(sort_by){
			sort_by = collectionSortKeymap[sort_by]

			if(!sort_by)
				throw {
					type: `invalidParam`,
					message: `This sorting mode is not allowed. Possible values are: ${Object.keys(collectionSortKeymap).join(', ')}`,
					expose: true
				}
		}

		return {
			...args,
			ctx,
			sort_by
		}
	}
}
