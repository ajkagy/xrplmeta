import os from 'os'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import log from './log.js'
import { parse as parseToml } from 'smol-toml'


const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)


function toCamelCase(str){
	return str.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
}

function camelKeys(value){
	if(Array.isArray(value))
		return value.map(camelKeys)

	if(value && typeof value === 'object' && value.constructor === Object){
		let out = {}
		for(let [key, v] of Object.entries(value))
			out[toCamelCase(key)] = camelKeys(v)
		return out
	}

	return value
}

export function find(){
	let preferredPath = path.join(os.homedir(), '.xrplmeta', 'config.toml')
	let paths = ['config.toml', preferredPath]

	for(let path of paths){
		if(fs.existsSync(path))
			return path
	}

	return preferredPath
}


export function load(file, createIfMissing){
	if(!fs.existsSync(file)){
		log.warn(`no config at "${file}" - creating new from template`)

		if(createIfMissing)
			create(file)
	}

	let content = fs.readFileSync(file, 'utf-8')
	let config = camelKeys(parseToml(content))

	validate(config)

	return config
}


function validate(config){
	if(!config.node || typeof config.node.dataDir !== 'string')
		throw new Error(`config: [NODE].data_dir must be a string path`)

	if(config.server){
		if(typeof config.server.port !== 'number' || config.server.port < 0 || config.server.port > 65535)
			throw new Error(`config: [SERVER].port must be a port number 0..65535`)
	}

	if(!config.ledger || !Array.isArray(config.ledger.source) || config.ledger.source.length === 0)
		log.warn(`config: no [[LEDGER.SOURCE]] entries — indexer cannot connect to a rippled/clio node`)
}

export function create(file){
	let dir = path.dirname(file)
	let root = path.dirname(process.argv[1])
	let templatePath = path.join(__dirname, '../../config.template.toml')
	let template = fs.readFileSync(templatePath, 'utf-8')
	let customizedTemplate = template
		.replace(
			'data_dir = "<path to empty folder>"', 
			`data_dir = "${dir.replace(/\\/g, '\\\\')}"`
		)

	if(!fs.existsSync(dir))
		fs.mkdirSync(dir)

	fs.writeFileSync(file, customizedTemplate)
}

export function override(config, ...overrides){
	if (!overrides.length) 
		return config

	let source = overrides.shift()

	if(isObject(config) && isObject(source)){
		for (const key in source){
			if(isObject(source[key])){
				if(!config[key]) 
					Object.assign(config, { [key]: {} })

				override(config[key], source[key])
			}else{
				Object.assign(config, { [key]: source[key] })
			}
		}
	}

	return override(config, ...overrides)
}

function isObject(item) {
	return item && typeof item === 'object' && !Array.isArray(item)
}