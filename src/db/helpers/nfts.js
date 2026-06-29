// Read helpers for the denormalized NFT collection cache (populated by
// src/cache/nfts.js). Phase 3 will expose these via API procedures.

import { decodeNFTokenId } from '../../xrpl/nftoken.js'


export function readNFTCollections({ ctx, limit = 100, offset = 0, orderBy } = {}){
	return ctx.db.cache.nftCollections.readMany({
		take: limit,
		skip: offset,
		orderBy: orderBy || { volume24H: 'desc' }
	})
}

export function readNFTCollection({ ctx, issuer, taxon }){
	return ctx.db.cache.nftCollections.readOne({
		where: {
			issuerAddress: issuer,
			taxon
		}
	})
}

// Find-or-create the collection an NFT belongs to and return its id. Used at
// ingest time to denormalize `collection` onto offer/exchange rows so the cache
// worker can aggregate floor/volume with a single indexed `collection` filter —
// rather than joining through nft (which structdb compiles to a LIMIT-1 subquery)
// or building a giant IN(...) over every NFT id in the collection.
export function resolveNFTCollectionId({ ctx, tokenId }){
	if(!tokenId)
		return undefined

	let { issuer, taxon } = decodeNFTokenId(tokenId)

	return ctx.db.core.nftCollections.createOne({
		data: {
			issuer: { address: issuer },
			taxon,
			firstSeenLedger: ctx.ledgerSequence
		}
	})?.id
}
