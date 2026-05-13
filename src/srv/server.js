import log from '../lib/log.js'
import Koa from 'koa'
import websocket from 'koa-easy-ws'
import json from 'koa-json'
import { RateLimiter } from 'limiter'
import { createRouter } from './http.js'
import { createManager } from './ws.js'
import { spawnWorkers } from './worker.js'


const WS_MAX_PAYLOAD = 1 * 1024 * 1024              // 1 MiB
const DEFAULT_RATE_LIMIT_PER_MINUTE = 240            // 4 req/sec/IP average


function createRateLimitMiddleware({ perMinute }){
	let buckets = new Map()
	let lastSweep = Date.now()

	return async (ctx, next) => {
		let now = Date.now()
		if(now - lastSweep > 60_000){
			for(let [ip, bucket] of buckets){
				if(now - bucket.lastUse > 5 * 60_000)
					buckets.delete(ip)
			}
			lastSweep = now
		}

		let ip = ctx.request.ip || 'unknown'
		let bucket = buckets.get(ip)
		if(!bucket){
			bucket = {
				limiter: new RateLimiter({ tokensPerInterval: perMinute, interval: 'minute' }),
				lastUse: now
			}
			buckets.set(ip, bucket)
		}
		bucket.lastUse = now

		let remaining = await bucket.limiter.removeTokens(1).catch(() => -1)
		if(remaining < 0){
			ctx.status = 429
			ctx.body = { error: 'rate_limited', message: 'too many requests' }
			return
		}

		await next()
	}
}


export async function startServer({ ctx }){
	if(!ctx.config.server.publicUrl){
		let fallbackUrl = `http://localhost:${ctx.config.server.port}`

		log.warn(`public URL not set in config - using fallback: ${fallbackUrl}\n >> consider setting "public_url" in the [SERVER] stanza of your config.toml`)

		ctx = {
			...ctx,
			config: {
				...ctx.config,
				server: {
					...ctx.config.server,
					publicUrl: fallbackUrl
				}
			}
		}
	}

	ctx = {
		...ctx,
		workers: await spawnWorkers({ ctx })
	}

	let koa = new Koa()
	let router = createRouter({ ctx })
	let ws = createManager({ ctx })

	let rateLimit = ctx.config.server.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE
	if(rateLimit > 0)
		koa.use(createRateLimitMiddleware({ perMinute: rateLimit }))

	koa.use(websocket({ maxPayload: ctx.config.server.wsMaxPayloadBytes ?? WS_MAX_PAYLOAD }))
	koa.use(async (ctx, next) => {
		ctx.req.on('error', error => {
			log.debug(`client error: ${error.message}`)
		})

		if(ctx.ws){
			ctx.req.socket.ignoreTimeout = true
			ws.registerSocket(await ctx.ws())
		}else{
			return await next(ctx)
		}
	})

	koa.use(json({ pretty: true }))
	koa.use(router.routes(), router.allowedMethods())

	koa.listen(ctx.config.server.port)
		.on('clientError', (error, socket) => {
			if(error.code === 'ERR_HTTP_REQUEST_TIMEOUT' && socket.ignoreTimeout)
				return

			log.debug(`client error:`, error)
			socket.destroy()
		})
		.on('error', error => {
			log.warn(`server error: ${error.message}`)
		})


	log.info(`listening on port ${ctx.config.server.port}`)

	await new Promise(resolve => {
		koa.on('close', resolve)
	})
}

console.errorOrg = console.error
console.error = text => /.*Error: (write|read) ECONN.*/g.test(text)
	? undefined
	: console.errorOrg(text)