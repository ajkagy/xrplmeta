// XRPL ripple epoch is 2000-01-01T00:00:00Z = 946684800 unix seconds
const RIPPLE_EPOCH = 946684800

export function unixNow(){
	return Math.floor(Date.now() / 1000)
}

export function wait(ms){
	return new Promise(resolve => setTimeout(resolve, ms))
}

export function rippleToUnix(rippleTime){
	return rippleTime + RIPPLE_EPOCH
}

export function unixToRipple(unixTime){
	return unixTime - RIPPLE_EPOCH
}
