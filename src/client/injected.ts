/**
 * A framework-agnostic dApp client over the injected `window.amadeus` provider
 * (the browser extension). It wraps the raw provider with the ergonomics every
 * dApp currently hand-rolls: a single-account `connect`, sign-and-submit, and a
 * cached `ensureApiKey` that decodes expiry via the audited api-key module
 * (replacing the copies in hub / prime-hub).
 *
 * The mobile deep-link/QR path uses the transport module (connect handshake +
 * sealed envelopes) instead of an injected provider; this client is the
 * same-device, extension-present case.
 */

import { decodeApiKey } from '../crypto/apikey'
import { WalletSdkError } from '../errors'
import { submitTransaction } from '../tx'
import type {
	AmadeusEventPayloadMap,
	AmadeusProvider,
	AmadeusProviderEvent,
	SignTransactionRequest,
	SignTransactionResponse
} from '../types'
import { getAmadeusProvider } from '../types'

/** Where a cached api-key lives. Default is in-memory; dApps can pass localStorage-backed. */
export interface ApiKeyStore {
	get(): string | null
	set(apiKey: string): void
}

function memoryApiKeyStore(): ApiKeyStore {
	let value: string | null = null
	return { get: () => value, set: (apiKey) => (value = apiKey) }
}

function isApiKeyValid(apiKey: string, leewaySeconds: number): boolean {
	try {
		const { payload } = decodeApiKey(apiKey)
		return payload.exp > Math.floor(Date.now() / 1000) + leewaySeconds
	} catch {
		return false
	}
}

export interface WalletClient {
	isAvailable(): boolean
	getProvider(): AmadeusProvider | null
	/** Prompt connection; resolves to the connected account (Base58 address). */
	connect(): Promise<string>
	getAccount(): Promise<string | null>
	getNetwork(): Promise<string>
	signTransaction(request: SignTransactionRequest): Promise<SignTransactionResponse>
	/** Sign then submit the packed bytes to a node; resolves to the tx hash + node reply. */
	signAndSubmit(
		request: SignTransactionRequest,
		options: { nodeUrl: string; wait?: boolean }
	): Promise<{ txHash: string; submitted: unknown }>
	/** Return a valid cached api-key, minting (and caching) a fresh one if needed. Coalesces concurrent calls. */
	ensureApiKey(options: {
		aud: string
		expIn: number
		store?: ApiKeyStore
		leewaySeconds?: number
	}): Promise<string>
	on<E extends AmadeusProviderEvent>(
		event: E,
		cb: (data: AmadeusEventPayloadMap[E]) => void
	): void
	off<E extends AmadeusProviderEvent>(
		event: E,
		cb: (data: AmadeusEventPayloadMap[E]) => void
	): void
}

/**
 * Create a client bound to the injected provider. Pass `providerOverride` to
 * inject a provider (e.g. in tests); otherwise it reads `window.amadeus`.
 */
export function createInjectedWalletClient(providerOverride?: AmadeusProvider): WalletClient {
	const getProvider = () => providerOverride ?? getAmadeusProvider()
	const requireProvider = (): AmadeusProvider => {
		const provider = getProvider()
		if (!provider)
			throw new WalletSdkError('INVALID_ARGUMENT', 'Amadeus wallet is not available')
		return provider
	}

	const defaultStore = memoryApiKeyStore()
	let pendingApiKey: Promise<string> | null = null

	return {
		isAvailable: () => getProvider() !== null,
		getProvider,
		connect: async () => {
			const accounts = await requireProvider().requestAccounts()
			if (!accounts.length)
				throw new WalletSdkError('INVALID_ARGUMENT', 'no account returned')
			return accounts[0]
		},
		getAccount: () => requireProvider().getAccount(),
		getNetwork: () => requireProvider().getNetwork(),
		signTransaction: (request) => requireProvider().signTransaction(request),
		signAndSubmit: async (request, options) => {
			const { txHash, txPacked } = await requireProvider().signTransaction(request)
			const submitted = await submitTransaction(txPacked, {
				nodeUrl: options.nodeUrl,
				wait: options.wait
			})
			return { txHash, submitted }
		},
		ensureApiKey: ({ aud, expIn, store = defaultStore, leewaySeconds = 60 }) => {
			const cached = store.get()
			if (cached && isApiKeyValid(cached, leewaySeconds)) return Promise.resolve(cached)
			if (!pendingApiKey) {
				pendingApiKey = requireProvider()
					.generateApiKey({ aud, exp_in: expIn })
					.then(({ apiKey }) => {
						store.set(apiKey)
						return apiKey
					})
					.finally(() => {
						pendingApiKey = null
					})
			}
			return pendingApiKey
		},
		on: (event, cb) => requireProvider().on(event, cb),
		off: (event, cb) => requireProvider().off(event, cb)
	}
}
