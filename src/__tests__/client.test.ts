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
		const { privateKey: seed, publicKey } = generateKeypair()
		const realKey = generateApiKey({ seed, aud: 'amadeus', expIn: 3600 }).apiKey
		const gen = vi.fn(async () => ({ apiKey: realKey }))
		const client = createInjectedWalletClient(
			fakeProvider({ getAccount: async () => publicKey, generateApiKey: gen })
		)

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
		const { privateKey: seed, publicKey } = generateKeypair()
		const keyFor = (aud: string) => generateApiKey({ seed, aud, expIn: 3600 }).apiKey
		const gen = vi.fn(async ({ aud }: { aud: string }) => ({ apiKey: keyFor(aud) }))
		const client = createInjectedWalletClient(
			fakeProvider({ getAccount: async () => publicKey, generateApiKey: gen })
		)

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
		const { privateKey: seed, publicKey } = generateKeypair()
		const slot = { value: generateApiKey({ seed, aud: 'hub', expIn: 3600 }).apiKey }
		const store = {
			get: () => slot.value,
			set: (apiKey: string) => {
				slot.value = apiKey
			}
		}
		const kbsKey = generateApiKey({ seed, aud: 'kbs', expIn: 3600 }).apiKey
		const gen = vi.fn(async () => ({ apiKey: kbsKey }))
		const client = createInjectedWalletClient(
			fakeProvider({ getAccount: async () => publicKey, generateApiKey: gen })
		)

		expect(await client.ensureApiKey({ aud: 'kbs', expIn: 3600, store })).toBe(kbsKey)
		expect(gen).toHaveBeenCalledOnce()
	})

	it('ensureApiKey reuses a legacy single-slot store key for the active account', async () => {
		const { privateKey: seed, publicKey } = generateKeypair()
		const apiKey = generateApiKey({ seed, aud: 'hub', expIn: 3600 }).apiKey
		const store = { get: () => apiKey, set: vi.fn() }
		const gen = vi.fn(async () => ({ apiKey: 'UNUSED' }))
		const client = createInjectedWalletClient(
			fakeProvider({ getAccount: async () => publicKey, generateApiKey: gen })
		)

		expect(await client.ensureApiKey({ aud: 'hub', expIn: 3600, store })).toBe(apiKey)
		expect(gen).not.toHaveBeenCalled()
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
		const { privateKey: seed, publicKey } = generateKeypair()
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
		const client = createInjectedWalletClient(
			fakeProvider({ getAccount: async () => publicKey, generateApiKey: gen })
		)

		const out = await client.ensureApiKey({ aud: 'amadeus', expIn: 3600, store })
		expect(out).toBe(fresh)
		expect(gen).toHaveBeenCalledOnce()
		expect(store.set).toHaveBeenCalledWith(fresh, 'amadeus')
	})

	it('ensureApiKey mints a new key after an account switch', async () => {
		const first = generateKeypair()
		const second = generateKeypair()
		const active = { account: first.publicKey }
		const gen = vi.fn(async ({ aud }: { aud: string }) => ({
			apiKey: generateApiKey({
				seed: active.account === first.publicKey ? first.privateKey : second.privateKey,
				aud,
				expIn: 3600
			}).apiKey
		}))
		const client = createInjectedWalletClient(
			fakeProvider({ getAccount: async () => active.account, generateApiKey: gen })
		)

		const firstKey = await client.ensureApiKey({ aud: 'hub', expIn: 3600 })
		expect(decodeApiKey(firstKey).address).toBe(first.publicKey)
		active.account = second.publicKey
		const secondKey = await client.ensureApiKey({ aud: 'hub', expIn: 3600 })
		expect(decodeApiKey(secondKey).address).toBe(second.publicKey)
		expect(gen).toHaveBeenCalledTimes(2)
	})

	it('ensureApiKey does not reuse an in-flight request across accounts', async () => {
		const first = generateKeypair()
		const second = generateKeypair()
		const active = { account: first.publicKey }
		const pending: Array<(apiKey: string) => void> = []
		const gen = vi.fn(
			() =>
				new Promise<{ apiKey: string }>((resolve) => {
					pending.push((apiKey) => resolve({ apiKey }))
				})
		)
		const client = createInjectedWalletClient(
			fakeProvider({ getAccount: async () => active.account, generateApiKey: gen })
		)

		const firstRequest = client.ensureApiKey({ aud: 'hub', expIn: 3600 })
		await vi.waitFor(() => expect(gen).toHaveBeenCalledTimes(1))
		active.account = second.publicKey
		const secondRequest = client.ensureApiKey({ aud: 'hub', expIn: 3600 })
		await vi.waitFor(() => expect(gen).toHaveBeenCalledTimes(2))

		pending[0](generateApiKey({ seed: first.privateKey, aud: 'hub', expIn: 3600 }).apiKey)
		pending[1](generateApiKey({ seed: second.privateKey, aud: 'hub', expIn: 3600 }).apiKey)
		expect(decodeApiKey(await firstRequest).address).toBe(first.publicKey)
		expect(decodeApiKey(await secondRequest).address).toBe(second.publicKey)
	})

	it('ensureApiKey ignores a custom store holding a key for another account', async () => {
		const other = generateKeypair()
		const active = generateKeypair()
		const store = {
			get: vi.fn(
				() => generateApiKey({ seed: other.privateKey, aud: 'hub', expIn: 3600 }).apiKey
			),
			set: vi.fn()
		}
		const freshKey = generateApiKey({ seed: active.privateKey, aud: 'hub', expIn: 3600 }).apiKey
		const gen = vi.fn(async () => ({ apiKey: freshKey }))
		const client = createInjectedWalletClient(
			fakeProvider({ getAccount: async () => active.publicKey, generateApiKey: gen })
		)

		expect(await client.ensureApiKey({ aud: 'hub', expIn: 3600, store })).toBe(freshKey)
		expect(gen).toHaveBeenCalledOnce()
		expect(store.set).toHaveBeenCalledWith(freshKey, 'hub')
	})

	it('ensureApiKey does not reuse a cached key while the wallet reports no account', async () => {
		const { privateKey: seed } = generateKeypair()
		const apiKey = generateApiKey({ seed, aud: 'hub', expIn: 3600 }).apiKey
		const store = { get: () => apiKey, set: vi.fn() }
		const gen = vi.fn(async () => ({ apiKey }))
		const client = createInjectedWalletClient(
			fakeProvider({ getAccount: async () => null, generateApiKey: gen })
		)

		await client.ensureApiKey({ aud: 'hub', expIn: 3600, store })
		expect(gen).toHaveBeenCalledOnce()
	})

	it('throws when no provider is available', async () => {
		const client = createInjectedWalletClient() // no window.amadeus in node
		expect(client.isAvailable()).toBe(false)
		await expect(client.connect()).rejects.toThrow(/not available/)
	})
})
