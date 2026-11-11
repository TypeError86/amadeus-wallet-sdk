import { describe, expect, it, vi } from 'vitest'

import { decodeApiKey, generateApiKey } from '../crypto/apikey'
import { generateKeypair } from '@amadeus-protocol/sdk'
import { createInjectedWalletClient } from '../client/injected'
import type { AmadeusProvider } from '../types'

/** A minimal fake of the injected window.amadeus provider for tests. */
function fakeProvider(overrides: Partial<AmadeusProvider> = {}): AmadeusProvider {
	return {
		isAmadeus: true,
		isConnected: async () => true,
		getAccount: async () => 'ADDRESS',
		getNetwork: async () => 'mainnet',
		requestAccounts: async () => ['ADDRESS'],
		requestSwitchNetwork: async (n) => n,
		requestSwitchAccount: async (target) => target ?? 'ADDRESS2',
		signTransaction: async () => ({ txHash: 'HASH', txPacked: [1, 2, 3] }),
		generateApiKey: async () => ({ apiKey: 'KEY' }),
		on: () => {},
		off: () => {},
		...overrides
	}
}

describe('injected wallet client', () => {
	it('reports availability from the provider', () => {
		expect(createInjectedWalletClient(fakeProvider()).isAvailable()).toBe(true)
	})

	it('connect returns the first account', async () => {
		const client = createInjectedWalletClient(fakeProvider())
		expect(await client.connect()).toBe('ADDRESS')
	})

	it('switchAccount forwards the target and resolves to the new address', async () => {
		const requestSwitchAccount = vi.fn(async (target?: string) => target ?? 'ADDRESS2')
		const client = createInjectedWalletClient(fakeProvider({ requestSwitchAccount }))
		expect(await client.switchAccount('TARGET')).toBe('TARGET')
		expect(requestSwitchAccount).toHaveBeenCalledWith('TARGET')
		// No target hint → the wallet chooses; the client still resolves to an address.
		expect(await client.switchAccount()).toBe('ADDRESS2')
	})

	it('switchAccount rejects with UNSUPPORTED when the wallet lacks the method', async () => {
		const client = createInjectedWalletClient(fakeProvider({ requestSwitchAccount: undefined }))
		await expect(client.switchAccount('TARGET')).rejects.toMatchObject({
			name: 'WalletSdkError',
			code: 'UNSUPPORTED'
		})
	})

	it('signAndSubmit signs then POSTs the packed bytes', async () => {
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(JSON.stringify({ included: true }), { status: 200 })
		)
		vi.stubGlobal('fetch', fetchMock)
		try {
			const client = createInjectedWalletClient(fakeProvider())
			const out = await client.signAndSubmit(
				{ contract: 'Coin', method: 'transfer', args: ['a', '1', 'AMA'] },
				{ nodeUrl: 'https://node.example/api', wait: true }
			)
			expect(out.txHash).toBe('HASH')
			expect(fetchMock).toHaveBeenCalledOnce()
			expect(fetchMock.mock.calls[0][0]).toBe('https://node.example/api/tx/submit_and_wait')
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it('ensureApiKey caches a valid key and coalesces concurrent calls', async () => {
		const { privateKey: seed } = generateKeypair()
		const realKey = generateApiKey({ seed, aud: 'amadeus', expIn: 3600 }).apiKey
		const gen = vi.fn(async () => ({ apiKey: realKey }))
		const client = createInjectedWalletClient(fakeProvider({ generateApiKey: gen }))

		const [a, b] = await Promise.all([
			client.ensureApiKey({ aud: 'amadeus', expIn: 3600 }),
			client.ensureApiKey({ aud: 'amadeus', expIn: 3600 })
		])
		expect(a).toBe(realKey)
		expect(b).toBe(realKey)
		// second round hits the cache — provider not called again
		await client.ensureApiKey({ aud: 'amadeus', expIn: 3600 })
		expect(gen).toHaveBeenCalledOnce()
	})

	it('ensureApiKey keys the cache by aud', async () => {
		const { privateKey: seed } = generateKeypair()
		const keyFor = (aud: string) => generateApiKey({ seed, aud, expIn: 3600 }).apiKey
		const gen = vi.fn(async ({ aud }: { aud: string }) => ({ apiKey: keyFor(aud) }))
		const client = createInjectedWalletClient(fakeProvider({ generateApiKey: gen }))

		const first = await client.ensureApiKey({ aud: 'hub', expIn: 3600 })
		const second = await client.ensureApiKey({ aud: 'kbs', expIn: 3600 })
		expect(decodeApiKey(first).payload.aud).toBe('hub')
		expect(decodeApiKey(second).payload.aud).toBe('kbs')
		expect(await client.ensureApiKey({ aud: 'hub', expIn: 3600 })).toBe(first)
		expect(gen).toHaveBeenCalledTimes(2)
	})

	it('ensureApiKey does not coalesce concurrent calls for different auds', async () => {
		const { privateKey: seed } = generateKeypair()
		const gen = vi.fn(async ({ aud }: { aud: string }) => ({
			apiKey: generateApiKey({ seed, aud, expIn: 3600 }).apiKey
		}))
		const client = createInjectedWalletClient(fakeProvider({ generateApiKey: gen }))

		const [hubKey, kbsKey] = await Promise.all([
			client.ensureApiKey({ aud: 'hub', expIn: 3600 }),
			client.ensureApiKey({ aud: 'kbs', expIn: 3600 })
		])
		expect(decodeApiKey(hubKey).payload.aud).toBe('hub')
		expect(decodeApiKey(kbsKey).payload.aud).toBe('kbs')
		expect(gen).toHaveBeenCalledTimes(2)
	})

	it('ensureApiKey ignores a single-slot store holding another aud', async () => {
		const { privateKey: seed } = generateKeypair()
		const slot = { value: generateApiKey({ seed, aud: 'hub', expIn: 3600 }).apiKey }
		const store = {
			get: () => slot.value,
			set: (apiKey: string) => {
				slot.value = apiKey
			}
		}
		const kbsKey = generateApiKey({ seed, aud: 'kbs', expIn: 3600 }).apiKey
		const gen = vi.fn(async () => ({ apiKey: kbsKey }))
		const client = createInjectedWalletClient(fakeProvider({ generateApiKey: gen }))

		expect(await client.ensureApiKey({ aud: 'kbs', expIn: 3600, store })).toBe(kbsKey)
		expect(gen).toHaveBeenCalledOnce()
	})

	it('ensureApiKey passes aud to the store', async () => {
		const { privateKey: seed } = generateKeypair()
		const apiKey = generateApiKey({ seed, aud: 'kbs', expIn: 3600 }).apiKey
		const store = { get: vi.fn((_aud?: string) => null), set: vi.fn() }
		const client = createInjectedWalletClient(
			fakeProvider({ generateApiKey: async () => ({ apiKey }) })
		)

		await client.ensureApiKey({ aud: 'kbs', expIn: 3600, store })
		expect(store.get).toHaveBeenCalledWith('kbs')
		expect(store.set).toHaveBeenCalledWith(apiKey, 'kbs')
	})

	it('regenerates when the cached key is expired/invalid', async () => {
		const { privateKey: seed } = generateKeypair()
		// already-expired token (expIn negative via now in the far future is not allowed; use a tiny ttl + old now)
		const expired = generateApiKey({
			seed,
			aud: 'amadeus',
			expIn: 1,
			now: 1_000_000_000_000
		}).apiKey
		const fresh = generateApiKey({ seed, aud: 'amadeus', expIn: 3600 }).apiKey
		const store = { get: () => expired, set: vi.fn() }
		const gen = vi.fn(async () => ({ apiKey: fresh }))
		const client = createInjectedWalletClient(fakeProvider({ generateApiKey: gen }))

		const out = await client.ensureApiKey({ aud: 'amadeus', expIn: 3600, store })
		expect(out).toBe(fresh)
		expect(gen).toHaveBeenCalledOnce()
		expect(store.set).toHaveBeenCalledWith(fresh, 'amadeus')
	})

	it('throws when no provider is available', async () => {
		const client = createInjectedWalletClient() // no window.amadeus in node
		expect(client.isAvailable()).toBe(false)
		await expect(client.connect()).rejects.toThrow(/not available/)
	})
})
