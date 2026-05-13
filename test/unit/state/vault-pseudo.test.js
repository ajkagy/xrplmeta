import { expect } from 'chai'
import { createContext } from '../env.js'
import { applyLedgerStateFromTransactions } from '../../../src/ledger/state/index.js'
import { collectPseudoFromDeltas } from '../../../src/ledger/state/pseudoaccounts.js'


const VAULT_OWNER  = 'rMrCiKUV4wUNXYJvZn2zQwd7BkSim2JJ3A'
const VAULT_PSEUDO = 'rKwsswRD2LvRMWjRh5pZthDNJcwWcMeZK8'


describe('Vault pseudo-account detection', () => {
	it('collectPseudoFromDeltas picks up Vault.Account as source=vault', () => {
		let deltas = [
			{ type: 'Vault', final: { Account: VAULT_PSEUDO, Owner: VAULT_OWNER } },
			{ type: 'AccountRoot', final: { Account: VAULT_OWNER, Flags: 0 } },
		]
		let map = collectPseudoFromDeltas(deltas)
		expect(map.get(VAULT_PSEUDO)).to.equal('vault')
		expect(map.has(VAULT_OWNER)).to.be.false
	})

	it('AMM and Vault entries in the same delta list each get their own source', () => {
		let LSF_AMM = 0x02000000
		let amm = 'rsnyc3RYKFrRHgVZ4TJ6PKnPCBtaJkiqig'
		let vault = 'rLVxUvEXhBVxSnMQvyVXj7yEN765nCoQfN'
		let deltas = [
			{ type: 'AccountRoot', final: { Account: amm, Flags: LSF_AMM } },
			{ type: 'Vault', final: { Account: vault, Owner: VAULT_OWNER } },
		]
		let map = collectPseudoFromDeltas(deltas)
		expect(map.get(amm)).to.equal('amm')
		expect(map.get(vault)).to.equal('vault')
	})

	it('Applying a VaultCreate transaction marks the pseudo-account in the DB', async () => {
		let ctx = await createContext()

		let ledger = {
			sequence: 200,
			transactions: [
				{
					Account: VAULT_OWNER,
					TransactionType: 'VaultCreate',
					hash: 'TX-VAULT',
					Fee: '12',
					metaData: {
						TransactionResult: 'tesSUCCESS',
						AffectedNodes: [
							{ CreatedNode: {
								LedgerEntryType: 'AccountRoot',
								LedgerIndex: 'ACCT-VAULT',
								NewFields: { Account: VAULT_PSEUDO, Balance: '10000000', Flags: 0 }
							} },
							{ CreatedNode: {
								LedgerEntryType: 'Vault',
								LedgerIndex: 'VAULT-1',
								NewFields: {
									Owner: VAULT_OWNER,
									Account: VAULT_PSEUDO,
									Asset: { currency: 'XRP' },
									AssetsTotal: '0',
									AssetsAvailable: '0',
									Flags: 0
								}
							} },
						]
					}
				}
			]
		}

		applyLedgerStateFromTransactions({ ctx: { ...ctx, ledgerSequence: 200 }, ledger })

		let acc = ctx.db.core.accounts.readOne({ where: { address: VAULT_PSEUDO } })
		expect(acc, 'pseudo account row exists').to.not.be.null
		expect(acc.pseudo, 'pseudo flag set').to.be.true
		expect(acc.pseudoSource, 'source is vault').to.equal('vault')
	})
})
