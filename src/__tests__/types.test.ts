import { describe, expect, expectTypeOf, it } from 'vitest'

import { createInjectedWalletClient } from '../client/injected'
import { PROVIDER_EVENTS } from '../constants'
import type {
	AmadeusEventPayloadMap,
	AmadeusProvider,
	AmadeusProviderEvent,
	PendingRequestSummary
} from '../types'

describe('provider contract types', () => {
	it('types event timestamps as the ISO strings the extension emits', () => {
		expectTypeOf<
			AmadeusEventPayloadMap['accountsChanged']['timestamp']
		>().toEqualTypeOf<string>()
		expectTypeOf<
			AmadeusEventPayloadMap['networkChanged']['timestamp']
		>().toEqualTypeOf<string>()
		expectTypeOf<AmadeusEventPayloadMap['shown']>().toEqualTypeOf<{
			requestId: string
			shownAs: 'sidepanel' | 'popup' | 'window'
			timestamp: string
		}>()
	})

	it('lists the shown event', () => {
		expect(PROVIDER_EVENTS).toContain('shown')
		expectTypeOf<'shown'>().toMatchTypeOf<AmadeusProviderEvent>()
	})

	it('exposes the optional pending-request methods', () => {
		expectTypeOf<AmadeusProvider['getPendingRequests']>().toEqualTypeOf<
			(() => Promise<PendingRequestSummary[]>) | undefined
		>()
		expectTypeOf<AmadeusProvider['cancelRequest']>().toEqualTypeOf<
			((requestId: string) => void) | undefined
		>()
		expectTypeOf<PendingRequestSummary['timestamp']>().toEqualTypeOf<number>()
	})

	it('delivers extension-shaped event payloads through the injected client', () => {
		const listeners = new Map<string, (data: unknown) => void>()
		const provider: AmadeusProvider = {
			isAmadeus: true,
			isConnected: async () => true,
			getAccount: async () => 'ADDRESS',
			getNetwork: async () => 'mainnet',
			requestAccounts: async () => ['ADDRESS'],
			requestSwitchNetwork: async (network) => network,
			signTransaction: async () => ({ txHash: 'HASH', txPacked: [] }),
			generateApiKey: async () => ({ apiKey: 'KEY' }),
			getPendingRequests: async () => [{ type: 'sign', id: 'amadeus_1', timestamp: 1 }],
			cancelRequest: () => {},
			on: (event, callback) => listeners.set(event, callback as (data: unknown) => void),
			off: (event) => listeners.delete(event)
		}
		const received: AmadeusEventPayloadMap['shown'][] = []
		createInjectedWalletClient(provider).on('shown', (data) => received.push(data))

		const payload = {
			requestId: 'amadeus_1',
			shownAs: 'sidepanel',
			timestamp: new Date(0).toISOString()
		}
		listeners.get('shown')?.(payload)
		expect(received).toEqual([payload])
		expect(Number.isNaN(Date.parse(received[0].timestamp))).toBe(false)
	})
})
