/**
 * End-to-end encrypted session channel for cross-device transports (QR / bridge).
 *
 * Each side holds an ephemeral x25519 keypair; the shared secret is derived via
 * ECDH and run through SHA-256 into a 32-byte symmetric key, then messages are
 * sealed with XChaCha20-Poly1305 (24-byte random nonce per message, AEAD auth
 * tag). This stack is Hermes-safe — it reuses the same `@noble` crypto the mobile
 * app already ships, and the CSPRNG is the platform `crypto.getRandomValues`.
 *
 * The x25519 keypair here is ONLY for transport encryption. It is completely
 * separate from the wallet's BLS signing key — never conflate them.
 */

import { fromBase58, toBase58 } from '@amadeus-protocol/sdk'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha2'

import {
	SESSION_NONCE_BYTE_LENGTH,
	SESSION_PUBLIC_KEY_BYTE_LENGTH,
	SESSION_SECRET_KEY_BYTE_LENGTH
} from '../constants'
import { randomBytes } from '../bytes'
import { WalletSdkError } from '../errors'

export interface SessionKeypair {
	/** x25519 public key (Base58) — safe to send in the clear (in the QR / link). */
	publicKey: string
	/** x25519 secret key (32 raw bytes) — keep in memory only, never persist. */
	secretKey: Uint8Array
}

/** Generate a fresh ephemeral x25519 session keypair. */
export function generateSessionKeypair(): SessionKeypair {
	const secretKey = randomBytes(SESSION_SECRET_KEY_BYTE_LENGTH)
	const publicKey = x25519.getPublicKey(secretKey)
	return { publicKey: toBase58(publicKey), secretKey }
}

/**
 * Derive the 32-byte symmetric key shared with a peer. Both sides call this with
 * (their own secret, the other's public) and get the same key.
 */
export function deriveSharedKey(theirPublicKeyBase58: string, mySecretKey: Uint8Array): Uint8Array {
	let theirPublicKey: Uint8Array
	try {
		theirPublicKey = fromBase58(theirPublicKeyBase58)
	} catch {
		throw new WalletSdkError('DECRYPT_FAILED', 'peer public key is not valid Base58')
	}
	if (theirPublicKey.length !== SESSION_PUBLIC_KEY_BYTE_LENGTH) {
		throw new WalletSdkError('DECRYPT_FAILED', 'peer public key has the wrong length')
	}
	// noble rejects low-order / all-zero points by throwing — normalize that (and
	// any other malformed-key throw) to the module's fail-closed error type so the
	// whole path fails closed on a hostile peer key rather than leaking a raw Error.
	let shared: Uint8Array
	try {
		shared = x25519.getSharedSecret(mySecretKey, theirPublicKey)
	} catch {
		throw new WalletSdkError(
			'DECRYPT_FAILED',
			'invalid peer public key (low-order or malformed)'
		)
	}
	return sha256(shared)
}

export interface SealedEnvelope {
	/** Base58 24-byte nonce. */
	nonce: string
	/** Base58 ciphertext (includes the Poly1305 auth tag). */
	ciphertext: string
}

/** Seal plaintext with the shared key. Optional `aad` is authenticated but not encrypted. */
export function seal(
	sharedKey: Uint8Array,
	plaintext: Uint8Array,
	aad?: Uint8Array
): SealedEnvelope {
	const nonce = randomBytes(SESSION_NONCE_BYTE_LENGTH)
	const ciphertext = xchacha20poly1305(sharedKey, nonce, aad).encrypt(plaintext)
	return { nonce: toBase58(nonce), ciphertext: toBase58(ciphertext) }
}

/**
 * Open a sealed envelope. Throws `WalletSdkError('DECRYPT_FAILED')` if the key is
 * wrong, the ciphertext/aad was tampered with, or the envelope is malformed —
 * i.e. it fails closed.
 */
export function open(
	sharedKey: Uint8Array,
	envelope: SealedEnvelope,
	aad?: Uint8Array
): Uint8Array {
	let nonce: Uint8Array
	let ciphertext: Uint8Array
	try {
		nonce = fromBase58(envelope.nonce)
		ciphertext = fromBase58(envelope.ciphertext)
	} catch {
		throw new WalletSdkError('DECRYPT_FAILED', 'sealed envelope is not valid Base58')
	}
	if (nonce.length !== SESSION_NONCE_BYTE_LENGTH) {
		throw new WalletSdkError('DECRYPT_FAILED', 'nonce has the wrong length')
	}
	try {
		return xchacha20poly1305(sharedKey, nonce, aad).decrypt(ciphertext)
	} catch {
		throw new WalletSdkError('DECRYPT_FAILED', 'authentication failed (wrong key or tampered)')
	}
}
