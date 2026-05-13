import sql from '../sql/index.js'


export function unflatten({ struct, item }){
	for(let [key, value] of Object.entries(item)){
		let childConf = struct.nodes[key]

		if(childConf && typeof value === 'number'){
			item[key] = { [childConf.table.idKey]: value }
		}
	}

	return item
}

export function composeFilter({ where, include = {}, struct, chain = [] }){
	if(!where)
		return

	let table = ['T', ...chain].join('.')
	let fields = []
	let subqueries = []
	let conditions = []
	let index = 0


	for(let [key, value] of Object.entries(where)){
		index++

		if(key === 'RAW'){
			conditions.push(value)
		}else if(key === 'AND' || key === 'OR'){
			conditions.push({
				text: `(%)`,
				join: ` ${key} `,
				items: value.map(
					condition => composeFilter({ 
						where: condition, 
						include, 
						struct,
						chain
					})
				),
				index
			})
		}else if(key === 'NOT'){
			conditions.push({
				text: `NOT (%)`,
				items: [
					composeFilter({ 
						where: value, 
						include, 
						struct,
						chain
					})
				],
				index
			})
		}else{
			let fieldConf = struct.table.fields[key]
			let childConf = struct.nodes[key]
			let operator = '='

			if(value === null || value === undefined){
				fields.push({ 
					key, 
					table,
					operator: 'IS',
					value: null,
					index
				})
			}else if(childConf && typeof value === 'object'){
				if(value[childConf.table.idKey]){
					//todo: make this less messy
					if(value[childConf.table.idKey].in){
						fields.push({ 
							key, 
							table,
							operator: 'IN', 
							value: value[childConf.table.idKey].in,
							index
						})
					}else{
						fields.push({ 
							key, 
							table,
							operator, 
							value: value[childConf.table.idKey],
							index
						})
					}
				}else{
					if(childConf.many){
						if(Array.isArray(value))
							continue

						conditions.push({
							text: `EXISTS (%)`,
							items: [
								sql.select({
									table: childConf.table.name,
									tableAlias: `${table}.${key}`,
									fields: [childConf.table.idKey],
									where: {
										text: `(%)`,
										join: ` AND `,
										items: [
											{
												text: `"${table}.${key}"."${childConf.referenceKey}" = "${table}"."${struct.table.idKey}"`
											},
											composeFilter({ 
												where: value,
												include: include[key], 
												struct: childConf,
												chain: [...chain, key]
											})
										]
									},
									limit: 1
								})
							],
							index
						})
					/*}else if(include[key]){
						conditions.push({
							...composeFilter({
								where: value, 
								include: include[key], 
								struct: childConf,
								chain: [...chain, key]
							}),
							index
						})*/
					}else{
						subqueries.push({
							key,
							table,
							operator,
							query: sql.select({
								table: childConf.table.name,
								tableAlias: `${table}.${key}`,
								fields: [childConf.table.idKey],
								where: composeFilter({ 
									where: value, 
									include: include[key], 
									struct: childConf,
									chain: [...chain, key]
								}),
								limit: 1
							}),
							index
						})
					}
				}
			}else if(fieldConf){
				if(value.hasOwnProperty('like')){
					value = value.like
					operator = 'LIKE'
				}

				if(value.hasOwnProperty('greaterThan')){
					value = value.greaterThan
					operator = '>'
				}

				if(value.hasOwnProperty('greaterOrEqual')){
					value = value.greaterOrEqual
					operator = '>='
				}

				if(value.hasOwnProperty('lessThan')){
					value = value.lessThan
					operator = '<'
				}

				if(value.hasOwnProperty('lessOrEqual')){
					value = value.lessOrEqual
					operator = '<='
				}

				if(value.hasOwnProperty('in')){
					if(value.in.length === 1){
						value = value.in[0]
					}else{
						value = value.in
						operator = 'IN'
					}
				}

				fields.push({ 
					key,
					table,
					operator,
					value,
					index
				})
			}else{
				throw new Error(`The field "${key}" in the WHERE clause is not specified in the schema`)
			}
		}
	}
	
	let encoded = {}

	for(let { key, operator, value } of fields){
		if(operator === 'IN'){
			encoded[key] = value.map(
				value => struct.encodeField(key, value)
			)
		}else{
			encoded[key] = struct.encodeField(key, value)
		}
	}

	for(let { key, table, operator, index } of fields){
		let value = encoded[key]

		conditions.push({
			text: `"${table}"."${key}" ${operator} %`,
			index,
			items: Array.isArray(value)
				? [{
					text: `(%)`,
					join: `, `,
					items: [...new Set(value)].map(
						(v, i) => ({ text: `?`, values: [v] })
					)
				}]
				: [{ text: `?`, values: [value] }]
		})
	}

	for(let { key, table, operator, query, index } of subqueries){
		conditions.push({
			text: `"${table}"."${key}" ${operator} (%)`,
			items: [query],
			index
		})
	}

	return {
		text: `(%)`,
		join: ` AND `,
		items: conditions
			.sort((a, b) => a.index - b.index)
	}
}