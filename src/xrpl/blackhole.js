const blackholeAccounts = [
	'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
	'rrrrrrrrrrrrrrrrrrrrBZbvji',
	'rrrrrrrrrrrrrrrrrNAMEtxvNvQ',
	'rrrrrrrrrrrrrrrrrrrn5RM1rHd'
]

export function isBlackholed(ledgerEntry){
	if(!blackholeAccounts.includes(ledgerEntry.RegularKey))
		return false

	// master key must be disabled (lsfDisableMaster = 0x00100000)
	if((ledgerEntry.Flags & 0x00100000) === 0)
		return false

	return true
}