import { describe, expect, test } from 'bun:test'
import { parseArgs, submitErrorMessage, toAtomicAmount } from '../src/helpers'

describe('toAtomicAmount', () => {
	test('converts decimal AMA to exact atomic units', () => {
		expect(toAtomicAmount('1')).toBe('1000000000')
		expect(toAtomicAmount(' 2.5 ')).toBe('2500000000')
		expect(toAtomicAmount('0.000000001')).toBe('1')
		expect(toAtomicAmount('12345678.123456789')).toBe('12345678123456789')
		expect(toAtomicAmount('99999999999')).toBe('99999999999000000000')
		expect(toAtomicAmount('.5')).toBe('500000000')
		expect(toAtomicAmount('1.')).toBe('1000000000')
	})

	test('rejects anything that is not a positive decimal with at most 9 places', () => {
		for (const input of [
			'',
			'abc',
			'-1',
			'0',
			'0.000000000',
			'1.1234567891',
			'1e3',
			'1,5',
			'.',
			'.0',
			'1..5',
			'.1234567891',
			'NaN',
			'Infinity'
		]) {
			expect(toAtomicAmount(input)).toBeNull()
		}
	})
})

describe('parseArgs', () => {
	test('accepts a JSON array, empty input as []', () => {
		expect(parseArgs('["a",1]')).toEqual(['a', 1])
		expect(parseArgs('  ')).toEqual([])
	})

	test('rejects invalid JSON and non-arrays', () => {
		expect(parseArgs('[1,')).toBeNull()
		expect(parseArgs('{"a":1}')).toBeNull()
		expect(parseArgs('"x"')).toBeNull()
	})
})

describe('submitErrorMessage', () => {
	test('flags a signature rejection as a likely network mismatch', () => {
		expect(submitErrorMessage('invalid_signature')).toMatch(/network mismatch\?/)
	})

	test('falls back to the SDK message for other codes', () => {
		expect(submitErrorMessage('invalid_nonce')).not.toMatch(/network mismatch/)
		expect(submitErrorMessage('something_new')).toBe('Transaction failed: something_new')
	})
})
