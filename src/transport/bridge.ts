/**
 * Client for the cross-device relay ("bridge"). After the connect handshake, the
 * dApp and wallet each hold an x25519 session key — that key doubles as their
 * bridge client id. Each side listens for frames addressed to its own id and
 * sends frames to the peer's id. The relay is DUMB and UNTRUSTED: every frame's
 * payload is a sealed envelope (see box.ts / envelope.ts), so the relay only ever
 * moves ciphertext.
 *
 * Transport is long-polling over `fetch` — universal across Node, browsers, and
 * React Native (no EventSource/streaming dependency).
 */

import type { SealedEnvelope } from '../crypto/box'
import { WalletSdkError } from '../errors'

export interface BridgeFrame {
	/** Sender's bridge client id (x25519 session pubkey, Base58). */
	from: string
	/** Recipient's bridge client id. */
	to: string
	/** Unique frame id (also the request/response id) — for dedupe. */
	id: string
	/** The sealed, E2E-encrypted request or response. */
	payload: SealedEnvelope
}

export interface BridgeClientOptions {
	/** Relay base URL, e.g. "https://bridge.ama.one". */
	bridgeUrl: string
	/** This side's client id (its x25519 session public key, Base58). */
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
		this.bridgeUrl = options.bridgeUrl.replace(/\/$/, '')
		this.clientId = options.clientId
		this.fetchImpl = options.fetchImpl ?? fetch
		this.pollWaitSeconds = options.pollWaitSeconds ?? 25
	}

	/** Send a sealed frame to the peer client id. */
	async send(to: string, id: string, payload: SealedEnvelope): Promise<void> {
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
	 * Start long-polling for frames addressed to this client. Returns a `stop()`
	 * function. `onFrame` is invoked per received frame; transient errors go to
	 * `onError` (if given) and the loop retries after a short backoff.
	 */
	start(
		onFrame: (frame: BridgeFrame) => void | Promise<void>,
		onError?: (error: unknown) => void
	): () => void {
		const controller = new AbortController()

		const loop = async () => {
			while (!controller.signal.aborted) {
				try {
					const url = `${this.bridgeUrl}/events?client_id=${encodeURIComponent(this.clientId)}&wait=${this.pollWaitSeconds}`
					const res = await this.fetchImpl(url, { signal: controller.signal })
					if (!res.ok) {
						throw new WalletSdkError(
							'SUBMIT_FAILED',
							`bridge poll failed: ${res.status}`
						)
					}
					const frames = (await res.json()) as BridgeFrame[]
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
