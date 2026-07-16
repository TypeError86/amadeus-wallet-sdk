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

/** Event payloads emitted through the provider's `.on(name, cb)` channel. */
export interface AmadeusEventPayloadMap {
	accountsChanged: { accounts: string[]; previousAccounts: string[]; timestamp: number }
	connect: { accounts: string[]; network: string; timestamp: number }
	disconnect: { reason?: string; timestamp: number }
	lock: { reason?: string; timestamp: number }
	unlock: { accounts: string[]; network: string; timestamp: number }
	networkChanged: { network: string; previousNetwork: string; timestamp: number }
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
