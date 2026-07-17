import type { Server } from 'node:http'

export interface BridgeServerOptions {
	/** Max frames held per client id before the oldest is dropped. */
	maxQueue?: number
	/** How long an undelivered frame stays queued (ms). */
	ttlMs?: number
	/** Upper bound on a long-poll hold (seconds). */
	maxWaitSeconds?: number
}

/** Create the (dependency-free) relay HTTP server. Call `.listen(port)` on it. */
export function createBridgeServer(opts?: BridgeServerOptions): Server
