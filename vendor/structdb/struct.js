import { create as createCodec, select as selectCodec } from "../structdb-codec/codec.js"


export function generate({ schema, codecs }){
	let tables = []

	function walk(schema, previousNodes = []){
		let previous = previousNodes.find(p => p.schema === schema)
		let node = {}
		let fields = {}
		let relations = {}

		if(previous)
			return previous.node

		for(let [key, prop] of Object.entries(schema.properties)){
			if(prop.type === 'array' && prop.items){
				let referenceKeys = findReferenceKeys(prop.items, schema)

				if(referenceKeys.length === 0){
					relations[key] = {
						key,
						schema: prop.items,
						many: true
					}
				}else if(referenceKeys.length === 1){
					relations[key] = {
						key,
						schema: prop.items,
						referenceKey: referenceKeys[0],
						many: true
					}
				}else{
					console.log(referenceKeys)
					throw 'conflicting relations'
				}
			}else if(prop.type === 'object'){
				let referenceKeys = findReferenceKeys(prop, schema)

				if(referenceKeys.length === 0){
					fields[key] = {
						key,
						type: 'integer'
					}

					relations[key] = {
						key,
						schema: prop
					}
				}else if(referenceKeys.length === 1){
					relations[key] = {
						key,
						referenceKey: referenceKeys[0],
						schema: prop
					}
				}else{
					throw 'conflicting relations'
				}
			}else{
				let codec = selectCodec({ schema: prop, codecs })
				let field = {
					...prop, 
					key
				}

				if(codec){
					field.type = codec.returnsType

					if(field.hasOwnProperty('default'))
						field.default = codec.encode(field.default)
				}

				fields[key] = field
			}
		}

		node.table = createTable({ fields, schema })
		node.nodes = {}

		previousNodes.push({ node, schema })

		for(let { key, schema, ...relation } of Object.values(relations)){
			node.nodes[key] = {
				key,
				...relation,
				...walk(schema, previousNodes),
				...createCodec({ schema, codecs })
			}
		}

		return node
	}

	function createTable({ fields, schema }){
		let table = tables
			.find(t => deepCompare(t.fields, fields))
	
		if(!table){
			tables.push(
				table = {
					fields,
					foreign: {},
					indices: [],
				}
			)
		}
			
		if(!table.name && schema['$ref']){
			table.name = schema['$ref']
				.split('/')
				.slice(-1)
				[0]
		}
	
		if(schema.unique){
			table.indices.push(
				...deriveIndex(schema, 'unique')
					.map(index => ({ ...index, name: `${table.name}:${index.name}`}))
					.map(index => ({ ...index, unique: true }))
			)
		}

		if(schema.index){
			table.indices.push(
				...deriveIndex(schema, 'index')
					.map(index => ({ ...index, name: `${table.name}:${index.name}`}))
			)
		}
	
		for(let [key, field] of Object.entries(table.fields)){
			if(field.id)
				table.idKey = key
	
			field.required = field.required 
				|| !schema.required 
				|| schema.required.includes(field.key)
		}
		
		return table
	}

	return {
		struct: link(
			walk(
				unfold(schema, schema)
			)
		),
		tables: tables.slice(1)
	}
}

export function unfold(schema, node, previousRefNodes = []){
	if(node && typeof node === 'object'){
		let refUrl = node['$ref']

		if(refUrl){
			let refSchema = schema.definitions[refUrl.slice(14)]
			let previousRefNode = previousRefNodes.find(r => r['$ref'] === refUrl)

			if(previousRefNode)
				return previousRefNode
			

			node = { 
				...node,
				...refSchema,  
			}

			previousRefNodes.push(node)
		}

		for(let [key, value] of Object.entries(node)){
			node[key] = unfold(schema, value, previousRefNodes)
		}

		return node
	}else{
		return node
	}
}

function link(struct, linked = []){
	if(linked.includes(struct))
		return struct

	linked.push(struct)

	for(let [key, node] of Object.entries(struct.nodes)){
		if(node.referenceKey){
			node.table.foreign[node.referenceKey] = struct.table
		}else{
			struct.table.foreign[key] = node.table
		}

		link(node, linked)
	}

	return struct
}

function deriveIndex(schema, key){
	let indices = []
	let groups = Array.isArray(schema[key][0])
		? schema[key]
		: schema[key].map(field => [field])

	for(let fields of groups){
		let name = key

		for(let field of fields){
			name += `-${field}`
		}

		indices.push({ name, fields })
	}

	return indices
}

function findReferenceKeys(from, to){
	let keys = []

	for(let [key, prop] of Object.entries(from.properties)){
		if(prop['$ref'] && prop['$ref'] === to['$ref'])
			keys.push(key)
	}
	
	return keys
}

function deepCompare(obj1, obj2, reversed){
	for(let key in obj1){
		if(typeof obj1[key] === 'object' && typeof obj2[key] === 'object'){
			if(!deepCompare(obj1[key], obj2[key])) 
				return false
		}else if(obj1[key] !== obj2[key]) 
			return false
	}

	return reversed ? true : deepCompare(obj2, obj1, true)
}