import { describe, expect, it, vi } from 'vitest'

import { generateApiKey } from '../crypto/apikey'
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
		expect(store.set).toHaveBeenCalledWith(fresh)
	})

	it('throws when no provider is available', async () => {
		const client = createInjectedWalletClient() // no window.amadeus in node
		expect(client.isAvailable()).toBe(false)
		await expect(client.connect()).rejects.toThrow(/not available/)
	})
})
