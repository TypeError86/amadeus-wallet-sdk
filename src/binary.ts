/**
 * JSON-safe encoding for binary values (typed arrays) that cross a text
 * transport. Transaction args can contain raw bytes (e.g. a recipient pubkey);
 * JSON.stringify would mangle a Uint8Array into `{"0":7,...}`, which the node
 * then vecpack-encodes as a MAP instead of BYTES and rejects.
 *
 * Values are wrapped as `{ "__amadeusBytes__": "<base64>" }` before transport and
 * restored to Uint8Array right before the SDK consumes them. The tag string and
 * base64 payload are wire-compatible with the wallet extension's `utils/binary.ts`
 * (only the base64 codec differs — we use the SDK's helpers so it works on Hermes,
 * which has no `btoa`/`atob`).
 */

import { base64ToUint8Array, uint8ArrayToBase64 } from '@amadeus-protocol/sdk'

export const BYTES_TAG = '__amadeusBytes__'

export type TaggedBytes = { [BYTES_TAG]: string }

/** Realm-safe detection of binary values (typed arrays, DataView, ArrayBuffer). */
function asBytes(value: unknown): Uint8Array | null {
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
	}
	if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
		return new Uint8Array(value as ArrayBuffer)
	}
	return null
}

export function isTaggedBytes(value: unknown): value is TaggedBytes {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === 1 &&
		typeof (value as Record<string, unknown>)[BYTES_TAG] === 'string'
	)
}

/**
 * Recursively replace binary values with a JSON-safe tagged envelope.
 * Idempotent: already-tagged values pass through unchanged.
 */
export function encodeBinaryValues(value: unknown): unknown {
	const bytes = asBytes(value)
	if (bytes) {
		return { [BYTES_TAG]: uint8ArrayToBase64(bytes) }
	}
	if (Array.isArray(value)) {
		return value.map(encodeBinaryValues)
	}
	if (typeof value === 'object' && value !== null) {
		if (isTaggedBytes(value)) return value
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, encodeBinaryValues(entry)])
		)
	}
	return value
}

/** Recursively restore tagged envelopes back into Uint8Array. */
export function decodeBinaryValues(value: unknown): unknown {
	if (isTaggedBytes(value)) {
		return base64ToUint8Array(value[BYTES_TAG])
	}
	if (Array.isArray(value)) {
		return value.map(decodeBinaryValues)
	}
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, decodeBinaryValues(entry)])
		)
	}
	return value
}

/** Human-readable stand-in for tagged bytes when displaying args in an approval UI. */
export function describeBinaryValues(value: unknown): unknown {
	if (isTaggedBytes(value)) {
		const bytes = base64ToUint8Array(value[BYTES_TAG])
		return `<bytes[${bytes.length}] base64:${value[BYTES_TAG]}>`
	}
	if (Array.isArray(value)) {
		return value.map(describeBinaryValues)
	}
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, describeBinaryValues(entry)])
		)
	}
	return value
}
