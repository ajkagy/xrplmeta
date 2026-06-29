import log from '../../lib/log.js'
import { parse as parseOffer } from '../state/nftoffers.js'
import { decodeNFTokenId } from '../../xrpl/nftoken.js'
import { resolveNFTCollectionId } from '../../db/helpers/nfts.js'
import { markCacheDirtyForNFTCollection, markCacheDirtyForNFTCollectionByTokenId } from '../../cache/todo.js'


export function applyNFTokenExchanges({ ctx, ledger }){
	for(let transaction of ledger.transactions){
		if(transaction.TransactionType !== 'NFTokenAcceptOffer')
			continue

		if(transaction.metaData.TransactionResult !== 'tesSUCCESS')
			continue

		// A direct accept deletes one offer; a brokered accept deletes BOTH the buy
		// and sell offer. Collect each so we don't clobber one with the other.
		let buyOffer
		let sellOffer

		for(let { DeletedNode } of transaction.metaData.AffectedNodes){
			if(!DeletedNode)
				continue

			if(DeletedNode.LedgerEntryType !== 'NFTokenOffer')
				continue

			let parsed = {
				...parseOffer({
					index: DeletedNode.LedgerIndex,
					entry: DeletedNode.FinalFields
				}),
				ledgerSequence: DeletedNode.FinalFields.PreviousTxnLgrSeq,
				lastLedgerSequence: ledger.sequence - 1
			}

			if(DeletedNode.LedgerIndex === transaction.NFTokenSellOffer)
				sellOffer = parsed
			else if(DeletedNode.LedgerIndex === transaction.NFTokenBuyOffer)
				buyOffer = parsed
		}

		// The sell offer carries the actual sale price (the buy offer may be higher in
		// brokered mode, with the broker keeping the difference).
		let offer = sellOffer || buyOffer
		let brokered = !!(sellOffer && buyOffer)

		if(!offer){
			log.warn(`unable to determine accepted nft offer of ${transaction.hash}`)
			continue
		}

		// Snapshot price + counterparties onto the exchange row so floor/volume can be
		// computed later without the (now-deleted) offers.
		let isSell = !!offer.isSellOffer
		let acceptor = { address: transaction.Account }
		let seller
		let buyer

		if(brokered){
			seller = sellOffer.account
			buyer = buyOffer.account
		}else if(isSell){
			seller = offer.account
			buyer = acceptor
		}else{
			seller = acceptor
			buyer = offer.account
		}

		let collectionId = resolveNFTCollectionId({ ctx, tokenId: offer.nft?.tokenId })

		ctx.db.core.nftExchanges.createOne({
			data: {
				txHash: transaction.hash,
				account: acceptor,
				offer,
				nft: offer.nft,
				collection: collectionId ? { id: collectionId } : undefined,
				seller,
				buyer,
				amountToken: offer.amountToken,
				amountValue: offer.amountValue,
				isSellOffer: isSell,
				ledgerSequence: ledger.sequence
			}
		})

		markCacheDirtyForNFTCollection({ ctx, collection: { id: collectionId } })
	}
}

export function applyNFTokenModifications({ ctx, ledger }){
	// Intentionally does NOT mark the collection cache dirty: collection metrics
	// (supply/holders/floor/volume) don't depend on per-NFT URI. If metadata ever
	// feeds collection-level cache, add a markCacheDirtyForNFTCollectionByTokenId here.
	for(let transaction of ledger.transactions){
		if(transaction.TransactionType !== 'NFTokenModify')
			continue

		if(transaction.metaData.TransactionResult !== 'tesSUCCESS')
			continue

		ctx.db.core.nfts.updateOne({
			data: {
				uri: transaction.URI
					? Buffer.from(transaction.URI, 'hex')
					: null,
			},
			where: {
				tokenId: transaction.NFTokenID
			}
		})
	}
}

export function applyNFTokenBurns({ ctx, ledger }){
	// Burns are tracked forward only; during backwards backfill the NFTokenPage
	// state diff restores ownership, so don't fight it here.
	if(ctx.backwards)
		return

	for(let transaction of ledger.transactions){
		if(transaction.TransactionType !== 'NFTokenBurn')
			continue

		if(transaction.metaData.TransactionResult !== 'tesSUCCESS')
			continue

		if(!transaction.NFTokenID)
			continue

		let updated = ctx.db.core.nfts.updateOne({
			data: {
				owner: null,
				burnLedgerSequence: ledger.sequence
			},
			where: {
				tokenId: transaction.NFTokenID
			}
		})

		// If the NFT was never indexed (e.g. minted AND burned in this same ledger —
		// burns run before the state diff — or it predates our start), the update
		// touches no row. Upsert a minimal burned record so the burn isn't lost.
		if(!updated){
			let { issuer, taxon, flags, transferFee, serial } = decodeNFTokenId(transaction.NFTokenID)

			let collection = ctx.db.core.nftCollections.createOne({
				data: {
					issuer: { address: issuer },
					taxon,
					firstSeenLedger: ledger.sequence
				}
			})

			ctx.db.core.nfts.createOne({
				data: {
					issuer: { address: issuer },
					tokenId: transaction.NFTokenID,
					taxon,
					flags,
					transferFee,
					serial,
					owner: null,
					collection: { id: collection.id },
					burnLedgerSequence: ledger.sequence
				}
			})
		}

		// Mark the collection dirty after the row exists in either path so the
		// supply/holders recompute picks up the burn.
		markCacheDirtyForNFTCollectionByTokenId({ ctx, tokenId: transaction.NFTokenID })
	}
}
