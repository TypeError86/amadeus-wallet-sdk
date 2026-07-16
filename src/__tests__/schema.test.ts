import { derivePublicKeyFromSeedBase58, generateKeypair } from '@amadeus-protocol/sdk'
import { describe, expect, it } from 'vitest'

import { generateSessionKeypair } from '../crypto/box'
import {
	addressSchema,
	connectTranscriptSchema,
	generateApiKeyRequestSchema,
	originSchema,
	sessionPublicKeySchema,
	signTransactionRequestSchema
} from '../schema'

describe('schemas', () => {
	it('addressSchema accepts a 48-byte pubkey and rejects junk', () => {
		const address = derivePublicKeyFromSeedBase58(generateKeypair().privateKey)
		expect(addressSchema.safeParse(address).success).toBe(true)
		expect(addressSchema.safeParse('abc').success).toBe(false)
		expect(addressSchema.safeParse('!!!').success).toBe(false)
	})

	it('originSchema requires http(s)', () => {
		expect(originSchema.safeParse('https://app.amadeus.xyz').success).toBe(true)
		expect(originSchema.safeParse('http://localhost:3000').success).toBe(true)
		expect(originSchema.safeParse('ftp://x').success).toBe(false)
		expect(originSchema.safeParse('javascript:alert(1)').success).toBe(false)
	})

	it('signTransactionRequestSchema validates the shape', () => {
		expect(
			signTransactionRequestSchema.safeParse({
				contract: 'Coin',
				method: 'transfer',
				args: []
			}).success
		).toBe(true)
		expect(
			signTransactionRequestSchema.safeParse({ contract: '', method: 'x', args: [] }).success
		).toBe(false)
		expect(
			signTransactionRequestSchema.safeParse({ contract: 'Coin', method: 'transfer' }).success
		).toBe(false)
	})

	it('generateApiKeyRequestSchema requires a positive integer exp_in', () => {
		expect(
			generateApiKeyRequestSchema.safeParse({ aud: 'amadeus', exp_in: 3600 }).success
		).toBe(true)
		expect(generateApiKeyRequestSchema.safeParse({ aud: 'amadeus', exp_in: -1 }).success).toBe(
			false
		)
		expect(generateApiKeyRequestSchema.safeParse({ aud: 'amadeus', exp_in: 1.5 }).success).toBe(
			false
		)
		expect(generateApiKeyRequestSchema.safeParse({ aud: '', exp_in: 3600 }).success).toBe(false)
	})

	it('sessionPublicKeySchema enforces 32-byte x25519 keys', () => {
		expect(sessionPublicKeySchema.safeParse(generateSessionKeypair().publicKey).success).toBe(
			true
		)
		expect(sessionPublicKeySchema.safeParse('1').success).toBe(false)
		// a 48-byte BLS address is NOT a valid 32-byte session key
		const address = derivePublicKeyFromSeedBase58(generateKeypair().privateKey)
		expect(sessionPublicKeySchema.safeParse(address).success).toBe(false)
	})

	it('connectTranscriptSchema validates a full transcript', () => {
		const transcript = {
			origin: 'https://app.amadeus.xyz',
			dappPublicKey: generateSessionKeypair().publicKey,
			walletPublicKey: generateSessionKeypair().publicKey,
			challenge: 'nonce',
			requestId: 'req-1'
		}
		expect(connectTranscriptSchema.safeParse(transcript).success).toBe(true)
		expect(
			connectTranscriptSchema.safeParse({ ...transcript, dappPublicKey: 'short' }).success
		).toBe(false)
	})
})
