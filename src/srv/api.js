import { sanitizeRange, sanitizePoint, sanitizeLimitOffset, sanitizeSourcePreferences } from './sanitizers/common.js'
import { sanitizeToken, sanitizeTokenListSortBy, sanitizeNameLike, sanitizeTrustLevels, sanitizeIOUToken } from './sanitizers/token.js'
import { adjustServerInfoResponse, serveServerInfo } from './procedures/server.js'
import { serveTokenSummary, serveTokenSeries, serveTokenList, subscribeTokenList, unsubscribeTokenList, serveTokenExchanges, serveTokenHolders, adjustTokenResponse, adjustTokensResponse } from './procedures/token.js'
import { serveAmmList, serveAmmByAccount, serveAmmSeries } from './procedures/amm.js'
import { serveNFTCollectionList, serveNFTCollection, serveNFTsByCollection, serveNFT, serveNFTCollectionOffers, serveNFTCollectionExchanges } from './procedures/nft.js'
import { sanitizeNFTCollection, sanitizeNFTokenId, sanitizeNFTCollectionSortBy } from './sanitizers/nft.js'
import { serveLedger } from './procedures/ledger.js'
import TokenType from '../xrpl/tokentype.js'
import { addLedgerV1DeprecationWarning, addServerInfoV1DeprecationWarning, addTokenHoldersV1DeprecationWarning, addTokensV1DeprecationWarning, addTokenV1DeprecationWarning, addTokenExchangesV1DeprecationWarning } from './warnings/warning.js'


export const server_info_v1 = compose([
	serveServerInfo(),
	adjustServerInfoResponse(),
	addServerInfoV1DeprecationWarning()
])

export const server_info = compose([
	serveServerInfo()
])

export const ledger_v1 = compose([
	sanitizePoint(),
	serveLedger(),
	addLedgerV1DeprecationWarning()
])

export const ledger = compose([
	sanitizePoint(),
	serveLedger()
])

export const tokens_v1 = compose([
	sanitizeLimitOffset({ defaultLimit: 100, maxLimit: 1000 }),
	sanitizeNameLike(),
	sanitizeTrustLevels(),
	sanitizeTokenListSortBy({ tokenType: TokenType.IOU }),
	sanitizeSourcePreferences(),
	serveTokenList({ tokenType: TokenType.IOU }),
	adjustTokensResponse(),
	addTokensV1DeprecationWarning()
])

export const tokens = compose([
	sanitizeLimitOffset({ defaultLimit: 100, maxLimit: 1000 }),
	sanitizeNameLike(),
	sanitizeTrustLevels(),
	sanitizeTokenListSortBy(),
	sanitizeSourcePreferences(),
	serveTokenList()
])

export const iou_tokens = compose([
	sanitizeLimitOffset({ defaultLimit: 100, maxLimit: 1000 }),
	sanitizeNameLike(),
	sanitizeTrustLevels(),
	sanitizeTokenListSortBy({ tokenType: TokenType.IOU }),
	sanitizeSourcePreferences(),
	serveTokenList({ tokenType: TokenType.IOU }),
	adjustTokensResponse(),
])

export const mpt_tokens = compose([
	sanitizeLimitOffset({ defaultLimit: 100, maxLimit: 1000 }),
	sanitizeNameLike(),
	sanitizeTrustLevels(),
	sanitizeTokenListSortBy({ tokenType: TokenType.MPT }),
	sanitizeSourcePreferences(),
	serveTokenList({ tokenType: TokenType.MPT }),
	adjustTokensResponse(),
])

// These rely on ctx.client (the per-connection subscription map), which only exists
// on the main thread. The flag must live on the exported procedure FUNCTION so
// executeProcedure runs it locally — composing tag() into the chain only assigned it
// to the response value, so it was being (incorrectly) dispatched to a worker.
export const tokens_subscribe_v1 = Object.assign(
	compose([
		sanitizeToken({ key: 'tokens', array: true }),
		sanitizeSourcePreferences(),
		subscribeTokenList()
	]),
	{ mustRunMainThread: true }
)

export const tokens_unsubscribe_v1 = Object.assign(
	compose([
		sanitizeToken({ key: 'tokens', array: true }),
		unsubscribeTokenList()
	]),
	{ mustRunMainThread: true }
)

export const token_v1 = compose([
	sanitizeIOUToken({ key: 'token' }),
	sanitizeSourcePreferences(),
	serveTokenSummary(),
	adjustTokenResponse(),
	addTokenV1DeprecationWarning()
])

export const token = compose([
	sanitizeToken({ key: 'token' }),
	sanitizeSourcePreferences(),
	serveTokenSummary(),
])

export const token_series_v1 = compose([
	sanitizeIOUToken({ key: 'token' }),
	sanitizeRange({ withInterval: true }),
	serveTokenSeries()
])

export const token_series = compose([
	sanitizeToken({ key: 'token' }),
	sanitizeRange({ withInterval: true }),
	serveTokenSeries()
])

export const token_exchanges_v1 = compose([
	sanitizeIOUToken({ key: 'base', allowXRP: true }),
	sanitizeIOUToken({ key: 'quote', allowXRP: true }),
	sanitizeRange({ defaultToFullRange: true }),
	sanitizeLimitOffset({ defaultLimit: 100, maxLimit: 1000 }),
	serveTokenExchanges(),
	addTokenExchangesV1DeprecationWarning()
])

export const token_exchanges = compose([
	sanitizeToken({ key: 'base', allowXRP: true }),
	sanitizeToken({ key: 'quote', allowXRP: true }),
	sanitizeRange({ defaultToFullRange: true }),
	sanitizeLimitOffset({ defaultLimit: 100, maxLimit: 1000 }),
	serveTokenExchanges()
])

export const token_holders_v1 = compose([
	sanitizeIOUToken({ key: 'token' }),
	sanitizePoint({ defaultToLatest: true }),
	sanitizeLimitOffset({ defaultLimit: 100, maxLimit: 1000 }),
	serveTokenHolders(),
	addTokenHoldersV1DeprecationWarning()
])

export const token_holders = compose([
	sanitizeToken({ key: 'token' }),
	sanitizePoint({ defaultToLatest: true }),
	sanitizeLimitOffset({ defaultLimit: 100, maxLimit: 1000 }),
	serveTokenHolders()
])

export const amms = compose([
	sanitizePoint({ defaultToLatest: true }),
	sanitizeLimitOffset({ defaultLimit: 50, maxLimit: 1000 }),
	sanitizeOptionalToken({ key: 'token' }),
	serveAmmList()
])

export const amm = compose([
	sanitizePoint({ defaultToLatest: true }),
	serveAmmByAccount()
])

export const amm_series = compose([
	sanitizeRange({ withInterval: false, defaultToFullRange: true }),
	serveAmmSeries()
])

export const nft_collections = compose([
	sanitizeLimitOffset({ defaultLimit: 50, maxLimit: 1000 }),
	sanitizeNameLike(),
	sanitizeNFTCollectionSortBy(),
	serveNFTCollectionList()
])

export const nft_collection = compose([
	sanitizeNFTCollection(),
	serveNFTCollection()
])

export const nft_collection_nfts = compose([
	sanitizeNFTCollection(),
	sanitizeLimitOffset({ defaultLimit: 100, maxLimit: 1000 }),
	serveNFTsByCollection()
])

export const nft_collection_offers = compose([
	sanitizeNFTCollection(),
	sanitizeLimitOffset({ defaultLimit: 100, maxLimit: 1000 }),
	serveNFTCollectionOffers()
])

export const nft_collection_exchanges = compose([
	sanitizeNFTCollection(),
	sanitizeRange({ defaultToFullRange: true }),
	sanitizeLimitOffset({ defaultLimit: 100, maxLimit: 1000 }),
	serveNFTCollectionExchanges()
])

export const nft = compose([
	sanitizeNFTokenId(),
	serveNFT()
])

function sanitizeOptionalToken({ key }){
	return args => {
		if(args[key] === undefined) return args
		return sanitizeToken({ key, allowXRP: true })(args)
	}
}

function compose(functions){
	return args => functions.reduce(
		(v, f) => f(v),
		args	
	)
}

function tag(properties){
	return f => Object.assign(f, properties)
}