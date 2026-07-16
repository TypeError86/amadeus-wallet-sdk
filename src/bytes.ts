/**
 * Small byte helpers, kept isomorphic (Node, browser, React Native/Hermes).
 *
 * We route randomness and concat through `@noble/hashes/utils` (which uses the
 * platform CSPRNG via `crypto.getRandomValues`) rather than tweetnacl, which
 * throws "no PRNG" under Hermes. UTF-8 uses the platform TextEncoder/Decoder,
 * matching the byte output of the extension's `new TextEncoder().encode(...)`.
 */

import { concatBytes as nobleConcat, randomBytes as nobleRandom } from '@noble/hashes/utils'

export const concatBytes = nobleConcat
export const randomBytes = nobleRandom

export function utf8ToBytes(value: string): Uint8Array {
	return new TextEncoder().encode(value)
}

export function bytesToUtf8(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes)
}

/** 4-byte big-endian length prefix, used to make concatenations unambiguous. */
export function u32be(n: number): Uint8Array {
	if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
		throw new RangeError(`u32be out of range: ${n}`)
	}
	const out = new Uint8Array(4)
	out[0] = (n >>> 24) & 0xff
	out[1] = (n >>> 16) & 0xff
	out[2] = (n >>> 8) & 0xff
	out[3] = n & 0xff
	return out
}

/**
 * Constant-time equality for two byte arrays (length is not secret). Exported
 * for downstream consumers that need to compare secret-derived bytes. Note: the
 * in-package verify paths do NOT hand-roll comparisons — the AEAD tag check
 * (`box.open`) and BLS verification both rely on noble's constant-time primitives.
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
	return diff === 0
}
