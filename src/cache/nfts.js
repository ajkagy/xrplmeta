import { XFL, sum, min } from '../../vendor/xfl/wrappers/class.js'
import { readLedgerAt, readMostRecentLedger } from '../db/helpers/ledgers.js'


// XRP is always token id 1 (see openCoreDB.createXRP). NFT floor/volume are quoted
// in XRP; IOU-denominated offers/sales are excluded for now (noted in the plan).
const XRP = { id: 1 }


// Recompute the denormalized cache row for one NFT collection. All metrics are
// derived from the current core tables via aggregate queries keyed on the
// denormalized `collection` column (offers/exchanges carry it; see
// resolveNFTCollectionId), so this is correct regardless of forward/backward/
// snapshot and scales without giant IN(...) lists.
export function updateCacheForNFTCollection({ ctx, collection }){
	if(ctx.backwards)
		return

	let row = ctx.db.core.nftCollections.readOne({
		where: { id: collection.id },
		include: { issuer: true }
	})

	if(!row || !row.issuer)
		return

	let collectionId = row.id
	let current = readMostRecentLedger({ ctx })

	if(!current)
		return

	let pre24h = readLedgerAt({ ctx, time: current.closeTime - 60 * 60 * 24, clamp: true })?.sequence ?? current.sequence
	let pre7d = readLedgerAt({ ctx, time: current.closeTime - 60 * 60 * 24 * 7, clamp: true })?.sequence ?? current.sequence

	// Live supply / unique holders — burned or transferred-out NFTs have owner = null.
	let liveWhere = {
		collection: { id: collectionId },
		NOT: { owner: null }
	}
	let supply = Number(ctx.db.core.nfts.count({ where: liveWhere }))
	let holders = Number(ctx.db.core.nfts.count({ distinct: ['owner'], where: liveWhere }))

	let floor = computeFloor({ ctx, collectionId, current })

	let all = volumeWindow({ ctx, collectionId })
	let window24 = volumeWindow({ ctx, collectionId, sequenceStart: pre24h, sequenceEnd: current.sequence })
	let window7 = volumeWindow({ ctx, collectionId, sequenceStart: pre7d, sequenceEnd: current.sequence })

	ctx.db.cache.nftCollections.createOne({
		data: {
			collection: collectionId,
			issuerAddress: row.issuer.address,
			taxon: row.taxon,
			supply,
			holders,
			floor: floor.toString(),
			volumeAll: all.volume.toString(),
			volume24H: window24.volume.toString(),
			volume7D: window7.volume.toString(),
			trades24H: window24.count,
			trades7D: window7.count
		},
		returnUnchanged: false
	})
}


// Floor = lowest OPEN, active, XRP sell offer across the collection. Open means no
// `destination` (destination-restricted offers are private/brokered, not the public
// floor). Active means within the offer's on-ledger window and not wall-clock expired.
function computeFloor({ ctx, collectionId, current }){
	let offers = ctx.db.core.nftOffers.readMany({
		where: {
			collection: { id: collectionId },
			isSellOffer: true,
			amountToken: XRP,
			destination: null,
			AND: [
				{ ledgerSequence: { lessOrEqual: current.sequence } },
				{ lastLedgerSequence: { greaterOrEqual: current.sequence } }
			]
		},
		select: {
			amountValue: true,
			expirationTime: true
		}
	})

	let floor = null

	for(let offer of offers){
		if(offer.amountValue == null)
			continue

		// Skip offers whose wall-clock expiry has passed but are still on the ledger.
		// NOTE: a collection whose lowest offer expires purely by time (no ledger
		// mutation) won't be re-marked dirty until its next on-chain activity, so the
		// cached floor can be briefly stale — acceptable for now; a time-driven sweep
		// is a Phase 3 follow-up.
		if(offer.expirationTime && offer.expirationTime <= current.closeTime)
			continue

		floor = floor === null
			? offer.amountValue
			: min(floor, offer.amountValue)
	}

	return floor === null ? XFL(0) : floor
}


// Volume + trade count over an optional sequence window, aggregated in SQL
// (XFL_SUM + COUNT) rather than streaming every exchange row into JS.
function volumeWindow({ ctx, collectionId, sequenceStart, sequenceEnd }){
	let where = {
		collection: { id: collectionId },
		amountToken: XRP
	}

	if(sequenceStart != null || sequenceEnd != null){
		where.AND = []
		if(sequenceStart != null)
			where.AND.push({ ledgerSequence: { greaterOrEqual: sequenceStart } })
		if(sequenceEnd != null)
			where.AND.push({ ledgerSequence: { lessOrEqual: sequenceEnd } })
	}

	let aggregate = ctx.db.core.nftExchanges.readOne({
		select: {
			amountValue: { function: 'XFL_SUM' },
			id: { function: 'COUNT' }
		},
		where
	})

	return {
		volume: sum(XFL(0), aggregate?.amountValue ?? 0),
		count: Number(aggregate?.id ?? 0)
	}
}
