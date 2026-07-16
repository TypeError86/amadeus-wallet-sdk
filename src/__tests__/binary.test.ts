import { describe, expect, it } from 'vitest'

import {
	BYTES_TAG,
	decodeBinaryValues,
	describeBinaryValues,
	encodeBinaryValues,
	isTaggedBytes
} from '../binary'

describe('binary values', () => {
	it('wraps and restores a Uint8Array', () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 255])
		const encoded = encodeBinaryValues(bytes)
		expect(isTaggedBytes(encoded)).toBe(true)

		const decoded = decodeBinaryValues(encoded)
		expect(decoded).toBeInstanceOf(Uint8Array)
		expect(Array.from(decoded as Uint8Array)).toEqual([0, 1, 2, 250, 255])
	})

	it('handles nested arrays and objects', () => {
		const input = { a: [new Uint8Array([9]), 'x'], b: 3 }
		const round = decodeBinaryValues(encodeBinaryValues(input)) as {
			a: [Uint8Array, string]
			b: number
		}
		expect(Array.from(round.a[0])).toEqual([9])
		expect(round.a[1]).toBe('x')
		expect(round.b).toBe(3)
	})

	it('is idempotent on already-encoded values', () => {
		const encoded = encodeBinaryValues(new Uint8Array([1, 2]))
		expect(encodeBinaryValues(encoded)).toEqual(encoded)
	})

	it('describes tagged bytes for an approval UI', () => {
		const encoded = encodeBinaryValues(new Uint8Array([1, 2, 3]))
		expect(describeBinaryValues(encoded)).toMatch(/^<bytes\[3\] base64:/)
	})

	it('leaves plain values untouched', () => {
		expect(encodeBinaryValues('hello')).toBe('hello')
		expect(encodeBinaryValues(42)).toBe(42)
		expect(BYTES_TAG).toBe('__amadeusBytes__')
	})
})
