import { isValidClassicAddress } from 'ripple-address-codec'
import { readMostRecentLedger } from '../../db/helpers/ledgers.js'


function asString(value){
	return value == null ? null : value.toString()
}

function decodeUri(uri){
	if(uri == null)
		return null
	try{
		return Buffer.isBuffer(uri) ? uri.toString('utf8') : String(uri)
	}catch{
		return null
	}
}

function formatAmountToken(token){
	if(!token)
		return null
	if(token.id === 1 || token.currency === 'XRP')
		return { currency: 'XRP' }
	if(token.mptIssuanceId)
		return { mpt_issuance_id: token.mptIssuanceId }
	return { currency: token.currency, issuer: token.issuer?.address }
}

function thumbnailUrl(ctx, tokenId, hasImage){
	if(!hasImage)
		return null
	let base = ctx.config?.server?.publicUrl
	return base ? `${base.replace(/\/$/, '')}/v2/nft/${tokenId}/image` : null
}

function formatCollection(cache){
	return {
		issuer: cache.issuerAddress,
		taxon: cache.taxon,
		name: cache.name ?? null,
		image: cache.imageUrl ?? null,
		supply: cache.supply ?? 0,
		holders: cache.holders ?? 0,
		floor: asString(cache.floor) ?? '0',
		volume: {
			h24: asString(cache.volume24H) ?? '0',
			d7: asString(cache.volume7D) ?? '0',
			all: asString(cache.volumeAll) ?? '0'
		},
		trades: {
			h24: cache.trades24H ?? 0,
			d7: cache.trades7D ?? 0
		}
	}
}

function formatNFT(nft, meta, ctx){
	return {
		token_id: nft.tokenId,
		issuer: nft.issuer?.address,
		owner: nft.owner?.address ?? null,
		taxon: nft.taxon,
		serial: nft.serial,
		flags: nft.flags,
		transfer_fee: nft.transferFee,
		uri: decodeUri(nft.uri),
		mint_ledger: nft.mintLedgerSequence ?? null,
		burn_ledger: nft.burnLedgerSequence ?? null,
		name: meta?.name ?? null,
		description: meta?.description ?? null,
		media_url: meta?.mediaUrl ?? null,
		media_type: meta?.mediaType ?? null,
		image: meta?.imageUrl ?? null,
		thumbnail: ctx ? thumbnailUrl(ctx, nft.tokenId, !!meta?.imageUrl) : null
	}
}

// Batch-load per-NFT metadata (cache.nftMeta) for a page of NFTs, keyed by tokenId.
function loadNFTMeta(ctx, tokenIds){
	let map = new Map()
	if(!tokenIds.length)
		return map
	for(let row of ctx.db.cache.nftMeta.readMany({ where: { tokenId: { in: tokenIds } } }))
		map.set(row.tokenId, row)
	return map
}

function formatOffer(offer){
	return {
		offer_id: offer.offerId,
		account: offer.account?.address,
		amount: asString(offer.amountValue),
		token: formatAmountToken(offer.amountToken),
		is_sell: !!offer.isSellOffer,
		destination: offer.destination?.address ?? null,
		expiration: offer.expirationTime ?? null,
		ledger_index: offer.ledgerSequence
	}
}

function formatExchange(exchange){
	return {
		tx_hash: exchange.txHash,
		token_id: exchange.nft?.tokenId,
		seller: exchange.seller?.address ?? null,
		buyer: exchange.buyer?.address ?? null,
		amount: asString(exchange.amountValue),
		token: formatAmountToken(exchange.amountToken),
		is_sell: !!exchange.isSellOffer,
		ledger_index: exchange.ledgerSequence
	}
}


function resolveCollection({ ctx, issuer, taxon }){
	let collection = ctx.db.core.nftCollections.readOne({
		where: { issuer: { address: issuer }, taxon }
	})

	if(!collection)
		throw {
			type: `entryNotFound`,
			message: `No NFT collection found for issuer "${issuer}" taxon ${taxon}.`,
			expose: true
		}

	return collection
}


export function serveNFTCollectionList(){
	return ({ ctx, sort_by, name_like, issuer, limit, offset }) => {
		let where = {}

		// `issuer` filters exactly; `name_like` searches the off-chain collection name
		// (populated by the metadata enrichment worker). The two can combine.
		if(issuer){
			if(!isValidClassicAddress(issuer))
				throw {
					type: `invalidParam`,
					message: `The issuer address "${issuer}" is malformed.`,
					expose: true
				}
			where.issuerAddress = issuer
		}
		if(name_like)
			where.name = { like: `%${name_like}%` }

		let count = ctx.db.cache.nftCollections.count({ where })
		let rows = ctx.db.cache.nftCollections.readMany({
			where,
			orderBy: { [sort_by || 'volume24H']: 'desc' },
			take: limit,
			skip: offset
		})

		return {
			count: Number(count),
			collections: rows.map(formatCollection)
		}
	}
}

export function serveNFTCollection(){
	return ({ ctx, issuer, taxon }) => {
		let cache = ctx.db.cache.nftCollections.readOne({
			where: { issuerAddress: issuer, taxon }
		})

		if(!cache)
			throw {
				type: `entryNotFound`,
				message: `No NFT collection found for issuer "${issuer}" taxon ${taxon}.`,
				expose: true
			}

		return formatCollection(cache)
	}
}

export function serveNFTsByCollection(){
	return ({ ctx, issuer, taxon, limit, offset }) => {
		let collection = resolveCollection({ ctx, issuer, taxon })
		// Live holdings only (owner not null), so `count` matches collection.supply.
		let where = { collection: { id: collection.id }, NOT: { owner: null } }

		let count = ctx.db.core.nfts.count({ where })
		let nfts = ctx.db.core.nfts.readMany({
			where,
			include: { owner: true, issuer: true },
			orderBy: { serial: 'asc' },
			take: limit,
			skip: offset
		})

		let meta = loadNFTMeta(ctx, nfts.map(nft => nft.tokenId))

		return {
			count: Number(count),
			nfts: nfts.map(nft => formatNFT(nft, meta.get(nft.tokenId), ctx))
		}
	}
}

export function serveNFT(){
	return ({ ctx, tokenId }) => {
		let nft = ctx.db.core.nfts.readOne({
			where: { tokenId },
			include: { owner: true, issuer: true }
		})

		if(!nft)
			throw {
				type: `entryNotFound`,
				message: `No NFT found with id "${tokenId}".`,
				expose: true
			}

		let current = readMostRecentLedger({ ctx })
		let offers = current
			? ctx.db.core.nftOffers.readMany({
				where: {
					nft: { id: nft.id },
					AND: [
						{ ledgerSequence: { lessOrEqual: current.sequence } },
						{ lastLedgerSequence: { greaterOrEqual: current.sequence } }
					],
					// Exclude wall-clock-expired offers so the API agrees with the cache
					// floor's notion of "active" (see cache/nfts.js computeFloor).
					OR: [
						{ expirationTime: null },
						{ expirationTime: { greaterThan: current.closeTime } }
					]
				},
				include: { account: true, destination: true, amountToken: { issuer: true } },
				take: 500
			})
			: []

		let meta = ctx.db.cache.nftMeta.readOne({ where: { tokenId: nft.tokenId } })

		return {
			...formatNFT(nft, meta, ctx),
			offers: offers.map(formatOffer)
		}
	}
}

export function serveNFTCollectionOffers(){
	return ({ ctx, issuer, taxon, limit, offset }) => {
		let collection = resolveCollection({ ctx, issuer, taxon })
		let current = readMostRecentLedger({ ctx })

		let where = { collection: { id: collection.id } }
		if(current){
			where.AND = [
				{ ledgerSequence: { lessOrEqual: current.sequence } },
				{ lastLedgerSequence: { greaterOrEqual: current.sequence } }
			]
			// Exclude wall-clock-expired offers (consistent with the cache floor).
			where.OR = [
				{ expirationTime: null },
				{ expirationTime: { greaterThan: current.closeTime } }
			]
		}

		let count = ctx.db.core.nftOffers.count({ where })
		let offers = ctx.db.core.nftOffers.readMany({
			where,
			include: { account: true, destination: true, nft: true, amountToken: { issuer: true } },
			orderBy: { amountValue: 'asc' },
			take: limit,
			skip: offset
		})

		return {
			count: Number(count),
			offers: offers.map(offer => ({ ...formatOffer(offer), token_id: offer.nft?.tokenId }))
		}
	}
}

export function serveNFTCollectionExchanges(){
	return ({ ctx, issuer, taxon, sequence, limit, offset, newestFirst }) => {
		let collection = resolveCollection({ ctx, issuer, taxon })

		let where = { collection: { id: collection.id } }
		if(sequence)
			where.AND = [
				{ ledgerSequence: { greaterOrEqual: sequence.start } },
				{ ledgerSequence: { lessOrEqual: sequence.end } }
			]

		let count = ctx.db.core.nftExchanges.count({ where })
		let exchanges = ctx.db.core.nftExchanges.readMany({
			where,
			include: { seller: true, buyer: true, nft: true, amountToken: { issuer: true } },
			orderBy: { ledgerSequence: newestFirst ? 'desc' : 'asc' },
			take: limit,
			skip: offset
		})

		return {
			count: Number(count),
			exchanges: exchanges.map(formatExchange)
		}
	}
}
