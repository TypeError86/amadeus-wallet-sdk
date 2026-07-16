import { derivePublicKeyFromSeedBase58, fromBase58, generateKeypair } from '@amadeus-protocol/sdk'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { sha256 } from '@noble/hashes/sha2'
import { describe, expect, it } from 'vitest'

import { API_KEY_DST, CONNECT_DST } from '../constants'
import { buildConnectTranscript, signConnect, verifyConnect } from '../crypto/connect'
import { generateSessionKeypair } from '../crypto/box'

describe('connect auth', () => {
	const { privateKey: seed } = generateKeypair()
	const address = derivePublicKeyFromSeedBase58(seed)
	const dapp = generateSessionKeypair()
	const wallet = generateSessionKeypair()

	const transcript = {
		origin: 'https://app.amadeus.xyz',
		dappPublicKey: dapp.publicKey,
		walletPublicKey: wallet.publicKey,
		challenge: 'random-nonce-abc123',
		requestId: 'req-0001'
	}

	it('signs and verifies a transcript', () => {
		const signature = signConnect({ seed, transcript })
		expect(verifyConnect({ address, transcript, signature })).toBe(true)
	})

	it('is bound to every transcript field (MITM resistance)', () => {
		const signature = signConnect({ seed, transcript })
		// swapping the wallet session key (the key-substitution attack) must fail
		expect(
			verifyConnect({
				address,
				transcript: { ...transcript, walletPublicKey: dapp.publicKey },
				signature
			})
		).toBe(false)
		expect(
			verifyConnect({
				address,
				transcript: { ...transcript, origin: 'https://evil.xyz' },
				signature
			})
		).toBe(false)
		expect(
			verifyConnect({
				address,
				transcript: { ...transcript, challenge: 'different' },
				signature
			})
		).toBe(false)
		expect(
			verifyConnect({
				address,
				transcript: { ...transcript, requestId: 'req-9999' },
				signature
			})
		).toBe(false)
	})

	it('fails under a different signing address', () => {
		const signature = signConnect({ seed, transcript })
		const other = derivePublicKeyFromSeedBase58(generateKeypair().privateKey)
		expect(verifyConnect({ address: other, transcript, signature })).toBe(false)
	})

	it('domain separation: a connect signature never verifies under another DST', () => {
		const signature = fromBase58(signConnect({ seed, transcript }))
		const hash = sha256(buildConnectTranscript(transcript))
		const pk = fromBase58(address)
		expect(bls.verify(signature, hash, pk, { DST: CONNECT_DST })).toBe(true)
		expect(bls.verify(signature, hash, pk, { DST: API_KEY_DST })).toBe(false)
	})

	it('returns false (never throws) on malformed input', () => {
		expect(verifyConnect({ address: 'not-an-address', transcript, signature: 'nope' })).toBe(
			false
		)
	})
})
