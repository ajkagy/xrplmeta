// Handler for the Vault ledger entry type (amendment: SingleAssetVault).
// https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/vault
//
// VaultID is NOT a stored field — the ledger entry's index (LedgerIndex hash) IS the vault's identity.
// Share issuance is referenced via ShareMPTID (points at the share MPTokenIssuance entry).

import TokenType from '../../xrpl/tokentype.js'

export function parse({ index, entry }){
	if(!entry.Owner)
		return undefined

	return {
		vaultId: index,
		owner: { address: entry.Owner },
		// The Vault's pseudo-account that holds the locked assets. Distinct from Owner.
		pseudoAddress: entry.Account,
		asset: tokenFromAsset(entry.Asset),
		shareMptId: entry.ShareMPTID,
		assetsTotal: entry.AssetsTotal,
		assetsAvailable: entry.AssetsAvailable,
		assetsMaximum: entry.AssetsMaximum,
		flags: entry.Flags || 0,
		ledgerSequence: entry.LedgerSequence
	}
}

export function diff({ ctx, previous, final }){
	if(!ctx.db?.core?.vaults)
		return

	if(final){
		ctx.db.core.vaults.createOne({
			data: {
				vaultId: final.vaultId,
				owner: final.owner,
				pseudoAccount: final.pseudoAddress ? { address: final.pseudoAddress } : undefined,
				assetToken: final.asset,
				shareMptId: final.shareMptId,
				assetsTotal: final.assetsTotal,
				assetsAvailable: final.assetsAvailable,
				assetsMaximum: final.assetsMaximum,
				flags: final.flags,
				ledgerSequence: final.ledgerSequence
			}
		})

		// Mark the vault's pseudo-account explicitly. The pre-scan in pseudoaccounts.js
		// also catches this for same-ledger detection, but this ensures the DB record
		// has pseudoSource='vault' persisted for future lookups.
		if(final.pseudoAddress){
			ctx.db.core.accounts.createOne({
				data: {
					address: final.pseudoAddress,
					pseudo: true,
					pseudoSource: 'vault'
				}
			})
		}
	}else if(previous){
		try{
			ctx.db.core.vaults.deleteOne({
				where: { vaultId: previous.vaultId }
			})
		}catch{
			// already deleted or never recorded
		}
	}
}

function tokenFromAsset(asset){
	if(!asset) return undefined
	if(asset.currency === 'XRP' || (!asset.currency && !asset.mpt_issuance_id))
		return { currency: 'XRP', tokenType: TokenType.XRP }
	if(asset.mpt_issuance_id)
		return { mptIssuanceId: asset.mpt_issuance_id, tokenType: TokenType.MPT }
	return {
		currency: asset.currency,
		issuer: asset.issuer ? { address: asset.issuer } : undefined,
		tokenType: TokenType.IOU
	}
}
