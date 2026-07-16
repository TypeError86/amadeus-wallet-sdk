/**
 * Low-level BLS12-381 signing primitives, mirroring the exact recipe used by
 * `@amadeus-protocol/sdk` (`signing.ts`) and the wallet extension: hash the
 * payload with SHA-256, then `bls.sign(hash, sk, { DST })`. Amadeus uses the
 * "long-signature" variant — G1 public keys (48 bytes) and G2 signatures
 * (96 bytes) — via the deprecated top-level `bls.sign`/`bls.verify` API that the
 * SDK also uses, so bytes stay identical. Key derivation is reused from the SDK.
 */

import { deriveSkAndSeed64FromBase58Seed, fromBase58, getPublicKey } from '@amadeus-protocol/sdk'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { sha256 } from '@noble/hashes/sha2'

import { PUBLIC_KEY_BYTE_LENGTH, SIGNATURE_BYTE_LENGTH } from '../constants'
import { WalletSdkError } from '../errors'

export interface SignerKeys {
	/** 32-byte scalar secret key. */
	sk: Uint8Array
	/** 48-byte G1 public key (also the Base58 address). */
	pk: Uint8Array
}

/** Derive the BLS signer keys from a Base58 seed (the wallet's private key). */
export function deriveSigner(seedBase58: string): SignerKeys {
	const { sk, seed64 } = deriveSkAndSeed64FromBase58Seed(seedBase58)
	const pk = getPublicKey(seed64)
	return { sk, pk }
}

/**
 * Sign `sha256(payload)` under the given DST. `payload` is the raw message
 * bytes (NOT already hashed) — the SHA-256 happens here, matching the SDK.
 */
export function signHashed(payload: Uint8Array, sk: Uint8Array, dst: string): Uint8Array {
	const hash = sha256(payload)
	return bls.sign(hash, sk, { DST: dst })
}

/** Verify a signature over `sha256(payload)` under the given DST. Never throws. */
export function verifyHashed(
	signature: Uint8Array,
	payload: Uint8Array,
	publicKey: Uint8Array,
	dst: string
): boolean {
	try {
		const hash = sha256(payload)
		return bls.verify(signature, hash, publicKey, { DST: dst })
	} catch {
		return false
	}
}

/** Decode a Base58 address into its 48-byte public key, validating length. */
export function publicKeyFromAddress(address: string): Uint8Array {
	let pk: Uint8Array
	try {
		pk = fromBase58(address)
	} catch {
		throw new WalletSdkError('INVALID_ADDRESS', 'address is not valid Base58')
	}
	if (pk.length !== PUBLIC_KEY_BYTE_LENGTH) {
		throw new WalletSdkError(
			'INVALID_ADDRESS',
			`address must decode to ${PUBLIC_KEY_BYTE_LENGTH} bytes, got ${pk.length}`
		)
	}
	return pk
}

/** Decode a Base58 signature into its 96 raw bytes, validating length. */
export function signatureFromBase58(signature: string): Uint8Array {
	let sig: Uint8Array
	try {
		sig = fromBase58(signature)
	} catch {
		throw new WalletSdkError('INVALID_SIGNATURE', 'signature is not valid Base58')
	}
	if (sig.length !== SIGNATURE_BYTE_LENGTH) {
		throw new WalletSdkError(
			'INVALID_SIGNATURE',
			`signature must be ${SIGNATURE_BYTE_LENGTH} bytes, got ${sig.length}`
		)
	}
	return sig
}
