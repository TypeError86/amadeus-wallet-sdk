import {
	derivePublicKeyFromSeedBase58,
	fromBase58,
	generateKeypair,
	TransactionBuilder
} from '@amadeus-protocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { verifyApiKey } from '../crypto/apikey'
import { makeRequest } from '../transport/envelope'
import { handleRequest } from '../wallet/handler'

const FIXED_NOW = 1_780_000_000_000

describe('wallet handler', () => {
	const { privateKey: seed } = generateKeypair()
	const address = derivePublicKeyFromSeedBase58(seed)
	const { publicKey: recipient } = generateKeypair()
	const ctx = { seed, address }

	it('handles amadeus_getAccounts', () => {
		const req = makeRequest({
			id: '1',
			method: 'amadeus_getAccounts',
			origin: 'https://x',
			params: {},
			now: FIXED_NOW
		})
		const res = handleRequest(req, ctx)
		expect(res.ok).toBe(true)
		if (res.ok) expect(res.result).toEqual({ accounts: [address] })
	})

	it('handles amadeus_signTransaction (matches the SDK)', () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'))
		try {
			const req = makeRequest({
				id: '2',
				method: 'amadeus_signTransaction',
				origin: 'https://x',
				params: {
					contract: 'Coin',
					method: 'transfer',
					args: [recipient, '1000000000', 'AMA']
				}
			})
			const res = handleRequest(req, ctx)
			expect(res.ok).toBe(true)
			const sdk = new TransactionBuilder(seed).buildAndSign('Coin', 'transfer', [
				fromBase58(recipient),
				'1000000000',
				'AMA'
			])
			if (res.ok) {
				expect((res.result as { txHash: string }).txHash).toBe(sdk.txHash)
			}
		} finally {
			vi.useRealTimers()
		}
	})

	it('handles amadeus_generateApiKey (verifiable token)', () => {
		const req = makeRequest({
			id: '3',
			method: 'amadeus_generateApiKey',
			origin: 'https://x',
			params: { aud: 'amadeus', exp_in: 3600 }
		})
		const res = handleRequest(req, ctx)
		expect(res.ok).toBe(true)
		if (res.ok) {
			const { apiKey } = res.result as { apiKey: string }
			const verified = verifyApiKey(apiKey, { aud: 'amadeus' })
			expect(verified.valid).toBe(true)
			if (verified.valid) expect(verified.address).toBe(address)
		}
	})

	it('returns an error response (never throws) on bad params', () => {
		const req = makeRequest({
			id: '4',
			method: 'amadeus_signTransaction',
			origin: 'https://x',
			params: { nope: true },
			now: FIXED_NOW
		})
		const res = handleRequest(req, ctx)
		expect(res.ok).toBe(false)
		if (!res.ok) expect(res.error.code).toBe('INVALID_ARGUMENT')
	})

	it('reports switchNetwork as app-delegated rather than crashing', () => {
		const req = makeRequest({
			id: '5',
			method: 'amadeus_switchNetwork',
			origin: 'https://x',
			params: { network: 'testnet' },
			now: FIXED_NOW
		})
		const res = handleRequest(req, ctx)
		expect(res.ok).toBe(false)
	})
})
