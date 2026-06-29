import { getAccountId, getTokenId } from '../db/helpers/common.js'
import { decodeNFTokenId } from '../xrpl/nftoken.js'

export function markCacheDirtyForAccountProps({ ctx, account }){
	if(ctx.backwards)
		return

	let subject = getAccountId({ ctx, account })

	if(!subject)
		return

	ctx.db.cache.todos.createOne({
		data: {
			task: 'account.props',
			subject
		}
	})
}

export function markCacheDirtyForTokenProps({ ctx, token }){
	if(ctx.backwards)
		return

	let subject = getTokenId({ ctx, token })

	if(!subject)
		return

	ctx.db.cache.todos.createOne({
		data: {
			task: 'token.props',
			subject
		}
	})
}

export function markCacheDirtyForNFTCollection({ ctx, collection }){
	if(ctx.backwards)
		return

	if(!collection?.id)
		return

	ctx.db.cache.todos.createOne({
		data: {
			task: 'nftCollection.metrics',
			subject: collection.id
		}
	})
}

// Mark the collection a given NFT belongs to dirty, resolving (issuer, taxon) from
// the NFTokenID — used from paths that only have a token id (offers / exchanges).
export function markCacheDirtyForNFTCollectionByTokenId({ ctx, tokenId }){
	if(ctx.backwards)
		return

	if(!tokenId)
		return

	let { issuer, taxon } = decodeNFTokenId(tokenId)
	let subject = ctx.db.core.nftCollections.readOne({
		where: { issuer: { address: issuer }, taxon },
		select: { id: true }
	})?.id

	if(!subject)
		return

	ctx.db.cache.todos.createOne({
		data: {
			task: 'nftCollection.metrics',
			subject
		}
	})
}

export function markCacheDirtyForTokenMetrics({ ctx, token, metrics }){
	if(ctx.backwards)
		return

	let subject = getTokenId({ ctx, token })

	if(!subject)
		return

	for(let metric of Object.keys(metrics)){
		ctx.db.cache.todos.createOne({
			data: {
				task: `token.metrics.${metric}`,
				subject 
			}
		})
	}
}

export function markCacheDirtyForTokenExchanges({ ctx, token }){
	if(ctx.backwards)
		return

	if(token.currency === 'XRP')
		return

	let subject = getTokenId({ ctx, token })

	if(!subject)
		return

	ctx.db.cache.todos.createOne({
		data: {
			task: 'token.exchanges',
			subject
		}
	})
}

export function markCacheDirtyForTokenIcons({ ctx, token }){
	let subject = getTokenId({ ctx, token })

	if(!subject)
		return

	ctx.db.cache.todos.createOne({
		data: {
			task: 'token.icons',
			subject
		}
	})
}

export function markCacheDirtyForAccountIcons({ ctx, account }){
	let subject = getAccountId({ ctx, account })

	if(!subject)
		return

	ctx.db.cache.todos.createOne({
		data: {
			task: 'account.icons',
			subject
		}
	})
}