/**
 * Amadeus wallet-connect bridge — a dumb, untrusted relay for cross-device
 * dApp <-> wallet messaging. It moves ciphertext frames between opaque channel
 * ids; it never sees plaintext (payloads are sealed with the session shared key,
 * and channel ids are derived from that shared key, so only the two session
 * parties can address a channel).
 *
 * Endpoints:
 *   POST /message?to=<channel>      body: BridgeFrame JSON  -> queue for channel
 *   GET  /events?client_id=<chan>&wait=<sec>                -> long-poll; returns
 *                                                             queued frames (JSON array)
 *
 * Hardening (this is a v0.1 reference relay; put a rate-limiting reverse proxy
 * in front for production): frames + queues are TTL-swept, the number of live
 * channels is capped (LRU-evicted), empty queues are deleted, and long-poll
 * waiters are removed on socket close so nothing leaks.
 *
 * Zero dependencies (node:http only). Run standalone:
 *   node bridge/server.mjs            # PORT env, default 8787
 */

import http from 'node:http'

const MAX_BODY_BYTES = 64 * 1024 // frames are small (a sealed envelope + ids)

/**
 * @param {{ maxQueue?: number, ttlMs?: number, maxWaitSeconds?: number, maxChannels?: number, sweepMs?: number }} [opts]
 * @returns {import('node:http').Server}
 */
export function createBridgeServer(opts = {}) {
	const maxQueue = opts.maxQueue ?? 200
	const ttlMs = opts.ttlMs ?? 120_000
	const maxWaitSeconds = opts.maxWaitSeconds ?? 30
	const maxChannels = opts.maxChannels ?? 50_000
	const sweepMs = opts.sweepMs ?? 30_000

	/** @type {Map<string, { frames: { frame: unknown, at: number }[], lastAt: number }>} */
	const queues = new Map()
	/** @type {Map<string, Set<() => void>>} */
	const waiters = new Map()

	const now = () => Date.now()

	function evictOldestIfFull() {
		if (queues.size < maxChannels) return
		let oldestKey = null
		let oldestAt = Infinity
		for (const [key, q] of queues) {
			if (q.lastAt < oldestAt) {
				oldestAt = q.lastAt
				oldestKey = key
			}
		}
		if (oldestKey !== null) queues.delete(oldestKey)
	}

	function enqueue(to, frame) {
		let q = queues.get(to)
		if (!q) {
			evictOldestIfFull()
			q = { frames: [], lastAt: now() }
			queues.set(to, q)
		}
		q.frames.push({ frame, at: now() })
		q.lastAt = now()
		while (q.frames.length > maxQueue) q.frames.shift()

		const set = waiters.get(to)
		if (set && set.size) {
			const wake = [...set]
			set.clear()
			for (const fn of wake) fn()
		}
	}

	function drain(channel) {
		const q = queues.get(channel)
		if (!q) return []
		const t = now()
		const fresh = q.frames.filter((e) => t - e.at < ttlMs)
		// Empty queue -> delete the key entirely so it can't accumulate.
		queues.delete(channel)
		return fresh.map((e) => e.frame)
	}

	function addWaiter(channel, fn) {
		const set = waiters.get(channel) ?? new Set()
		set.add(fn)
		waiters.set(channel, set)
	}

	function removeWaiter(channel, fn) {
		const set = waiters.get(channel)
		if (!set) return
		set.delete(fn)
		if (set.size === 0) waiters.delete(channel)
	}

	// Periodic sweep: drop stale frames + empty/idle queues so nothing lingers.
	const sweeper = setInterval(() => {
		const t = now()
		for (const [key, q] of queues) {
			q.frames = q.frames.filter((e) => t - e.at < ttlMs)
			if (q.frames.length === 0 && t - q.lastAt > ttlMs) queues.delete(key)
		}
	}, sweepMs)
	if (typeof sweeper.unref === 'function') sweeper.unref()

	function sendJson(res, status, value) {
		res.writeHead(status, {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type'
		})
		res.end(JSON.stringify(value))
	}

	function readBody(req) {
		return new Promise((resolve, reject) => {
			let size = 0
			const chunks = []
			req.on('data', (c) => {
				size += c.length
				if (size > MAX_BODY_BYTES) {
					reject(new Error('body too large'))
					req.destroy()
					return
				}
				chunks.push(c)
			})
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
			req.on('error', reject)
		})
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost')

		if (req.method === 'OPTIONS') return sendJson(res, 204, {})

		if (req.method === 'POST' && url.pathname === '/message') {
			const to = url.searchParams.get('to')
			if (!to) return sendJson(res, 400, { error: 'missing to' })
			try {
				const frame = JSON.parse(await readBody(req))
				enqueue(to, frame)
				return sendJson(res, 200, { ok: true })
			} catch {
				return sendJson(res, 400, { error: 'bad frame' })
			}
		}

		if (req.method === 'GET' && url.pathname === '/events') {
			const channel = url.searchParams.get('client_id')
			if (!channel) return sendJson(res, 400, { error: 'missing client_id' })
			const raw = Number(url.searchParams.get('wait'))
			const wait = Number.isFinite(raw) ? Math.max(0, Math.min(raw, maxWaitSeconds)) : 25

			const existing = drain(channel)
			if (existing.length || wait === 0) return sendJson(res, 200, existing)

			let settled = false
			const finish = () => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				removeWaiter(channel, finish)
				sendJson(res, 200, drain(channel))
			}
			const timer = setTimeout(finish, wait * 1000)
			addWaiter(channel, finish)
			req.on('close', () => {
				settled = true
				clearTimeout(timer)
				removeWaiter(channel, finish)
			})
			return
		}

		if (req.method === 'GET' && url.pathname === '/health') {
			return sendJson(res, 200, { ok: true, channels: queues.size })
		}

		return sendJson(res, 404, { error: 'not found' })
	})

	return server
}

// Run standalone when invoked directly (not when imported).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	const port = Number(process.env.PORT ?? 8787)
	createBridgeServer().listen(port, () => {
		// eslint-disable-next-line no-console
		console.log(`amadeus bridge listening on :${port}`)
	})
}
