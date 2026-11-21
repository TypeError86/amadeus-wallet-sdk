import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

GlobalRegistrator.register({ url: 'http://localhost:5173' })

const SELF = 'SelfAddr1111111111111111111111111111111111111111'
const OTHER = 'OtherAddr222222222222222222222222222222222222222'
const NODE_TESTNET = 'https://testnet-rpc.ama.one/api'
const REQUEST_TIMEOUT_MS = 120_000

interface Listener {
	clientId: string
	onFrame: (frame: { payload: unknown }) => unknown
	stopped: boolean
}
interface SentRequest {
	id: string
	method: string
	params: { args?: unknown[] }
}

const listeners: Listener[] = []
const sent: SentRequest[] = []
const fetched: string[] = []
const submitResults: unknown[] = []
const longTimers = new Map<number, () => void>()

class FakeBridgeClient {
	constructor(readonly options: { clientId: string }) {}
	start(onFrame: Listener['onFrame']) {
		const listener = { clientId: this.options.clientId, onFrame, stopped: false }
		listeners.push(listener)
		return () => {
			listener.stopped = true
		}
	}
	async send(_channel: string, _id: string, request: SentRequest) {
		sent.push(request)
	}
}

mock.module('@amadeus-protocol/wallet-sdk', () => ({
	BridgeClient: FakeBridgeClient,
	completeConnect: () => ({ address: SELF, sharedKey: new Uint8Array(32) }),
	createConnectRequest: () => ({
		uri: 'amadeus://connect?demo',
		pending: { dappKeypair: { publicKey: new Uint8Array(1) } }
	}),
	deriveBridgeChannels: () => ({ toDapp: 'to-dapp', toWallet: 'to-wallet' }),
	deriveConnectChannel: () => 'connect-channel',
	makeRequest: (request: SentRequest) => request,
	openResponse: (_key: Uint8Array, payload: unknown) => payload,
	sealRequest: (_key: Uint8Array, request: SentRequest) => request,
	submitTransaction: async () => submitResults.shift(),
	verifyMessage: () => true
}))
mock.module('qrcode', () => ({ default: { toCanvas: async () => {} } }))

const realSetTimeout = window.setTimeout.bind(window)
const realClearTimeout = window.clearTimeout.bind(window)
const timerIds = { next: 1_000_000 }
const patchedSetTimeout = (handler: () => void, delay?: number) => {
	if ((delay ?? 0) < REQUEST_TIMEOUT_MS) return realSetTimeout(handler, delay)
	const id = timerIds.next++
	longTimers.set(id, handler)
	return id
}
const patchedClearTimeout = (id?: number) => {
	if (id !== undefined && longTimers.delete(id)) return
	realClearTimeout(id)
}
Object.assign(window, { setTimeout: patchedSetTimeout, clearTimeout: patchedClearTimeout })
Object.assign(globalThis, { setTimeout: patchedSetTimeout, clearTimeout: patchedClearTimeout })

globalThis.fetch = (async (input: string | URL) => {
	fetched.push(String(input))
	return new Response(JSON.stringify({ balances: [{ symbol: 'AMA', float: 5 }] }))
}) as typeof fetch

const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
document.body.innerHTML = page
	.slice(page.indexOf('<body>') + '<body>'.length, page.indexOf('</body>'))
	.replace(/<script[^]*?<\/script>/g, '')

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const flush = () => new Promise((resolve) => realSetTimeout(resolve, 0))
const logText = () => byId('log').textContent ?? ''
const sendButton = () => byId<HTMLButtonElement>('send-transfer')
const openRequestListener = () =>
	listeners.filter((listener) => listener.clientId === 'to-dapp' && !listener.stopped).at(-1)
const lastRequest = () => sent.at(-1) as SentRequest
const fireLongTimers = () => {
	const pending = [...longTimers.values()]
	longTimers.clear()
	pending.forEach((handler) => handler())
}

async function walletReplies(result: unknown) {
	const listener = openRequestListener()
	if (!listener) throw new Error('no pending request listener')
	await listener.onFrame({ payload: { ok: true, id: lastRequest().id, result } })
	await flush()
}

async function sendAmount(amount: string) {
	byId<HTMLInputElement>('amount').value = amount
	sendButton().click()
	await flush()
}

async function connectWallet() {
	byId<HTMLButtonElement>('connect').click()
	await flush()
	const connectListener = listeners
		.filter((listener) => listener.clientId === 'connect-channel')
		.at(-1)
	connectListener?.onFrame({ payload: {} })
	await flush()
	await walletReplies({ accounts: [{ address: SELF, name: 'Main' }] })
}

// Settle whatever a previous test left open, so each test starts idle.
async function settleOpenRequest() {
	const listener = openRequestListener()
	if (!listener) return
	await listener.onFrame({ payload: { ok: false, error: { code: 'RESET', message: 'reset' } } })
	await flush()
}

beforeAll(async () => {
	await import('../src/main.ts')
	byId('connect-card').querySelector<HTMLButtonElement>('[data-net="testnet"]')?.click()
	await connectWallet()
})

beforeEach(settleOpenRequest)

describe('network picker', () => {
	test('has a hint that it must match the wallet network', () => {
		const hintId = byId('netseg').getAttribute('aria-describedby') ?? ''
		expect(byId(hintId)?.textContent ?? '').toMatch(/wallet/i)
	})

	test('balances load from the picked node, and the picker is hidden while connected', () => {
		expect(fetched).toContain(`${NODE_TESTNET}/wallet/balance_all/${SELF}`)
		expect(fetched.every((url) => url.startsWith(NODE_TESTNET))).toBe(true)
		expect(byId('connect-card').style.display).toBe('none')
		expect(sent.some((request) => request.method === 'amadeus_getAccounts')).toBe(true)
	})
})

describe('sendTransfer amount validation', () => {
	for (const amount of [
		'abc',
		'-1',
		'0',
		'0.0',
		'1.1234567891',
		'1e3',
		'1,5',
		'Infinity',
		' . '
	]) {
		test(`rejects ${JSON.stringify(amount)} before signing`, async () => {
			const before = sent.length
			await sendAmount(amount)
			expect(logText()).toBe('Enter a valid amount.')
			expect(sent.length).toBe(before)
			expect(sendButton().disabled).toBe(false)
		})
	}

	for (const [amount, atomic] of [
		['1.5', '1500000000'],
		['.5', '500000000'],
		['0.000000001', '1'],
		['12345678.123456789', '12345678123456789']
	]) {
		test(`signs ${amount} AMA as ${atomic} atomic units`, async () => {
			await sendAmount(amount)
			expect(lastRequest().method).toBe('amadeus_signTransaction')
			expect(lastRequest().params.args).toEqual([SELF, atomic, 'AMA'])
			submitResults.push({ error: 'ok', hash: 'TxHash' })
			await walletReplies({ txHash: 'TxHash', txPacked: [1, 2, 3] })
			expect(logText()).toBe('Transfer confirmed on-chain.')
		})
	}
})

describe('submit errors', () => {
	test('a signature rejection points at a network mismatch', async () => {
		await sendAmount('1')
		submitResults.push({ error: 'invalid_signature' })
		await walletReplies({ txHash: 'TxHash', txPacked: [1] })
		expect(logText()).toMatch(/network mismatch\?/)
		expect(byId('result').style.display).toBe('none')
		expect(sendButton().disabled).toBe(false)
	})

	test('other node errors are reported, not shown as confirmed', async () => {
		await sendAmount('1')
		submitResults.push({ error: 'invalid_nonce' })
		await walletReplies({ txHash: 'TxHash', txPacked: [1] })
		expect(logText()).toStartWith('Failed: ')
		expect(logText()).not.toMatch(/confirmed/)
	})

	test('a tx included on-chain whose call failed is not shown as confirmed', async () => {
		await sendAmount('1')
		submitResults.push({
			error: 'ok',
			hash: 'TxHash',
			receipt: { success: false, result: 'insufficient_funds' }
		})
		await walletReplies({ txHash: 'TxHash', txPacked: [1] })
		expect(logText()).toBe('Failed: On-chain, but the call failed: Insufficient funds')
		expect(byId('result').style.display).toBe('none')
	})
})

describe('request timeout', () => {
	test('re-enables the buttons and stops listening when the wallet never answers', async () => {
		await sendAmount('1')
		expect(sendButton().disabled).toBe(true)
		const listener = openRequestListener()
		fireLongTimers()
		expect(sendButton().disabled).toBe(false)
		expect(logText()).toMatch(/no answer/i)
		expect(listener?.stopped).toBe(true)
	})

	test('an answered request clears its timeout', async () => {
		await sendAmount('1')
		submitResults.push({ error: 'ok', hash: 'TxHash' })
		await walletReplies({ txHash: 'TxHash', txPacked: [1] })
		expect(longTimers.size).toBe(0)
	})

	test('disconnect cancels a pending request', async () => {
		await sendAmount('1')
		const listener = openRequestListener()
		byId<HTMLButtonElement>('disconnect').click()
		expect(listener?.stopped).toBe(true)
		expect(longTimers.size).toBe(0)
		expect(logText()).toStartWith('Disconnected')
	})
})

describe('contract call', () => {
	beforeAll(async () => {
		if (byId('session-card').style.display !== 'flex') await connectWallet()
	})

	test('rejects args that are not a JSON array', async () => {
		byId<HTMLInputElement>('sc-args').value = '{"a":1}'
		const before = sent.length
		byId<HTMLButtonElement>('sign-sc').click()
		await flush()
		expect(logText()).toStartWith('Args must be a JSON array')
		expect(sent.length).toBe(before)
	})

	test('signs a valid call for the selected account', async () => {
		byId<HTMLInputElement>('sc-args').value = `["${OTHER}","1","AMA"]`
		byId<HTMLButtonElement>('sign-sc').click()
		await flush()
		expect(lastRequest().method).toBe('amadeus_signTransaction')
		expect(lastRequest().params.args).toEqual([OTHER, '1', 'AMA'])
	})
})
