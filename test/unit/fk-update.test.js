import { expect } from 'chai'
import { createContext } from './env.js'


const ISSUER = 'rMrCiKUV4wUNXYJvZn2zQwd7BkSim2JJ3A'


// Regression: structdb updateOne must accept a node-FK value of the form { id }
// (set the foreign key to that id) instead of throwing "recursive updates not yet
// implemented". This is the crash that took the live node into a backfill loop when
// re-writing an existing NFTokenOffer row to populate its denormalized `collection`.
describe('structdb: updateOne can set a foreign key from { id }', () => {
	it('sets a nullable FK column via updateOne without throwing', async () => {
		let ctx = await createContext()

		let collection = ctx.db.core.nftCollections.createOne({
			data: { issuer: { address: ISSUER }, taxon: 1, firstSeenLedger: 1 }
		})

		// Row created WITHOUT the collection FK (as legacy offer rows were).
		let nft = ctx.db.core.nfts.createOne({
			data: { issuer: { address: ISSUER }, tokenId: 'AB'.repeat(32) }
		})

		// Previously threw `recursive updates not yet implemented`.
		ctx.db.core.nfts.updateOne({
			data: { collection: { id: collection.id } },
			where: { id: nft.id }
		})

		let updated = ctx.db.core.nfts.readOne({
			where: { id: nft.id },
			include: { collection: true }
		})
		expect(updated.collection.id).to.equal(collection.id)
	})
})
