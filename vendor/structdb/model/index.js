import { createOne } from './operations/create.js'
import { read, count, readRaw } from './operations/read.js'
import { update } from './operations/update.js'
import { remove } from './operations/delete.js'



export function create({ database, struct }){
	return {
		struct,
		
		createOne(args){
			return createOne({
				...args,
				database,
				struct
			})
		},

		readOne(args = {}){
			return (
				read({
					...args,
					take: args.last ? -1 : 1,
					database,
					struct
				})
			)[0]
		},

		readLast(args = {}){
			return (
				read({
					...args,
					take: -1,
					database,
					struct
				})
			)[0]
		},

		readOneRaw(args = {}){
			return readRaw({
				...args,
				database,
				struct
			})[0]
		},

		readMany(args = {}){
			return read({
				...args,
				database,
				struct
			})
		},

		readManyRaw(args = {}){
			return readRaw({
				...args,
				database,
				struct
			})
		},

		readGrouped({ by, ...args }){
			return read({
				...args,
				groupBy: by,
				database,
				struct
			})
		},

		iter({ dedicated = true, ...args } = {}){
			if(dedicated){
				let readAccess = database.clone({ 
					readonly: true 
				})

				let iter = read({
					...args,
					database: readAccess,
					struct,
					iter: true
				})

				iter.done.then(readAccess.close)

				return iter
			}else{
				return read({
					...args,
					database: database,
					struct,
					iter: true
				})
			}
		},

		updateOne(args){
			return update({
				...args,
				database,
				struct,
				take: 1
			})[0]
		},

		updateMany(args){
			return update({
				...args,
				database,
				struct
			})
		},

		deleteOne(args = {}){
			return remove({
				...args,
				database,
				struct,
				limit: 1
			}).affectedRows === 1
		},

		deleteMany(args = {}){
			return remove({
				...args,
				database,
				struct
			}).affectedRows
		},

		count(args = {}){
			return count({
				...args,
				database,
				struct
			})
		},
	}
}
