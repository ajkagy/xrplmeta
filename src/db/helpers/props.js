import log from '../../lib/log.js'
import { isSameToken } from '../../xrpl/tokens.js'
import { readTokenMetrics } from './tokenmetrics.js'
import { withSyncOp } from '../../lib/health.js'
import {
	markCacheDirtyForAccountIcons,
	markCacheDirtyForAccountProps,
	markCacheDirtyForTokenIcons,
	markCacheDirtyForTokenProps
} from '../../cache/todo.js'


// How many subjects (accounts/tokens) we process per database transaction.
// Each chunk runs in a single BEGIN IMMEDIATE..COMMIT (one fsync instead of
// one-per-subject), and we yield to the event loop between chunks so the HTTP
// / WebSocket server keeps serving even while a huge list (e.g. a 350k-entry
// well-known dump) is being diffed. Tuned to keep each synchronous block well
// under the health monitor's ~500ms stall threshold.
const DIFF_CHUNK_SIZE = 500


// setImmediate-based yield: lets pending I/O callbacks fire between chunks at
// microsecond cost. Mirrors the pattern used in crawl/schedule.js.
function yieldLoop(){
	return new Promise(resolve => setImmediate(resolve))
}


function valuesDiffer(existing, incoming){
	if(existing === incoming)
		return false

	if(existing == null || incoming == null)
		return true

	// "any"-typed prop values can be objects/arrays (advisories, urls, ...).
	// Reference comparison would always report a change, so compare encoded
	// form. Worst case we over-report a change (a redundant cache refresh),
	// never under-report one (which would leave a stale cache).
	if(typeof existing === 'object' || typeof incoming === 'object'){
		try{
			return JSON.stringify(existing) !== JSON.stringify(incoming)
		}catch{
			return true
		}
	}

	return existing !== incoming
}


// Write one subject's props for a source, returning which prop rows are still
// "live" (so the caller can sweep the rest as stale) and whether anything
// actually changed (so cache invalidation can be skipped when it didn't).
// Does NOT open its own transaction or mark the cache dirty — the caller owns
// both, to allow batching across many subjects.
function applyAccountProps({ ctx, account, props, source }){
	let keptIds = []
	let changed = false
	let iconChanged = false

	for(let [key, value] of Object.entries(props)){
		let existing = ctx.db.core.accountProps.readOne({
			where: { account, key, source }
		})

		if(value == null){
			if(existing){
				ctx.db.core.accountProps.deleteOne({ where: { id: existing.id } })
				changed = true
				if(key === 'icon')
					iconChanged = true
			}
			continue
		}

		if(!existing){
			let created = ctx.db.core.accountProps.createOne({
				data: { account, key, value, source }
			})
			keptIds.push(created.id)
			changed = true
			if(key === 'icon')
				iconChanged = true
		}else{
			keptIds.push(existing.id)

			if(valuesDiffer(existing.value, value)){
				ctx.db.core.accountProps.updateOne({
					data: { value },
					where: { id: existing.id }
				})
				changed = true
				if(key === 'icon')
					iconChanged = true
			}
		}
	}

	return { keptIds, changed, iconChanged }
}


function applyTokenProps({ ctx, token, props, source }){
	let keptIds = []
	let changed = false
	let iconChanged = false

	for(let [key, value] of Object.entries(props)){
		let existing = ctx.db.core.tokenProps.readOne({
			where: { token, key, source }
		})

		if(value == null){
			if(existing){
				ctx.db.core.tokenProps.deleteOne({ where: { id: existing.id } })
				changed = true
				if(key === 'icon')
					iconChanged = true
			}
			continue
		}

		if(!existing){
			let created = ctx.db.core.tokenProps.createOne({
				data: { token, key, value, source }
			})
			keptIds.push(created.id)
			changed = true
			if(key === 'icon')
				iconChanged = true
		}else{
			keptIds.push(existing.id)

			if(valuesDiffer(existing.value, value)){
				ctx.db.core.tokenProps.updateOne({
					data: { value },
					where: { id: existing.id }
				})
				changed = true
				if(key === 'icon')
					iconChanged = true
			}
		}
	}

	return { keptIds, changed, iconChanged }
}


// Delete every prop row for `source` whose id is not in `keptIds`, in bounded
// chunks (so the IN(...) list never approaches SQLite's variable limit) and
// yielding between chunks. Returns the distinct subjects that had rows removed.
async function sweepStaleProps({ ctx, table, keptIds, source }){
	let existing = withSyncOp(
		`sweepStaleProps[${source}].scan`,
		() => ctx.db.core[table].readMany({
			where: { source },
			include: table === 'accountProps'
				? { account: true }
				: { token: true }
		})
	)

	let staleIds = []
	let affected = []

	for(let row of existing){
		if(keptIds.has(row.id))
			continue

		staleIds.push(row.id)
		affected.push(table === 'accountProps' ? row.account : row.token)
	}

	for(let i = 0; i < staleIds.length; i += DIFF_CHUNK_SIZE){
		let slice = staleIds.slice(i, i + DIFF_CHUNK_SIZE)

		withSyncOp(
			`sweepStaleProps[${source}].delete`,
			() => ctx.db.core.tx(() => ctx.db.core[table].deleteMany({
				where: { id: { in: slice } }
			}))
		)

		await yieldLoop()
	}

	return affected
}


export async function diffMultiTokenProps({ ctx, tokens, source }){
	let keptIds = new Set()
	let dirty = new Map()
	let iconDirty = new Map()

	for(let i = 0; i < tokens.length; i += DIFF_CHUNK_SIZE){
		let slice = tokens.slice(i, i + DIFF_CHUNK_SIZE)

		withSyncOp(
			`diffMultiTokenProps[${source}].write(${Math.min(i + slice.length, tokens.length)}/${tokens.length})`,
			() => ctx.db.core.tx(() => {
				for(let { currency, issuer, mptIssuanceId, tokenType, props } of slice){
					let token = { currency, issuer, mptIssuanceId, tokenType }
					let { keptIds: ids, changed, iconChanged } = applyTokenProps({ ctx, token, props, source })

					for(let id of ids)
						keptIds.add(id)

					let dirtyKey = JSON.stringify([currency, issuer, mptIssuanceId, tokenType])

					if(changed)
						dirty.set(dirtyKey, token)
					if(iconChanged)
						iconDirty.set(dirtyKey, token)
				}
			})
		)

		await yieldLoop()
	}

	let removedFrom = await sweepStaleProps({ ctx, table: 'tokenProps', keptIds, source })

	for(let token of dedupeTokens([...dirty.values(), ...removedFrom]))
		markCacheDirtyForTokenProps({ ctx, token })

	for(let token of iconDirty.values())
		markCacheDirtyForTokenIcons({ ctx, token })
}


export async function diffMultiAccountProps({ ctx, accounts, source }){
	let keptIds = new Set()
	let dirty = new Map()
	let iconDirty = new Map()

	for(let i = 0; i < accounts.length; i += DIFF_CHUNK_SIZE){
		let slice = accounts.slice(i, i + DIFF_CHUNK_SIZE)

		withSyncOp(
			`diffMultiAccountProps[${source}].write(${Math.min(i + slice.length, accounts.length)}/${accounts.length})`,
			() => ctx.db.core.tx(() => {
				for(let { address, props } of slice){
					if(!address)
						continue

					let { keptIds: ids, changed, iconChanged } = applyAccountProps({ ctx, account: { address }, props, source })

					for(let id of ids)
						keptIds.add(id)

					if(changed)
						dirty.set(address, { address })
					if(iconChanged)
						iconDirty.set(address, { address })
				}
			})
		)

		await yieldLoop()
	}

	let removedFrom = await sweepStaleProps({ ctx, table: 'accountProps', keptIds, source })

	for(let account of removedFrom)
		dirty.set(account.address ?? `#${account.id}`, account)

	for(let account of dirty.values())
		markCacheDirtyForAccountProps({ ctx, account })

	for(let account of iconDirty.values())
		markCacheDirtyForAccountIcons({ ctx, account })
}


function dedupeTokens(tokens){
	return tokens.filter(
		(token, index, all) => index === all.findIndex(
			({ currency, issuer, mptIssuanceId }) => isSameToken(
				{ ...token, mpt_issuance_id: token.mptIssuanceId },
				{ currency, issuer, mpt_issuance_id: mptIssuanceId }
			)
		)
	)
}


export function readTokenProps({ ctx, token }){
	let props = ctx.db.core.tokenProps.readMany({
		where: {
			token
		}
	})

	let issuerGivenTrustLevelProps = []
	let issuerProps = readAccountProps({
		ctx,
		account: token.issuer
			? token.issuer
			: ctx.db.core.tokens.readOne({ where: token }).issuer
	})

	for(let { key, value, source } of issuerProps){
		if(key !== 'trust_level')
			continue

		let existingTrustProp = props.find(
			prop => prop.key === 'trust_level' && prop.source === source
		)

		if(existingTrustProp){
			existingTrustProp.value = Math.max(existingTrustProp.value, 1)
		}else{
			issuerGivenTrustLevelProps.push({
				key: 'trust_level',
				value,
				source
			})
		}
	}

	if(issuerGivenTrustLevelProps.length > 0){
		let { holders } = readTokenMetrics({
			ctx,
			token,
			metrics: {
				holders: true
			}
		})

		if(holders > 0){
			props.push(...issuerGivenTrustLevelProps)
		}
	}

	return props.map(({ key, value, source }) => ({ key, value, source }))
}

export function writeTokenProps({ ctx, token, props, source }){
	if(Object.keys(props).length === 0)
		return

	ctx.db.core.tx(() => applyTokenProps({ ctx, token, props, source }))

	markCacheDirtyForTokenProps({ ctx, token })

	if(props.hasOwnProperty('icon'))
		markCacheDirtyForTokenIcons({ ctx, token })
}


export function readAccountProps({ ctx, account }){
	let props = ctx.db.core.accountProps.readMany({
		where: {
			account
		}
	})

	let kycProps = props.filter(
		prop => prop.key === 'kyc' && prop.value === true
	)

	for(let { source } of kycProps){
		let trustProp = props.find(
			prop => prop.key === 'trust_level' && prop.source === source
		)

		if(trustProp){
			trustProp.value = Math.max(trustProp.value, 1)
		}else{
			props.push({
				key: 'trust_level',
				value: 1,
				source
			})
		}
	}

	let { domain } = ctx.db.core.accounts.readOne({
		where: account,
		select: {
			domain: true
		}
	})

	if(domain)
		props.push({
			key: 'domain',
			value: domain,
			source: 'ledger'
		})


	return props.map(({ key, value, source }) => ({ key, value, source }))
}

export function writeAccountProps({ ctx, account, props, source }){
	ctx.db.core.tx(() => applyAccountProps({ ctx, account, props, source }))

	markCacheDirtyForAccountProps({ ctx, account })

	if(props.hasOwnProperty('icon'))
		markCacheDirtyForAccountIcons({ ctx, account })
}


export function clearTokenProps({ ctx, token, source }){
	let deletedNum = ctx.db.core.tokenProps.deleteMany({
		where: {
			token,
			source
		}
	})

	if(deletedNum > 0){
		markCacheDirtyForTokenProps({ ctx, token })
		markCacheDirtyForTokenIcons({ ctx, token })
	}
}

export function clearAccountProps({ ctx, account, source }){
	let deletedNum = ctx.db.core.accountProps.deleteMany({
		where: {
			account,
			source
		}
	})

	if(deletedNum > 0){
		markCacheDirtyForAccountProps({ ctx, account })
		markCacheDirtyForAccountIcons({ ctx, account })
	}
}
