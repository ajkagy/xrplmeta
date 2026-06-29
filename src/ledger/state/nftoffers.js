import { encodeAccountID } from 'ripple-address-codec'
import { amountFromRippled } from '../../xrpl/tokens.js'
import { rippleToUnix } from '../../lib/time.js'
import { expireNFTokenOffer, writeNFTokenOffer } from '../../db/helpers/nftoffers.js'
import { resolveNFTCollectionId } from '../../db/helpers/nfts.js'
import { markCacheDirtyForNFTCollection } from '../../cache/todo.js'
import TokenType from '../../xrpl/tokentype.js'


export function parse({ index, entry }){
	let amountToken
	let amountValue
	let issuer = encodeAccountID(Buffer.from(entry.NFTokenID.slice(8, 48), 'hex'))
	let isSellOffer = entry.Flags & 0x00000001
	let expirationTime = entry.Expiration
		? rippleToUnix(entry.Expiration)
		: null

		
	if(entry.Amount){
		let { currency, issuer, value } = amountFromRippled(entry.Amount)

		amountValue = value
		amountToken = currency === 'XRP'
			? { id: 1 }
			: {
				currency,
				issuer: {
					address: issuer
				},
				tokenType: TokenType.IOU
			}
	}

	return {
		account: {
			address: entry.Owner
		},
		offerId: index,
		nft: {
			tokenId: entry.NFTokenID,
			issuer: {
				address: issuer
			}
		},
		destination: entry.Destination
			? { address: entry.Destination }
			: null,
		amountToken,
		amountValue,
		isSellOffer,
		expirationTime,
		ledgerSequence: entry.LedgerSequence
	}
}



export function diff({ ctx, previous, final }){
	// Denormalize the collection onto the offer row so floor can be computed with a
	// single indexed `collection` filter (see resolveNFTCollectionId).
	let collectionId = resolveNFTCollectionId({
		ctx,
		tokenId: final?.nft?.tokenId ?? previous?.nft?.tokenId
	})

	if(previous){
		expireNFTokenOffer({
			...previous,
			ctx,
			ledgerSequence: ctx.ledgerSequence,
		})
	}

	if(final){
		writeNFTokenOffer({
			...final,
			collection: collectionId ? { id: collectionId } : undefined,
			ctx
		})
	}

	// An offer appearing/expiring can change the collection's floor — refresh it.
	markCacheDirtyForNFTCollection({ ctx, collection: { id: collectionId } })
}