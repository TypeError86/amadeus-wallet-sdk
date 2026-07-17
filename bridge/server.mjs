/**
 * Amadeus wallet-connect bridge — a dumb, untrusted relay for cross-device
 * dApp <-> wallet messaging. It moves ciphertext frames between two client ids;
 * it never sees plaintext (payloads are sealed with the session's shared key).
 *
 * Endpoints:
 *   POST /message?to=<clientId>      body: BridgeFrame JSON  -> queue for recipient
 *   GET  /events?client_id=<id>&wait=<sec>                   -> long-poll; returns
 *                                                              queued frames (JSON array)
 *
 * Zero dependencies (node:http only). Run standalone:
 *   node bridge/server.mjs            # PORT env, default 8787
 * Or embed:  import { createBridgeServer } from './bridge/server.mjs'
 */

import http from 'node:http'

const MAX_BODY_BYTES = 64 * 1024 // frames are small (a sealed envelope + ids)

/**
 * @param {{ maxQueue?: number, ttlMs?: number, maxWaitSeconds?: number }} [opts]
 * @returns {import('node:http').Server}
 */
export function createBridgeServer(opts = {}) {
	const maxQueue = opts.maxQueue ?? 200
	const ttlMs = opts.ttlMs ?? 120_000
	const maxWaitSeconds = opts.maxWaitSeconds ?? 30

	/** @type {Map<string, { frame: unknown, at: number }[]>} */
	const queues = new Map()
	/** @type {Map<string, Array<() => void>>} */
	const waiters = new Map()

	const now = () => Date.now()

	function enqueue(to, frame) {
		const q = queues.get(to) ?? []
		q.push({ frame, at: now() })
		while (q.length > maxQueue) q.shift()
		queues.set(to, q)
		const w = waiters.get(to)
		if (w && w.length) {
			waiters.set(to, [])
			for (const wake of w) wake()
		}
	}

	function drain(clientId) {
		const t = now()
		const q = (queues.get(clientId) ?? []).filter((e) => t - e.at < ttlMs)
		queues.set(clientId, [])
		return q.map((e) => e.frame)
	}

	function sendJson(res, status, value) {
		const body = JSON.stringify(value)
		res.writeHead(status, {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type'
		})
		res.end(body)
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

		if (req.method === 'OPTIONS') {
			sendJson(res, 204, {})
			return
		}

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
			const clientId = url.searchParams.get('client_id')
			if (!clientId) return sendJson(res, 400, { error: 'missing client_id' })
			const wait = Math.min(Number(url.searchParams.get('wait') ?? 25) || 25, maxWaitSeconds)

			const existing = drain(clientId)
			if (existing.length) return sendJson(res, 200, existing)

			let settled = false
			const finish = () => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				sendJson(res, 200, drain(clientId))
			}
			const timer = setTimeout(finish, wait * 1000)
			const list = waiters.get(clientId) ?? []
			list.push(finish)
			waiters.set(clientId, list)
			req.on('close', () => {
				settled = true
				clearTimeout(timer)
			})
			return
		}

		if (req.method === 'GET' && url.pathname === '/health') {
			return sendJson(res, 200, { ok: true })
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
