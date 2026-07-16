import { derivePublicKeyFromSeedBase58, generateKeypair, toBase58 } from '@amadeus-protocol/sdk'
import { describe, expect, it } from 'vitest'

import {
	createMemorySeenStore,
	guardRequest,
	makeRequest,
	openRequest,
	openResponse,
	sealRequest,
	sealResponse,
	type WalletResponse
} from '../transport/envelope'
import {
	approveConnect,
	completeConnect,
	createConnectRequest,
	isConnectRequestExpired
} from '../transport/session'
import { buildConnectUri, parseConnectResponseUri, parseConnectUri } from '../transport/uri'
import { buildConnectResponseUri } from '../transport/uri'

const FIXED_NOW = 1_780_000_000_000

/** Run a full dApp<->wallet connect handshake and return both established sides. */
function handshake(seed: string, address: string) {
	const { uri, pending } = createConnectRequest({
		origin: 'https://app.amadeus.xyz',
		redirectLink: 'https://app.amadeus.xyz/cb',
		now: FIXED_NOW
	})
	const request = parseConnectUri(uri)
	const wallet = approveConnect(request, { seed, address })
	const session = completeConnect(pending, wallet.response)
	return { session, wallet, request }
}

describe('transport: connect handshake', () => {
	const { privateKey: seed } = generateKeypair()
	const address = derivePublicKeyFromSeedBase58(seed)

	it('round-trips a connect and derives a matching shared key', () => {
		const { session, wallet } = handshake(seed, address)
		expect(session.address).toBe(address)
		// both sides independently derived the SAME symmetric key
		expect(toBase58(session.sharedKey)).toBe(toBase58(wallet.sharedKey))
	})

	it('rejects a connect response bound to a different request', () => {
		const { pending } = createConnectRequest({
			origin: 'https://app.amadeus.xyz',
			now: FIXED_NOW
		})
		const other = createConnectRequest({ origin: 'https://app.amadeus.xyz', now: FIXED_NOW })
		const request = parseConnectUri(other.uri)
		const wallet = approveConnect(request, { seed, address })
		expect(() => completeConnect(pending, wallet.response)).toThrow(/does not match/)
	})

	it('rejects a tampered wallet session key (transcript binding / MITM)', () => {
		const { uri, pending } = createConnectRequest({
			origin: 'https://app.amadeus.xyz',
			now: FIXED_NOW
		})
		const wallet = approveConnect(parseConnectUri(uri), { seed, address })
		// attacker swaps in a different wallet session pubkey, keeping the signature
		const forged = {
			...wallet.response,
			walletPublicKey: createConnectRequest({ origin: 'x', now: FIXED_NOW }).pending
				.dappKeypair.publicKey
		}
		expect(() => completeConnect(pending, forged)).toThrow(/verification/)
	})

	it('detects an expired connect request', () => {
		const { uri } = createConnectRequest({
			origin: 'https://app.amadeus.xyz',
			ttlSeconds: 60,
			now: FIXED_NOW
		})
		const request = parseConnectUri(uri)
		expect(isConnectRequestExpired(request, FIXED_NOW)).toBe(false)
		expect(isConnectRequestExpired(request, FIXED_NOW + 61_000)).toBe(true)
	})

	it('survives the URI round-trip for connect and response', () => {
		const { pending } = createConnectRequest({
			origin: 'https://app.amadeus.xyz',
			now: FIXED_NOW
		})
		const uri = buildConnectUri({
			origin: 'https://app.amadeus.xyz',
			dappPublicKey: pending.dappKeypair.publicKey,
			challenge: pending.challenge,
			requestId: pending.requestId,
			exp: pending.exp,
			redirectLink: 'https://app.amadeus.xyz/cb'
		})
		const parsed = parseConnectUri(uri)
		expect(parsed.origin).toBe('https://app.amadeus.xyz')
		expect(parsed.dappPublicKey).toBe(pending.dappKeypair.publicKey)
		expect(parsed.redirectLink).toBe('https://app.amadeus.xyz/cb')

		const wallet = approveConnect(parsed, { seed, address })
		const cbUrl = buildConnectResponseUri('https://app.amadeus.xyz/cb', wallet.response)
		const back = parseConnectResponseUri(cbUrl)
		expect(back).toEqual(wallet.response)
		expect(completeConnect(pending, back).address).toBe(address)
	})

	it('rejects a non-amadeus scheme', () => {
		expect(() => parseConnectUri('https://evil.xyz/v1/connect?x=1')).toThrow(/scheme/)
	})
})

describe('transport: sealed envelopes', () => {
	const { privateKey: seed } = generateKeypair()
	const address = derivePublicKeyFromSeedBase58(seed)

	it('seals a request the wallet can open, and a response the dApp can open', () => {
		const { session, wallet } = handshake(seed, address)

		const request = makeRequest({
			id: 'req-1',
			method: 'amadeus_signTransaction',
			origin: session.origin,
			params: { contract: 'Coin', method: 'transfer', args: ['addr', '1', 'AMA'] },
			now: FIXED_NOW
		})
		const sealed = sealRequest(session.sharedKey, request)
		const opened = openRequest(wallet.sharedKey, sealed)
		expect(opened.method).toBe('amadeus_signTransaction')
		expect(opened.id).toBe('req-1')

		const response: WalletResponse = { v: 1, id: 'req-1', ok: true, result: { txHash: 'abc' } }
		const sealedResp = sealResponse(wallet.sharedKey, response)
		const openedResp = openResponse(session.sharedKey, sealedResp, 'req-1')
		expect(openedResp.ok).toBe(true)
	})

	it('fails to open a request sealed for a different session', () => {
		const a = handshake(seed, address)
		const b = handshake(seed, address)
		const request = makeRequest({
			id: 'r',
			method: 'amadeus_getAccounts',
			origin: a.session.origin,
			params: {},
			now: FIXED_NOW
		})
		const sealed = sealRequest(a.session.sharedKey, request)
		// b's wallet key can't open a's envelope
		expect(() => openRequest(b.wallet.sharedKey, sealed)).toThrow()
	})

	it('rejects a response whose id does not match', () => {
		const { session, wallet } = handshake(seed, address)
		const response: WalletResponse = { v: 1, id: 'other', ok: true, result: {} }
		const sealed = sealResponse(wallet.sharedKey, response)
		expect(() => openResponse(session.sharedKey, sealed, 'expected')).toThrow(/does not match/)
	})
})

describe('transport: replay + expiry guard', () => {
	it('accepts once then rejects a replayed id, and rejects expired', () => {
		const store = createMemorySeenStore()
		const request = makeRequest({
			id: 'once',
			method: 'amadeus_getAccounts',
			origin: 'https://x',
			params: {},
			ttlSeconds: 60,
			now: FIXED_NOW
		})

		// first use ok
		expect(() => guardRequest(request, store, FIXED_NOW)).not.toThrow()
		// replay rejected
		expect(() => guardRequest(request, store, FIXED_NOW)).toThrow(/replay/)
		// expired rejected
		const stale = makeRequest({
			id: 'other',
			method: 'amadeus_getAccounts',
			origin: 'https://x',
			params: {},
			ttlSeconds: 60,
			now: FIXED_NOW
		})
		expect(() => guardRequest(stale, store, FIXED_NOW + 61_000)).toThrow(/expired/)
	})
})
