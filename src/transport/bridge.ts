/**
 * Client for the cross-device relay ("bridge"). After the connect handshake both
 * sides hold a shared key; from it they derive TWO SECRET channel ids (one per
 * direction) via `deriveBridgeChannels`. Each side listens on one channel and
 * sends on the other. Because the channel ids are derived from the shared key —
 * NOT from the public session keys — a third party who only observes the connect
 * handshake cannot address, drain, or flood a session's channels. The relay stays
 * dumb and untrusted: it only moves sealed ciphertext between opaque channel ids.
 *
 * Transport is long-polling over `fetch` — universal across Node, browsers, and
 * React Native (no EventSource/streaming dependency).
 */

import { fromBase58, toBase58 } from '@amadeus-protocol/sdk'
import { sha256 } from '@noble/hashes/sha2'

import { concatBytes, utf8ToBytes } from '../bytes'
import { WalletSdkError } from '../errors'

/** Max bytes we will read from a (possibly hostile) relay response. */
const MAX_POLL_RESPONSE_BYTES = 8 * 1024 * 1024

export interface BridgeFrame {
	/** Sender channel (informational). */
	from: string
	/** Recipient channel id this frame is addressed to. */
	to: string
	/** Unique frame id (also the request/response id) — for dedupe. */
	id: string
	/**
	 * The JSON payload. Post-connect this is a sealed (E2E-encrypted) envelope;
	 * the ONE exception is the connect response (public handshake data, integrity
	 * protected by the connect signature) sent on the connect channel before a
	 * shared key exists.
	 */
	payload: unknown
}

/**
 * Derive the two per-direction secret channel ids from the session shared key.
 * Both sides compute the same pair; a third party without the shared key cannot.
 */
export function deriveBridgeChannels(sharedKey: Uint8Array): {
	/** Channel the wallet listens on / the dApp sends to. */
	toWallet: string
	/** Channel the dApp listens on / the wallet sends to. */
	toDapp: string
} {
	const channel = (label: string) => toBase58(sha256(concatBytes(utf8ToBytes(label), sharedKey)))
	return {
		toWallet: channel('amadeus-bridge/to-wallet/v1'),
		toDapp: channel('amadeus-bridge/to-dapp/v1')
	}
}

/**
 * Channel the dApp listens on for the CONNECT RESPONSE (cross-device / QR), before
 * a shared key exists. Derived from the dApp's PUBLIC session key (which is in the
 * connect QR), so the dApp can listen for it immediately. The response carried
 * here is public handshake data whose integrity is verified by the connect
 * signature (`verifyConnect`), so a forged response is rejected.
 */
export function deriveConnectChannel(dappPublicKeyBase58: string): string {
	return toBase58(
		sha256(
			concatBytes(utf8ToBytes('amadeus-bridge/connect/v1'), fromBase58(dappPublicKeyBase58))
		)
	)
}

/**
 * Reject a bridge URL that isn't https (http is allowed only for localhost dev).
 * Blocks the wallet being pointed at file://, internal http hosts, or other
 * SSRF/forced-beacon targets by an attacker-supplied connect link.
 */
export function assertAllowedBridgeUrl(url: string): void {
	const match = /^([a-z][a-z0-9+.-]*):\/\/([^/:?#]+)/i.exec(url)
	if (!match) {
		throw new WalletSdkError('INVALID_ARGUMENT', 'bridge URL is not a valid absolute URL')
	}
	const scheme = match[1].toLowerCase()
	const host = match[2].toLowerCase()
	const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
	if (scheme === 'https' || (scheme === 'http' && isLocal)) return
	throw new WalletSdkError(
		'INVALID_ARGUMENT',
		'bridge URL must be https (http allowed only for localhost)'
	)
}

export interface BridgeClientOptions {
	/** Relay base URL, e.g. "https://bridge.ama.one". */
	bridgeUrl: string
	/** This side's channel id to listen on (from `deriveBridgeChannels`). */
	clientId: string
	/** Override fetch (tests / non-standard runtimes). */
	fetchImpl?: typeof fetch
	/** How long the relay holds a long-poll before returning empty (seconds). */
	pollWaitSeconds?: number
}

export class BridgeClient {
	private readonly bridgeUrl: string
	private readonly clientId: string
	private readonly fetchImpl: typeof fetch
	private readonly pollWaitSeconds: number

	constructor(options: BridgeClientOptions) {
		assertAllowedBridgeUrl(options.bridgeUrl)
		this.bridgeUrl = options.bridgeUrl.replace(/\/$/, '')
		this.clientId = options.clientId
		// Bind to the global: a bare `fetch` reference called as `this.fetchImpl(...)`
		// is detached from its global and throws "Illegal invocation" in browsers
		// (WebIDL requires `this` to be the Window/WorkerGlobalScope). Node/RN tolerate
		// it, which is why this only surfaces in a real browser dApp.
		this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
		this.pollWaitSeconds = options.pollWaitSeconds ?? 25
	}

	/** Send a frame (sealed envelope, or plaintext connect response) to a channel id. */
	async send(to: string, id: string, payload: unknown): Promise<void> {
		const frame: BridgeFrame = { from: this.clientId, to, id, payload }
		const res = await this.fetchImpl(`${this.bridgeUrl}/message?to=${encodeURIComponent(to)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(frame)
		})
		if (!res.ok) {
			throw new WalletSdkError('SUBMIT_FAILED', `bridge send failed: ${res.status}`)
		}
	}

	/**
	 * Start long-polling for frames on this client's channel. Returns a `stop()`
	 * function. `onFrame` is invoked per received frame; transient errors go to
	 * `onError` (if given) and the loop retries after a short backoff. Each poll
	 * has a hard timeout and a response-size cap so a hostile/hung relay can't
	 * stall the loop or exhaust memory.
	 */
	start(
		onFrame: (frame: BridgeFrame) => void | Promise<void>,
		onError?: (error: unknown) => void
	): () => void {
		const controller = new AbortController()

		const poll = async (): Promise<BridgeFrame[]> => {
			const timeout = setTimeout(() => controller.abort(), (this.pollWaitSeconds + 10) * 1000)
			try {
				const url = `${this.bridgeUrl}/events?client_id=${encodeURIComponent(this.clientId)}&wait=${this.pollWaitSeconds}`
				const res = await this.fetchImpl(url, { signal: controller.signal })
				if (!res.ok) {
					throw new WalletSdkError('SUBMIT_FAILED', `bridge poll failed: ${res.status}`)
				}
				const declared = Number(res.headers.get('content-length') ?? 0)
				if (declared > MAX_POLL_RESPONSE_BYTES) {
					throw new WalletSdkError('SUBMIT_FAILED', 'bridge response too large')
				}
				const text = await res.text()
				if (text.length > MAX_POLL_RESPONSE_BYTES) {
					throw new WalletSdkError('SUBMIT_FAILED', 'bridge response too large')
				}
				const parsed = JSON.parse(text)
				return Array.isArray(parsed) ? (parsed as BridgeFrame[]) : []
			} finally {
				clearTimeout(timeout)
			}
		}

		const loop = async () => {
			while (!controller.signal.aborted) {
				try {
					const frames = await poll()
					for (const frame of frames) {
						if (controller.signal.aborted) break
						await onFrame(frame)
					}
				} catch (error) {
					if (controller.signal.aborted) break
					onError?.(error)
					await new Promise((resolve) => setTimeout(resolve, 1000))
				}
			}
		}

		void loop()
		return () => controller.abort()
	}
}
