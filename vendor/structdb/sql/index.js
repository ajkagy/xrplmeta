import * as queryBuilders from './queries/index.js'

function compile(tree){
	if(typeof tree === 'string'){
		tree = {
			text: tree
		}
	}else if(Array.isArray(tree)){
		tree = {
			text: `%`,
			join: ` `,
			items: tree,
			values: []
		}
	}

	let text = tree.text
	let values = tree.values || []

	if(tree.items){
		let itemTexts = []
		let itemValues = []

		for(let item of tree.items){
			if(!item)
				continue

			let { text, values } = compile(item)

			itemTexts.push(text)
			itemValues.push(...values)
		}

		text = text.replace('%', itemTexts.join(tree.join || ' '))
		values = [...values, ...itemValues]
	}

	return { text, values }
}




export default Object.entries(queryBuilders).reduce(
	(queries, [key, builder]) => ({ 
		...queries, 
		[key]: args => compile(builder(args))
	}),
	{}
)