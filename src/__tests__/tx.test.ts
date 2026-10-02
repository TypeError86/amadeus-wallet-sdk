import { fromBase58, generateKeypair, NetworkType, TransactionBuilder } from '@amadeus-protocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeBinaryValues } from '../binary'
import { signTransaction } from '../tx'

describe('signTransaction', () => {
	const { privateKey: seed } = generateKeypair()
	const { publicKey: recipient } = generateKeypair()

	// Freeze time so the SDK's timestamp nonce is identical across both calls,
	// making the packed bytes directly comparable.
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'))
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('returns txPacked as a plain number[]', () => {
		const result = signTransaction({
			seed,
			contract: 'Coin',
			method: 'transfer',
			args: [recipient, '1000000000', 'AMA']
		})
		expect(Array.isArray(result.txPacked)).toBe(true)
		expect(result.txPacked.every((n) => typeof n === 'number')).toBe(true)
		expect(typeof result.txHash).toBe('string')
	})

	it('Coin.transfer is byte-identical to the SDK with a decoded recipient', () => {
		const ours = signTransaction({
			seed,
			contract: 'Coin',
			method: 'transfer',
			args: [recipient, '1000000000', 'AMA']
		})
		const sdk = new TransactionBuilder(seed).buildAndSign('Coin', 'transfer', [
			fromBase58(recipient),
			'1000000000',
			'AMA'
		])
		expect(ours.txHash).toBe(sdk.txHash)
		expect(ours.txPacked).toEqual(Array.from(sdk.txPacked))
	})

	it('decodes tagged binary args to match a raw-bytes SDK call', () => {
		const rawBytes = fromBase58(recipient)
		const wireArgs = encodeBinaryValues([rawBytes, '5']) as unknown[]
		const ours = signTransaction({ seed, contract: 'Custom', method: 'poke', args: wireArgs })
		const sdk = new TransactionBuilder(seed).buildAndSign('Custom', 'poke', [rawBytes, '5'])
		expect(ours.txPacked).toEqual(Array.from(sdk.txPacked))
	})
})

describe('signTransaction network binding', () => {
	const { privateKey: seed } = generateKeypair()
	const { publicKey: recipient } = generateKeypair()
	const args = [recipient, '1000000000', 'AMA']

	// Freeze time so the nonce is identical across calls and only the DST varies.
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'))
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('defaults to mainnet (byte-identical to explicit mainnet)', () => {
		const def = signTransaction({ seed, contract: 'Coin', method: 'transfer', args })
		const main = signTransaction({
			seed,
			contract: 'Coin',
			method: 'transfer',
			args,
			network: NetworkType.MAINNET
		})
		expect(def.txPacked).toEqual(main.txPacked)
	})

	it('testnet binds to a different DST: same hash, different signature', () => {
		const main = signTransaction({
			seed,
			contract: 'Coin',
			method: 'transfer',
			args,
			network: NetworkType.MAINNET
		})
		const test = signTransaction({
			seed,
			contract: 'Coin',
			method: 'transfer',
			args,
			network: NetworkType.TESTNET
		})
		// The hash is over the tx (signer/nonce/action), so it's network-independent;
		// only the signature changes, which is what makes the tx unreplayable.
		expect(test.txHash).toBe(main.txHash)
		expect(test.txPacked).not.toEqual(main.txPacked)
	})
})
