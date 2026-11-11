import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AmadeusProvider } from '../types'

// No DOM renderer in this repo: run the hook body once with effects applied synchronously.
const stateCells = vi.hoisted(() => [] as { value: unknown }[])

vi.mock('react', () => ({
	useMemo: (factory: () => unknown) => factory(),
	useCallback: (callback: unknown) => callback,
	useEffect: (effect: () => void) => {
		effect()
	},
	useState: (initial: unknown) => {
		const cell = { value: typeof initial === 'function' ? initial() : initial }
		stateCells.push(cell)
		const setState = (next: unknown) => {
			cell.value = typeof next === 'function' ? next(cell.value) : next
		}
		return [cell.value, setState]
	}
}))

const { useWallet } = await import('../react')

function installProvider() {
	const listeners = new Map<string, (data: unknown) => void>()
	const provider: AmadeusProvider = {
		isAmadeus: true,
		isConnected: async () => true,
		getAccount: async () => null,
		getNetwork: async () => 'mainnet',
		requestAccounts: async () => ['ADDRESS'],
		requestSwitchNetwork: async (network) => network,
		signTransaction: async () => ({ txHash: 'HASH', txPacked: [] }),
		generateApiKey: async () => ({ apiKey: 'KEY' }),
		on: (event, callback) => listeners.set(event, callback as (data: unknown) => void),
		off: (event) => listeners.delete(event)
	}
	;(globalThis as { amadeus?: AmadeusProvider }).amadeus = provider
	return listeners
}

describe('useWallet', () => {
	afterEach(() => {
		stateCells.length = 0
		delete (globalThis as { amadeus?: AmadeusProvider }).amadeus
	})

	it('keeps the known network when connect arrives without one', () => {
		const listeners = installProvider()
		useWallet()
		const [, accountCell, networkCell] = stateCells
		const timestamp = new Date().toISOString()

		listeners.get('networkChanged')?.({ network: 'testnet', previousNetwork: null, timestamp })
		listeners.get('connect')?.({ accounts: ['ADDRESS'], network: null, timestamp })

		expect(accountCell.value).toBe('ADDRESS')
		expect(networkCell.value).toBe('testnet')
	})

	it('takes the network from connect when it has one', () => {
		const listeners = installProvider()
		useWallet()
		const networkCell = stateCells[2]

		listeners.get('connect')?.({
			accounts: ['ADDRESS'],
			network: 'mainnet',
			timestamp: new Date().toISOString()
		})

		expect(networkCell.value).toBe('mainnet')
	})
})
