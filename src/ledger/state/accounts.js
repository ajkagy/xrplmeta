import { div } from '../../../vendor/xfl/wrappers/class.js'
import { isBlackholed } from '../../xrpl/blackhole.js'
import { writeBalance } from '../../db/helpers/balances.js'
import { markCacheDirtyForAccountProps } from '../../cache/todo.js'
import { pseudoAccountInfo } from './pseudoaccounts.js'
import TokenType from '../../xrpl/tokentype.js'


// AccountRoot flags that mark a pseudo-account (no human owner).
const LSF_AMM = 0x02000000
const LSF_DISABLE_MASTER = 0x00100000

function pseudoInfo(flags){
	if((flags & LSF_AMM) !== 0)
		return { pseudo: true, pseudoSource: 'amm' }
	return { pseudo: false, pseudoSource: undefined }
}

export function parse({ entry }){
	let flags = entry.Flags || 0
	let { pseudo, pseudoSource } = pseudoInfo(flags)
	return {
		address: entry.Account,
		balance: div(entry.Balance ?? '0', '1000000'),
		ledgerSequence: entry.LedgerSequence,
		emailHash: entry.EmailHash,
		transferRate: entry.TransferRate,
		blackholed: isBlackholed(entry),
		pseudo,
		pseudoSource,
		domain: decodeDomain(entry.Domain),
	}
}

function decodeDomain(hex){
	if(!hex || typeof hex !== 'string') return undefined
	if(!/^[0-9A-Fa-f]+$/.test(hex)) return undefined
	try{
		return Buffer.from(hex, 'hex').toString('utf8')
	}catch{
		return undefined
	}
}

export function diff({ ctx, previous, final }){
	let address = final?.address || previous?.address

	// If the pre-scan or DB indicates this address is a pseudo-account from a source other
	// than the AccountRoot flag (e.g. a Vault entry in the same ledger references this account),
	// honor that — the AccountRoot's flag-based check might have missed it.
	let override = pseudoAccountInfo({ ctx, address })

	if(final){
		let { balance, ledgerSequence, ...meta } = final

		if(override.pseudo && !meta.pseudo){
			meta.pseudo = true
			meta.pseudoSource = override.pseudoSource
		}

		var { id } = ctx.db.core.accounts.createOne({
			data: ctx.backwards
				? { address }
				: meta
		})

		if(final?.domain != previous?.domain)
			markCacheDirtyForAccountProps({ ctx, account: final })
	}else{
		var { id } = ctx.db.core.accounts.createOne({ 
			data: {
				address
			}
		})
	}

	if(ctx.backwards && !previous){
		// edge case when backfilling AccountRoot deletions
		writeBalance({
			ctx,
			account: { id },
			token: {
				currency: 'XRP',
				issuer: null,
				tokenType: TokenType.XRP
			},
			ledgerSequence: ctx.ledgerSequence,
			balance: '0',
		})
	}

	if(final){
		writeBalance({
			ctx,
			account: { id },
			token: {
				currency: 'XRP',
				issuer: null,
				tokenType: TokenType.XRP
			},
			ledgerSequence: final.ledgerSequence,
			balance: final.balance,
		})
	}else{
		writeBalance({
			ctx,
			account: { id },
			token: {
				currency: 'XRP',
				issuer: null,
				tokenType: TokenType.XRP
			},
			ledgerSequence: ctx.ledgerSequence,
			balance: '0',
		})
	}
}