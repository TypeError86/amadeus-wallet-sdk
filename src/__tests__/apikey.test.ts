import {
	derivePublicKeyFromSeedBase58,
	deriveSkAndSeed64FromBase58Seed,
	fromBase58,
	generateKeypair,
	getPublicKey,
	toBase58
} from '@amadeus-protocol/sdk'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { sha256 } from '@noble/hashes/sha2'
import { describe, expect, it } from 'vitest'

import { API_KEY_DST, PUBLIC_KEY_BYTE_LENGTH, SIGNATURE_BYTE_LENGTH } from '../constants'
import { decodeApiKey, generateApiKey, verifyApiKey } from '../crypto/apikey'

const FIXED_NOW = 1_780_000_000_000 // fixed ms so exp is deterministic

describe('API key', () => {
	const { privateKey: seed } = generateKeypair()
	const address = derivePublicKeyFromSeedBase58(seed)

	it('round-trips: generate -> decode', () => {
		const { apiKey, payload } = generateApiKey({
			seed,
			aud: 'amadeus',
			expIn: 3600,
			now: FIXED_NOW
		})
		expect(payload.aud).toBe('amadeus')
		expect(payload.exp).toBe(Math.floor(FIXED_NOW / 1000) + 3600)

		const decoded = decodeApiKey(apiKey)
		expect(decoded.payload).toEqual(payload)
		expect(decoded.address).toBe(address)
		expect(decoded.publicKey.length).toBe(PUBLIC_KEY_BYTE_LENGTH)
		expect(decoded.signature.length).toBe(SIGNATURE_BYTE_LENGTH)
	})

	it('has the exact byte layout base58( json || pk48 || sig96 )', () => {
		const { apiKey } = generateApiKey({ seed, aud: 'kbs', expIn: 100, now: FIXED_NOW })
		const raw = fromBase58(apiKey)
		const jsonEnd = raw.length - PUBLIC_KEY_BYTE_LENGTH - SIGNATURE_BYTE_LENGTH
		expect(jsonEnd).toBeGreaterThan(0)
		const json = JSON.parse(new TextDecoder().decode(raw.slice(0, jsonEnd)))
		expect(json).toEqual({ aud: 'kbs', exp: Math.floor(FIXED_NOW / 1000) + 100 })
	})

	// The single most important test: our unified token must be byte-for-byte
	// identical to the hand-rolled recipe in the extension + hub, or kbs.ama.one
	// stops accepting keys generated here.
	it('is byte-identical to the extension/hub hand-rolled recipe', () => {
		const aud = 'amadeus'
		const expIn = 7 * 24 * 3600

		// ---- inlined from extension api-key.ts / hub blsWallet.ts ----
		const { sk, seed64 } = deriveSkAndSeed64FromBase58Seed(seed)
		const pubkey = getPublicKey(seed64)
		const exp = Math.floor(FIXED_NOW / 1000) + expIn
		const jsonBytes = new TextEncoder().encode(JSON.stringify({ aud, exp }))
		const message = new Uint8Array(jsonBytes.length + pubkey.length)
		message.set(jsonBytes, 0)
		message.set(pubkey, jsonBytes.length)
		const hash = sha256(message)
		const signature = bls.sign(hash, sk, { DST: API_KEY_DST })
		const token = new Uint8Array(jsonBytes.length + pubkey.length + signature.length)
		token.set(jsonBytes, 0)
		token.set(pubkey, jsonBytes.length)
		token.set(signature, jsonBytes.length + pubkey.length)
		const expected = toBase58(token)
		// --------------------------------------------------------------

		const { apiKey } = generateApiKey({ seed, aud, expIn, now: FIXED_NOW })
		expect(apiKey).toBe(expected)
	})

	it('verifies a valid token', () => {
		const { apiKey } = generateApiKey({ seed, aud: 'amadeus', expIn: 3600, now: FIXED_NOW })
		const result = verifyApiKey(apiKey, { aud: 'amadeus', now: FIXED_NOW })
		expect(result.valid).toBe(true)
		if (result.valid) {
			expect(result.address).toBe(address)
			expect(result.payload.aud).toBe('amadeus')
		}
	})

	it('rejects an expired token', () => {
		const { apiKey } = generateApiKey({ seed, aud: 'amadeus', expIn: 10, now: FIXED_NOW })
		const result = verifyApiKey(apiKey, { now: FIXED_NOW + 20_000 })
		expect(result).toEqual({ valid: false, reason: 'expired' })
	})

	it('rejects an audience mismatch', () => {
		const { apiKey } = generateApiKey({ seed, aud: 'amadeus', expIn: 3600, now: FIXED_NOW })
		const result = verifyApiKey(apiKey, { aud: 'other', now: FIXED_NOW })
		expect(result).toEqual({ valid: false, reason: 'aud_mismatch' })
	})

	it('rejects a tampered signature', () => {
		const { apiKey } = generateApiKey({ seed, aud: 'amadeus', expIn: 3600, now: FIXED_NOW })
		const raw = fromBase58(apiKey)
		raw[raw.length - 1] ^= 0x01 // flip a bit in the signature region
		const result = verifyApiKey(toBase58(raw), { now: FIXED_NOW })
		expect(result.valid).toBe(false)
	})

	it('rejects a token signed by a different key (pubkey swap)', () => {
		const { apiKey } = generateApiKey({ seed, aud: 'amadeus', expIn: 3600, now: FIXED_NOW })
		const otherPk = fromBase58(derivePublicKeyFromSeedBase58(generateKeypair().privateKey))
		const raw = fromBase58(apiKey)
		const jsonEnd = raw.length - PUBLIC_KEY_BYTE_LENGTH - SIGNATURE_BYTE_LENGTH
		raw.set(otherPk, jsonEnd) // replace embedded pubkey, leave signature
		const result = verifyApiKey(toBase58(raw), { now: FIXED_NOW })
		expect(result.valid).toBe(false)
	})

	it('rejects malformed input without throwing in verify', () => {
		expect(verifyApiKey('0OIl-not-base58')).toEqual({ valid: false, reason: 'malformed' })
	})

	it('rejects an oversized token before the expensive decode (DoS guard)', () => {
		const huge = 'A'.repeat(5000)
		expect(verifyApiKey(huge)).toEqual({ valid: false, reason: 'malformed' })
		expect(() => decodeApiKey(huge)).toThrow(/length is out of range/)
	})
})
