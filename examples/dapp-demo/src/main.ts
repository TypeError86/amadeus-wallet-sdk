/**
 * Amadeus dApp demo: connect by QR, then exercise the wallet's request types
 * over the bridge — transfer to any account, an arbitrary contract call, and an
 * API-key request. The wallet only SIGNS transactions (returns txPacked); the
 * dApp submits them to the chosen node.
 */

import { toAtomicAma } from '@amadeus-protocol/sdk'
import {
	BridgeClient,
	completeConnect,
	createConnectRequest,
	deriveBridgeChannels,
	deriveConnectChannel,
	makeRequest,
	openResponse,
	sealRequest,
	submitTransaction,
	type ConnectResponseParams,
	type EstablishedSession,
	type PendingConnect,
	type SealedEnvelope,
	type WalletRequest
} from '@amadeus-protocol/wallet-sdk'
import QRCode from 'qrcode'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const bridgeInput = $<HTMLInputElement>('bridge')
const nodeInput = $<HTMLInputElement>('node')
const netseg = $<HTMLDivElement>('netseg')
const connectCard = $<HTMLDivElement>('connect-card')
const connectBtn = $<HTMLButtonElement>('connect')
const regenBtn = $<HTMLButtonElement>('regen')
const copyBtn = $<HTMLButtonElement>('copylink')
const disconnectBtn = $<HTMLButtonElement>('disconnect')
const copyAcctBtn = $<HTMLButtonElement>('copyacct')
const qrBox = $<HTMLDivElement>('qr')
const qrCanvas = $<HTMLCanvasElement>('qrcanvas')
const linkEl = $<HTMLAnchorElement>('link')
const sessionCard = $<HTMLDivElement>('session-card')
const accountEl = $<HTMLSpanElement>('account')
const recipientInput = $<HTMLInputElement>('recipient')
const amountInput = $<HTMLInputElement>('amount')
const sendTransferBtn = $<HTMLButtonElement>('send-transfer')
const scContractInput = $<HTMLInputElement>('sc-contract')
const scMethodInput = $<HTMLInputElement>('sc-method')
const scArgsInput = $<HTMLInputElement>('sc-args')
const signScBtn = $<HTMLButtonElement>('sign-sc')
const genApiBtn = $<HTMLButtonElement>('gen-apikey')
const resultBox = $<HTMLDivElement>('result')
const resultTitle = $<HTMLSpanElement>('result-title')
const resultSub = $<HTMLSpanElement>('result-sub')
const resultRows = $<HTMLDivElement>('result-rows')
const resultLink = $<HTMLAnchorElement>('result-link')
const statusEl = $<HTMLDivElement>('status')
const logEl = $<HTMLPreElement>('log')

const ORIGIN = window.location.origin

const NODE_URLS: Record<string, string> = {
	mainnet: 'https://mainnet-rpc.ama.one/api',
	testnet: 'https://testnet-rpc.ama.one/api'
}
const EXPLORERS: Record<string, string> = {
	mainnet: 'https://explorer.ama.one',
	testnet: 'https://testnet.explorer.ama.one'
}

let session: EstablishedSession | null = null
let bridgeUrl = ''
let currentNet = 'mainnet'
let stopConnectListener: (() => void) | null = null

type Status = 'idle' | 'wait' | 'ok' | 'err'
function log(message: string, state: Status = 'idle') {
	logEl.textContent = message
	statusEl.dataset.state = state
}

const shortAddr = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a)
const nodeUrl = () => nodeInput.value.trim() || NODE_URLS.mainnet
const actionButtons = () => [sendTransferBtn, signScBtn, genApiBtn]
const setBusy = (busy: boolean) => actionButtons().forEach((b) => (b.disabled = busy))
const genId = () =>
	typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `req-${Date.now()}`

const explorerTxUrl = (hash: string) => {
	const base = EXPLORERS[currentNet]
	return base ? `${base}/tx/${hash}` : null
}

/** Network selector: mainnet/testnet lock the node URL; custom lets you type one. */
function setNetwork(net: string) {
	currentNet = net
	for (const b of netseg.querySelectorAll<HTMLButtonElement>('.seg')) {
		b.classList.toggle('active', b.dataset.net === net)
	}
	if (net === 'custom') {
		nodeInput.readOnly = false
		if (nodeInput.value === NODE_URLS.mainnet || nodeInput.value === NODE_URLS.testnet) {
			nodeInput.value = ''
		}
		nodeInput.focus()
	} else {
		nodeInput.readOnly = true
		nodeInput.value = NODE_URLS[net]
	}
}

async function connect() {
	bridgeUrl = bridgeInput.value.trim() || 'https://bridge.ama.one'
	stopConnectListener?.()

	let request: { uri: string; pending: PendingConnect }
	try {
		request = createConnectRequest({ origin: ORIGIN, bridgeUrl })
	} catch (error) {
		log(`Cannot start: ${(error as Error).message}`, 'err')
		return
	}
	const { uri, pending } = request

	await QRCode.toCanvas(qrCanvas, uri, { width: 240, margin: 1 })
	qrBox.style.display = 'flex'
	linkEl.href = uri
	linkEl.textContent = uri

	// Listen on the connect channel for the wallet's (public) connect response.
	const connectClient = new BridgeClient({
		bridgeUrl,
		clientId: deriveConnectChannel(pending.dappKeypair.publicKey),
		pollWaitSeconds: 20
	})
	stopConnectListener = connectClient.start(
		(frame) => {
			stopConnectListener?.()
			try {
				session = completeConnect(pending, frame.payload as ConnectResponseParams)
				onConnected()
			} catch (error) {
				log(`Connect verification failed: ${(error as Error).message}`, 'err')
			}
		},
		(error) => log(`Bridge error: ${String(error)}`, 'err')
	)

	log('Waiting — scan the QR with the Amadeus wallet and approve.', 'wait')
}

function onConnected() {
	if (!session) return
	qrBox.style.display = 'none'
	connectCard.style.display = 'none'
	sessionCard.style.display = 'flex'
	accountEl.textContent = shortAddr(session.address)
	recipientInput.placeholder = `Recipient address (blank = ${shortAddr(session.address)})`
	setBusy(false)
	log(`Connected as ${shortAddr(session.address)}`, 'ok')
}

function disconnect() {
	stopConnectListener?.()
	stopConnectListener = null
	session = null
	sessionCard.style.display = 'none'
	qrBox.style.display = 'none'
	resultBox.style.display = 'none'
	connectCard.style.display = 'flex'
	log('Disconnected. Connect again to continue.', 'idle')
}

function showResult(opts: {
	title: string
	sub?: string
	rows: [string, string][]
	explorerHash?: string
}) {
	resultTitle.textContent = opts.title
	resultSub.textContent = opts.sub ?? ''
	resultSub.style.display = opts.sub ? 'block' : 'none'
	resultRows.replaceChildren()
	for (const [k, v] of opts.rows) {
		const row = document.createElement('div')
		row.className = 'rrow'
		const key = document.createElement('span')
		key.className = 'k'
		key.textContent = k
		const val = document.createElement('span')
		val.className = 'v'
		val.textContent = v
		row.append(key, val)
		resultRows.append(row)
	}
	const url = opts.explorerHash ? explorerTxUrl(opts.explorerHash) : null
	if (url) {
		resultLink.href = url
		resultLink.style.display = 'block'
	} else {
		resultLink.style.display = 'none'
	}
	resultBox.style.display = 'flex'
}

/**
 * Send one request to the wallet over the bridge and hand the (unsealed) result
 * to `onResult`. Any request type works — the caller decides what to do with the
 * result (submit a signed tx, show an API key, …).
 */
async function sendRequest(
	method: WalletRequest['method'],
	params: unknown,
	onResult: (result: unknown) => void | Promise<void>
) {
	if (!session) return
	setBusy(true)
	resultBox.style.display = 'none'

	const channels = deriveBridgeChannels(session.sharedKey)
	const id = genId()
	const client = new BridgeClient({ bridgeUrl, clientId: channels.toDapp, pollWaitSeconds: 20 })

	const stop = client.start(
		async (frame) => {
			stop()
			try {
				const response = openResponse(session!.sharedKey, frame.payload as SealedEnvelope, id)
				if (!response.ok) {
					log(`Rejected: ${response.error.code} — ${response.error.message}`, 'err')
					return
				}
				await onResult(response.result)
			} catch (error) {
				log(`Failed: ${(error as Error).message}`, 'err')
			} finally {
				setBusy(false)
			}
		},
		(error) => log(`Bridge error: ${String(error)}`, 'err')
	)

	try {
		const request = makeRequest({ id, method, origin: ORIGIN, params })
		await client.send(channels.toWallet, id, sealRequest(session.sharedKey, request))
		log('Request sent — approve it in the wallet…', 'wait')
	} catch (error) {
		stop()
		setBusy(false)
		log(`Send failed: ${(error as Error).message}`, 'err')
	}
}

/** Submit the signed txPacked to the node (submit_and_wait) and return the hash. */
async function submitSigned(result: unknown): Promise<string> {
	const r = result as { txHash: string; txPacked: number[] }
	log('Signed — submitting to the chain…', 'wait')
	await submitTransaction(r.txPacked, { nodeUrl: nodeUrl(), wait: true })
	return r.txHash
}

function sendTransfer() {
	if (!session) return
	const self = session.address
	const recipient = recipientInput.value.trim() || self
	const amount = amountInput.value.trim() || '1'
	let atomic: string
	try {
		atomic = String(toAtomicAma(amount))
	} catch {
		log('Enter a valid amount.', 'err')
		return
	}
	void sendRequest(
		'amadeus_signTransaction',
		{ contract: 'Coin', method: 'transfer', args: [recipient, atomic, 'AMA'] },
		async (result) => {
			const hash = await submitSigned(result)
			showResult({
				title: 'Transfer confirmed',
				sub: recipient === self ? 'Sent to yourself (shows as Sent + Received)' : 'Sent',
				rows: [
					['Amount', `${amount} AMA`],
					['To', recipient === self ? `${shortAddr(recipient)} (self)` : shortAddr(recipient)],
					['Tx hash', shortAddr(hash)]
				],
				explorerHash: hash
			})
			log('Transfer confirmed on-chain.', 'ok')
		}
	)
}

function signContractCall() {
	if (!session) return
	const contract = scContractInput.value.trim()
	const method = scMethodInput.value.trim()
	if (!contract || !method) {
		log('Contract and method are required.', 'err')
		return
	}
	let args: unknown[]
	try {
		args = JSON.parse(scArgsInput.value.trim() || '[]')
		if (!Array.isArray(args)) throw new Error('not an array')
	} catch {
		log('Args must be a JSON array, e.g. ["addr","1000000000","AMA"].', 'err')
		return
	}
	void sendRequest('amadeus_signTransaction', { contract, method, args }, async (result) => {
		const hash = await submitSigned(result)
		showResult({
			title: 'Contract call confirmed',
			rows: [
				['Call', `${contract}.${method}`],
				['Tx hash', shortAddr(hash)]
			],
			explorerHash: hash
		})
		log('Contract call confirmed on-chain.', 'ok')
	})
}

function requestApiKey() {
	if (!session) return
	void sendRequest('amadeus_generateApiKey', { aud: ORIGIN, exp_in: 3600 }, (result) => {
		showResult({
			title: 'API key issued',
			sub: 'Signed by the wallet — no on-chain transaction',
			rows: [['API key', (result as { apiKey: string }).apiKey]]
		})
		log('API key issued by the wallet.', 'ok')
	})
}

connectBtn.addEventListener('click', () => void connect())
regenBtn.addEventListener('click', () => void connect())

copyBtn.addEventListener('click', () => {
	const uri = linkEl.textContent ?? ''
	if (!uri || !navigator.clipboard) return
	void navigator.clipboard.writeText(uri).then(() => {
		const prev = copyBtn.textContent
		copyBtn.textContent = 'Copied'
		window.setTimeout(() => {
			copyBtn.textContent = prev
		}, 1200)
	})
})

netseg.addEventListener('click', (e) => {
	const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.seg')
	if (btn?.dataset.net) setNetwork(btn.dataset.net)
})

disconnectBtn.addEventListener('click', disconnect)

copyAcctBtn.addEventListener('click', () => {
	if (!session || !navigator.clipboard) return
	void navigator.clipboard.writeText(session.address).then(() => {
		const prev = copyAcctBtn.textContent
		copyAcctBtn.textContent = 'Copied'
		window.setTimeout(() => {
			copyAcctBtn.textContent = prev
		}, 1200)
	})
})

sendTransferBtn.addEventListener('click', sendTransfer)
signScBtn.addEventListener('click', signContractCall)
genApiBtn.addEventListener('click', requestApiKey)
