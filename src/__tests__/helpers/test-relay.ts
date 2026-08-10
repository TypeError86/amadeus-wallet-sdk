/**
 * Minimal in-process relay for the bridge integration test ONLY.
 *
 * It faithfully implements the two endpoints the BridgeClient uses (POST /message,
 * GET /events long-poll + drain) so the test can exercise the real client/protocol
 * — but it is NOT the production relay. The deployable, hardened relay lives in the
 * standalone `amadeus-wallet-bridge` repo. Do not ship or deploy this.
 */

import http from 'node:http'
import type { Server } from 'node:http'

export function createTestRelay(): Server {
	const queues = new Map<string, unknown[]>()
	const waiters = new Map<string, Array<() => void>>()

	const drain = (channel: string): unknown[] => {
		const q = queues.get(channel) ?? []
		queues.delete(channel)
		return q
	}

	return http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost')
		const json = (status: number, value: unknown): void => {
			res.writeHead(status, { 'content-type': 'application/json' })
			res.end(JSON.stringify(value))
		}

		if (req.method === 'POST' && url.pathname === '/message') {
			const to = url.searchParams.get('to')
			if (!to) return json(400, { error: 'missing to' })
			let body = ''
			for await (const chunk of req) body += chunk
			const q = queues.get(to) ?? []
			q.push(JSON.parse(body))
			queues.set(to, q)
			const wake = waiters.get(to)
			if (wake) {
				waiters.set(to, [])
				for (const fn of wake) fn()
			}
			return json(200, { ok: true })
		}

		if (req.method === 'GET' && url.pathname === '/events') {
			const channel = url.searchParams.get('client_id')
			if (!channel) return json(400, { error: 'missing client_id' })
			const wait = Number(url.searchParams.get('wait') ?? 25)
			const existing = drain(channel)
			if (existing.length || wait === 0) return json(200, existing)

			let done = false
			const finish = (): void => {
				if (done) return
				done = true
				clearTimeout(timer)
				json(200, drain(channel))
			}
			const timer = setTimeout(finish, wait * 1000)
			const arr = waiters.get(channel) ?? []
			arr.push(finish)
			waiters.set(channel, arr)
			req.on('close', () => {
				done = true
				clearTimeout(timer)
			})
			return
		}

		return json(404, { error: 'not found' })
	})
}
