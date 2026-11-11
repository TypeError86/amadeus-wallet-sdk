/**
 * The typed public contract every Amadeus dApp already depends on — the injected
 * `window.amadeus` provider — plus the request/response shapes and event names.
 * These mirror the wallet extension exactly; changing a name or shape breaks live
 * dApps, so treat this file as the compatibility surface.
 */

import { NETWORKS, PROVIDER_EVENTS } from './constants'

export type AmadeusNetwork = (typeof NETWORKS)[number]

export type AmadeusProviderEvent = (typeof PROVIDER_EVENTS)[number]

export interface SignTransactionRequest {
	contract: string
	method: string
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	args: any[]
	description?: string
}

export interface SignTransactionResponse {
	txHash: string
	/** Packed transaction bytes as a plain number[] (fed into `new Uint8Array(...)`). */
	txPacked: number[]
}

export interface GenerateApiKeyRequest {
	aud: string
	/** Lifetime in seconds. */
	exp_in: number
}

export interface GenerateApiKeyResponse {
	apiKey: string
}

/** ISO 8601 string (`new Date().toISOString()`), as the extension emits it. */
export type AmadeusEventTimestamp = string

/** How the wallet surfaced an approval prompt. */
export type AmadeusShownAs = 'sidepanel' | 'popup' | 'window'

/** Event payloads emitted through the provider's `.on(name, cb)` channel. */
export interface AmadeusEventPayloadMap {
	accountsChanged: {
		accounts: string[]
		previousAccounts: string[]
		timestamp: AmadeusEventTimestamp
	}
	connect: { accounts: string[]; network: string; timestamp: AmadeusEventTimestamp }
	disconnect: { reason?: string; timestamp: AmadeusEventTimestamp }
	lock: { reason?: string; timestamp: AmadeusEventTimestamp }
	unlock: { accounts: string[]; network: string; timestamp: AmadeusEventTimestamp }
	networkChanged: {
		network: string
		previousNetwork: string
		timestamp: AmadeusEventTimestamp
	}
	/** A signTransaction approval prompt was surfaced; the sign promise still settles later. */
	shown: { requestId: string; shownAs: AmadeusShownAs; timestamp: AmadeusEventTimestamp }
}

/** One of this origin's queued wallet requests, as returned by `getPendingRequests()`. */
export interface PendingRequestSummary {
	type: 'sign' | 'apiKey' | 'switchNetwork' | 'switchAccount' | 'connection'
	id: string
	/** Milliseconds since epoch when the wallet queued the request. */
	timestamp: number
}

/**
 * The injected provider interface. This is the object a dApp reads off
 * `window.amadeus`. Do not rename methods — dApps call them directly.
 */
export interface AmadeusProvider {
	readonly isAmadeus: boolean
	isConnected(): Promise<boolean>
	getAccount(): Promise<string | null>
	getNetwork(): Promise<string>
	requestAccounts(): Promise<string[]>
	requestSwitchNetwork(network: string): Promise<string>
	/**
	 * Ask the wallet to make another of its accounts active. `target` is an optional
	 * Base58 address hint; the wallet always confirms with the user (and presents its
	 * own account chooser) before switching, so a dApp can never switch silently.
	 * Resolves to the new active account's Base58 address. Optional: wallets that
	 * predate it lack the method.
	 */
	requestSwitchAccount?(target?: string): Promise<string>
	/** This origin's queued requests, oldest first. Optional: extension >= 1.6.0. */
	getPendingRequests?(): Promise<PendingRequestSummary[]>
	/** Cancel one of this origin's own pending requests. Optional: extension >= 1.6.0. */
	cancelRequest?(requestId: string): void
	signTransaction(params: SignTransactionRequest): Promise<SignTransactionResponse>
	generateApiKey(params: GenerateApiKeyRequest): Promise<GenerateApiKeyResponse>
	on<E extends AmadeusProviderEvent>(
		event: E,
		callback: (data: AmadeusEventPayloadMap[E]) => void
	): void
	off<E extends AmadeusProviderEvent>(
		event: E,
		callback: (data: AmadeusEventPayloadMap[E]) => void
	): void
}

declare global {
	var amadeus: AmadeusProvider | undefined
}

/** Return the injected provider if present and genuine, else null. Browser-only. */
export function getAmadeusProvider(): AmadeusProvider | null {
	const candidate = (globalThis as { amadeus?: AmadeusProvider }).amadeus
	return candidate && candidate.isAmadeus === true ? candidate : null
}

/** Whether a genuine Amadeus provider is currently injected. */
export function isProviderAvailable(): boolean {
	return getAmadeusProvider() !== null
}
