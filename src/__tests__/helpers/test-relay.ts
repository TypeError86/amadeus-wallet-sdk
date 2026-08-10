/**
 * Minimal in-process relay for the bridge integration test ONLY.
 *
 * It faithfully implements the two endpoints the BridgeClient uses (POST /message,
 * GET /events long-poll + drain) AND mirrors the validation the deployable relay
 * enforces — channel-id bounds, frame shape, required payload, typed error bodies
 * — so that an SDK-side regression (e.g. dropping the payload or overflowing a
 * channel id) is caught here rather than only in production. It is still NOT the
 * production relay: no TTL sweep, no LRU cap, no size limit. The hardened,
 * deployable relay lives in the standalone `amadeus-wallet-bridge` repo. Do not
 * ship or deploy this.
 */

import http from 'node:http'
import type { Server } from 'node:http'

const MAX_ID_LENGTH = 512

const isValidId = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH

/** Validate the routing fields the relay cares about; payload stays opaque but must exist. */
function frameError(body: string): string | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(body)
	} catch {
		return 'invalid_json'
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'invalid_frame'
	const frame = parsed as Record<string, unknown>
	if (!isValidId(frame.to) || !isValidId(frame.id)) return 'invalid_frame'
	if (frame.from !== undefined && typeof frame.from !== 'string') return 'invalid_frame'
	if (frame.payload === undefined) return 'invalid_frame'
	return null
}

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
		const fail = (status: number, code: string): void =>
			json(status, { error: { code, message: code } })

		if (req.method === 'POST' && url.pathname === '/message') {
			const to = url.searchParams.get('to')
			if (!to) return fail(400, 'missing_to')
			if (!isValidId(to)) return fail(400, 'invalid_channel')
			let body = ''
			for await (const chunk of req) body += chunk
			const err = frameError(body)
			if (err) return fail(400, err)
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
			if (!channel) return fail(400, 'missing_client_id')
			if (!isValidId(channel)) return fail(400, 'invalid_channel')
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

		if (url.pathname === '/message' || url.pathname === '/events') {
			return fail(405, 'method_not_allowed')
		}
		return fail(404, 'not_found')
	})
}
