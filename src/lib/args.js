// Minimal minimist-compatible argv parser.
//   --foo bar     -> { foo: 'bar' }
//   --foo         -> { foo: true }
//   --no-foo      -> { foo: false }
//   -x            -> { x: true }
//   pos1 pos2     -> { _: ['pos1', 'pos2'] }
export function parseCliArgs(argv){
	let out = { _: [] }
	let i = 0

	while(i < argv.length){
		let arg = argv[i]

		if(arg.startsWith('--')){
			let key = arg.slice(2)
			let eq = key.indexOf('=')
			if(eq !== -1){
				out[key.slice(0, eq)] = coerce(key.slice(eq + 1))
				i++
				continue
			}
			if(key.startsWith('no-')){
				out[key.slice(3)] = false
				i++
				continue
			}
			let next = argv[i + 1]
			if(next !== undefined && !next.startsWith('-')){
				out[key] = coerce(next)
				i += 2
			}else{
				out[key] = true
				i++
			}
		}else if(arg.startsWith('-') && arg.length > 1){
			let key = arg.slice(1)
			let next = argv[i + 1]
			if(next !== undefined && !next.startsWith('-')){
				out[key] = coerce(next)
				i += 2
			}else{
				out[key] = true
				i++
			}
		}else{
			out._.push(arg)
			i++
		}
	}

	return out
}

function coerce(v){
	if(v === 'true') return true
	if(v === 'false') return false
	if(/^-?\d+$/.test(v)) return parseInt(v, 10)
	if(/^-?\d+\.\d+$/.test(v)) return parseFloat(v)
	return v
}
