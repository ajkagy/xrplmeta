import { encodeAccountID } from 'ripple-address-codec'
import { decodeNFTokenId } from '../../xrpl/nftoken.js'
import { markCacheDirtyForNFTCollection } from '../../cache/todo.js'


export function parse({ index, entry }){
	let address = encodeAccountID(Buffer.from(index.slice(0, 40), 'hex'))
	let page = {
		account: { address },
		nfts: []
	}

	for(let { NFToken } of entry.NFTokens){
		let { issuer, taxon, flags, transferFee, serial } = decodeNFTokenId(NFToken.NFTokenID)
		let uri = NFToken.URI
			? Buffer.from(NFToken.URI, 'hex')
			: null

		page.nfts.push({
			owner: { address },
			issuer: { address: issuer },
			tokenId: NFToken.NFTokenID,
			taxon,
			flags,
			transferFee,
			serial,
			uri,
		})
	}

	return page
}



export function diff({ ctx, previous, final }){
	if(previous){
		for(let { owner, ...pNft } of previous.nfts){
			if(final && final.nfts.some(fNft => fNft.tokenId === pNft.tokenId))
				continue

			writeNft({
				ctx,
				nft: ctx.backwards
					? pNft
					: { ...pNft, owner: null }
			})
		}
	}

	if(final){
		for(let { owner, ...fNft } of final.nfts){
			if(previous && previous.nfts.some(pNft => pNft.tokenId === fNft.tokenId))
				continue

			writeNft({
				ctx,
				nft: ctx.backwards
					? fNft
					: { ...fNft, owner }
			})
		}
	}
}


// Find-or-create the (issuer, taxon) collection, link the NFT to it, and persist
// the decoded on-chain fields. mintLedgerSequence is set only when the NFT row is
// first created (forward) so transfers don't overwrite the mint timestamp.
function writeNft({ ctx, nft }){
	let collection = ctx.db.core.nftCollections.createOne({
		data: {
			issuer: nft.issuer,
			taxon: nft.taxon,
			firstSeenLedger: ctx.ledgerSequence
		}
	})

	let isNew = !ctx.db.core.nfts.readOne({
		where: { tokenId: nft.tokenId },
		select: { id: true }
	})

	ctx.db.core.nfts.createOne({
		data: {
			...nft,
			collection: { id: collection.id },
			...(isNew && !ctx.backwards
				? { mintLedgerSequence: ctx.ledgerSequence }
				: {})
		}
	})

	markCacheDirtyForNFTCollection({ ctx, collection: { id: collection.id } })
}
