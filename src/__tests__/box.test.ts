import { describe, expect, it } from 'vitest'

import { bytesToUtf8, utf8ToBytes } from '../bytes'
import { deriveSharedKey, generateSessionKeypair, open, seal } from '../crypto/box'
import { WalletSdkError } from '../errors'

describe('session box', () => {
	it('seals and opens between two parties', () => {
		const a = generateSessionKeypair()
		const b = generateSessionKeypair()
		const keyA = deriveSharedKey(b.publicKey, a.secretKey)
		const keyB = deriveSharedKey(a.publicKey, b.secretKey)

		const envelope = seal(keyA, utf8ToBytes('hello amadeus'))
		expect(bytesToUtf8(open(keyB, envelope))).toBe('hello amadeus')
	})

	it('produces a fresh nonce each seal', () => {
		const a = generateSessionKeypair()
		const b = generateSessionKeypair()
		const key = deriveSharedKey(b.publicKey, a.secretKey)
		const one = seal(key, utf8ToBytes('x'))
		const two = seal(key, utf8ToBytes('x'))
		expect(one.nonce).not.toBe(two.nonce)
		expect(one.ciphertext).not.toBe(two.ciphertext)
	})

	it('fails to open with the wrong key', () => {
		const a = generateSessionKeypair()
		const b = generateSessionKeypair()
		const c = generateSessionKeypair()
		const key = deriveSharedKey(b.publicKey, a.secretKey)
		const wrongKey = deriveSharedKey(c.publicKey, a.secretKey)
		const envelope = seal(key, utf8ToBytes('secret'))
		expect(() => open(wrongKey, envelope)).toThrow(WalletSdkError)
	})

	it('fails closed on tampered ciphertext', () => {
		const a = generateSessionKeypair()
		const b = generateSessionKeypair()
		const key = deriveSharedKey(b.publicKey, a.secretKey)
		const envelope = seal(key, utf8ToBytes('secret'))
		const last = envelope.ciphertext.slice(-1)
		const tampered = {
			nonce: envelope.nonce,
			ciphertext: envelope.ciphertext.slice(0, -1) + (last === 'A' ? 'B' : 'A')
		}
		expect(() => open(key, tampered)).toThrow(WalletSdkError)
	})

	it('fails closed (WalletSdkError) on a hostile / malformed peer key', () => {
		const a = generateSessionKeypair()
		// '1' is valid Base58 but decodes to 1 byte (not 32); '!!!' is invalid Base58.
		expect(() => deriveSharedKey('1', a.secretKey)).toThrow(WalletSdkError)
		expect(() => deriveSharedKey('!!!', a.secretKey)).toThrow(WalletSdkError)
	})

	it('authenticates associated data (aad)', () => {
		const a = generateSessionKeypair()
		const b = generateSessionKeypair()
		const key = deriveSharedKey(b.publicKey, a.secretKey)
		const envelope = seal(key, utf8ToBytes('x'), utf8ToBytes('context-1'))
		expect(bytesToUtf8(open(key, envelope, utf8ToBytes('context-1')))).toBe('x')
		expect(() => open(key, envelope, utf8ToBytes('context-2'))).toThrow(WalletSdkError)
	})
})
