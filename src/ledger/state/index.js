import log from '../../lib/log.js'
import * as accounts from './accounts.js'
import * as tokens from './tokens.js'
import * as tokenOffers from './tokenoffers.js'
import * as nfts from './nfts.js'
import * as nftOffers from './nftoffers.js'
import * as mptokenIssuance from './mptokenissuance.js'
import * as mptoken from './mptoken.js'
import * as amm from './amm.js'
import * as vault from './vault.js'
import * as oracle from './oracle.js'
import { collectPseudoFromDeltas } from './pseudoaccounts.js'

const ledgerEntryModules = {
	AccountRoot: accounts,
	RippleState: tokens,
	Offer: tokenOffers,
	NFTokenPage: nfts,
	NFTokenOffer: nftOffers,
	MPTokenIssuance: mptokenIssuance,
	MPToken: mptoken,
	AMM: amm,
	Vault: vault,
	Oracle: oracle
}

// Ledger entry types we intentionally ignore — typed below so unknown types still get reported.
const ignoredEntryTypes = new Set([
	'DirectoryNode',
	'LedgerHashes',
	'FeeSettings',
	'Amendments',
	'NegativeUNL',
	'SignerList',
	'Ticket',
	'DepositPreauth',
	'Escrow',
	'Check',
	'PayChannel',
	'DID',
	'Credential',
	'CredentialIssuer',
	'PermissionedDomain',
	'Delegate',
	'Bridge',
	'XChainOwnedClaimID',
	'XChainOwnedCreateAccountClaimID',
	'Loan',
	'LoanBroker'
])

let warnedUnknown = new Set()

function recordUnknownEntryType({ ctx, type }){
	if(ignoredEntryTypes.has(type) || ledgerEntryModules[type])
		return

	let seq = ctx.ledgerSequence ?? ctx.currentLedger?.sequence ?? 0

	if(!warnedUnknown.has(type)){
		warnedUnknown.add(type)
		log.warn(`unknown LedgerEntryType "${type}" — likely from a new amendment. Recording for follow-up.`)
	}

	try{
		let existing = ctx.db?.core?.unknownLedgerEntryTypes?.readOne({ where: { type } })
		if(existing){
			ctx.db.core.unknownLedgerEntryTypes.updateOne({
				data: {
					lastSeenLedger: seq,
					count: (existing.count || 0) + 1
				},
				where: { id: existing.id }
			})
		}else{
			ctx.db?.core?.unknownLedgerEntryTypes?.createOne({
				data: {
					type,
					firstSeenLedger: seq,
					lastSeenLedger: seq,
					count: 1
				}
			})
		}
	}catch{
		// Table might not exist on older databases — best effort only.
	}
}


export function applyLedgerStateFromObjects({ ctx, objects }){
	let deltas = objects.map(entry => ({
		type: entry.LedgerEntryType,
		index: entry.index,
		final: {
			...entry,
			LedgerSequence: entry.PreviousTxnLgrSeq
		}
	}))

	return applyDeltas({
		ctx: withPseudoContext(ctx, deltas),
		deltas
	})
}

export function applyLedgerStateFromTransactions({ ctx, ledger }){
	let deltas = []

	for(let i = 0; i < ledger.transactions.length; i++){
		let transaction = ledger.transactions[i]
		let meta = transaction.meta || transaction.metaData

		for(let { CreatedNode, ModifiedNode, DeletedNode } of meta.AffectedNodes){
			if(CreatedNode && CreatedNode.NewFields){
				deltas.push({
					type: CreatedNode.LedgerEntryType,
					index: CreatedNode.LedgerIndex,
					ledgerSequence: ledger.sequence,
					transactionIndex: i,
					final: {
						...CreatedNode.NewFields,
						LedgerSequence: ledger.sequence
					}
				})
			}else if(ModifiedNode && ModifiedNode.FinalFields){
				if(ModifiedNode.LedgerEntryType === 'DirectoryNode')
					continue

				if(ctx.backwards && !ModifiedNode.PreviousTxnLgrSeq){
					log.warn(`transaction #${transaction.hash} is missing PreviousTxnLgrSeq - skipping`)
					continue
				}

				let previous = {
					...ModifiedNode.FinalFields,
					...ModifiedNode.PreviousFields,
					LedgerSequence: ModifiedNode.PreviousTxnLgrSeq
				}

				// When PreviousFields is empty for an MPToken ModifiedNode, the only
				// changed field had a default (0) prior value. For balance-moving txs
				// that means MPTAmount went 0 -> X, so seed previous.MPTAmount = 0.
				// EXCEPT MPTokenIssuanceSet, which only toggles lock/auth flags and
				// leaves MPTAmount unchanged — injecting 0 there fabricates a 0 -> X
				// balance jump and double-counts supply/holders.
				if(ModifiedNode.LedgerEntryType === 'MPToken'
					&& Object.keys(ModifiedNode.PreviousFields || {}).length === 0
					&& transaction.TransactionType !== 'MPTokenIssuanceSet'){
					previous.MPTAmount = '0'
				}

				deltas.push({
					type: ModifiedNode.LedgerEntryType,
					index: ModifiedNode.LedgerIndex,
					ledgerSequence: ledger.sequence,
					transactionIndex: i,
					previous,
					final: {
						...ModifiedNode.FinalFields,
						LedgerSequence: ledger.sequence
					}
				})
			}else if(DeletedNode){
				if(DeletedNode.LedgerEntryType === 'DirectoryNode')
					continue

				deltas.push({
					type: DeletedNode.LedgerEntryType,
					index: DeletedNode.LedgerIndex,
					ledgerSequence: ledger.sequence,
					transactionIndex: i,
					previous: {
						...DeletedNode.FinalFields,
						...DeletedNode.PreviousFields,
						LedgerSequence: DeletedNode.FinalFields?.PreviousTxnLgrSeq ?? ledger.sequence
					}
				})
			}
		}
	}

	if(ctx.backwards){
		let reversed = deltas
			.map(({ type, index, ledgerSequence, transactionIndex, previous, final }) => ({ type, index, ledgerSequence, transactionIndex, previous: final, final: previous }))
			.reverse()
		return applyDeltas({
			ctx: withPseudoContext(ctx, reversed),
			deltas: reversed
		})
	}else{
		return applyDeltas({
			ctx: withPseudoContext(ctx, deltas),
			deltas
		})
	}
}

function withPseudoContext(ctx, deltas){
	return {
		...ctx,
		pseudoAccounts: collectPseudoFromDeltas(deltas),
		pseudoAccountsCache: new Map()
	}
}

function applyDeltas({ ctx, deltas }){
	let groups = {}
	let solos = []

	for(let { type, index, ledgerSequence, transactionIndex, previous, final } of deltas){
		let module = ledgerEntryModules[type]

		if(!module){
			recordUnknownEntryType({ ctx, type })
			continue
		}

		if(module.skip && module.skip({ ctx }))
			continue

		let parsedPrevious = previous 
			? module.parse({ index, entry: previous }) 
			: undefined

		let parsedFinal = final
			? module.parse({ index, entry: final }) 
			: undefined

		if(!parsedPrevious && !parsedFinal)
			continue

		if(module.group){
			let grouped = module.group({ 
				previous: parsedPrevious, 
				final: parsedFinal 
			})

			for(let { group, previous, final } of grouped){
				if(!groups[group.key])
					groups[group.key] = {
						...group,
						type,
						deltas: []
					}
	
				groups[group.key].deltas.push({
					previous,
					final
				})
			}
		}else{
			solos.push({
				type,
				ledgerSequence,
				transactionIndex,
				previous: parsedPrevious, 
				final: parsedFinal 
			})
		}
	}

	for(let { type, key, ...group } of Object.values(groups)){
		ledgerEntryModules[type].diff({ ctx, ...group })
	}

	for(let { type, ...delta } of solos){
		ledgerEntryModules[type].diff({ ctx, ...delta })
	}
}