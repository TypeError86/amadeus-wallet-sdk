import {
	derivePublicKeyFromSeedBase58,
	fromBase58,
	generateKeypair,
	toBase58
} from '@amadeus-protocol/sdk'
import { describe, expect, it } from 'vitest'

import { MESSAGE_DST, SIGNATURE_BYTE_LENGTH, TX_DST } from '../constants'
import { deriveSigner, signHashed } from '../crypto/bls'
import { signMessage, verifyMessage } from '../crypto/message'
import { utf8ToBytes } from '../bytes'

describe('message signing', () => {
	const { privateKey: seed } = generateKeypair()
	const address = derivePublicKeyFromSeedBase58(seed)
	const message = 'Login to app.example.com\nnonce: 8f3c1a'

	it('round-trips: sign -> verify', () => {
		const res = signMessage({ seed, message })
		expect(res.message).toBe(message)
		expect(res.address).toBe(address)
		expect(fromBase58(res.signature).length).toBe(SIGNATURE_BYTE_LENGTH)
		expect(verifyMessage({ message, signature: res.signature, address })).toBe(true)
	})

	it('fails verification if the message is tampered', () => {
		const { signature } = signMessage({ seed, message })
		expect(verifyMessage({ message: message + '!', signature, address })).toBe(false)
	})

	it('fails verification against a different address', () => {
		const { signature } = signMessage({ seed, message })
		const { publicKey: other } = generateKeypair()
		expect(verifyMessage({ message, signature, address: other })).toBe(false)
	})

	it('returns false (never throws) on malformed input', () => {
		expect(verifyMessage({ message, signature: 'not-base58!!', address })).toBe(false)
		expect(verifyMessage({ message: '', signature: 'x', address })).toBe(false)
		expect(verifyMessage({ message, signature: toBase58(new Uint8Array(10)), address })).toBe(
			false
		)
	})

	it('rejects an empty or over-long message when signing', () => {
		expect(() => signMessage({ seed, message: '' })).toThrow()
		expect(() => signMessage({ seed, message: 'a'.repeat(5000) })).toThrow()
	})

	// The core safety property: the SAME key signing the SAME bytes under TX_DST
	// must NOT verify as a message — so a dApp can never trick a user into signing
	// a "message" that is secretly a valid transaction signature (or vice-versa).
	it('is domain-separated from transaction signatures', () => {
		const { sk } = deriveSigner(seed)
		const txDomainSig = signHashed(utf8ToBytes(message), sk, TX_DST)
		expect(MESSAGE_DST).not.toBe(TX_DST)
		expect(verifyMessage({ message, signature: toBase58(txDomainSig), address })).toBe(false)
		// sanity: the correctly-domained signature still verifies
		const { signature } = signMessage({ seed, message })
		expect(verifyMessage({ message, signature, address })).toBe(true)
	})
})
