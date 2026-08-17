/**
 * Minimal Amadeus dApp: connect by QR, then request a signature over the bridge.
 *
 * Flow (cross-device):
 *   createConnectRequest -> show QR  ─(wallet scans + approves)─►
 *   wallet returns the connect response on the connect channel ─►
 *   completeConnect -> session (shared key) ─►
 *   sealRequest(signTransaction) over the derived channel -> wallet signs -> txHash
 */

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
	type SealedEnvelope
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
const signBtn = $<HTMLButtonElement>('sign')
const qrBox = $<HTMLDivElement>('qr')
const qrCanvas = $<HTMLCanvasElement>('qrcanvas')
const linkEl = $<HTMLAnchorElement>('link')
const sessionCard = $<HTMLDivElement>('session-card')
const accountEl = $<HTMLSpanElement>('account')
const txRow = $<HTMLDivElement>('txrow')
const txHashEl = $<HTMLSpanElement>('txhash')
const statusEl = $<HTMLDivElement>('status')
const logEl = $<HTMLPreElement>('log')

const ORIGIN = window.location.origin

const NODE_URLS: Record<string, string> = {
	mainnet: 'https://mainnet-rpc.ama.one/api',
	testnet: 'https://testnet-rpc.ama.one/api'
}

let session: EstablishedSession | null = null
let bridgeUrl = ''
let stopConnectListener: (() => void) | null = null

type Status = 'idle' | 'wait' | 'ok' | 'err'
function log(message: string, state: Status = 'idle') {
	logEl.textContent = message
	statusEl.dataset.state = state
}

const shortAddr = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a)

/** Network selector: mainnet/testnet lock the node URL; custom lets you type one. */
function setNetwork(net: string) {
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
	qrBox.style.display = 'block'
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
	signBtn.disabled = false
	log(`Connected as ${shortAddr(session.address)}`, 'ok')
}

function disconnect() {
	stopConnectListener?.()
	stopConnectListener = null
	session = null
	sessionCard.style.display = 'none'
	qrBox.style.display = 'none'
	txRow.style.display = 'none'
	signBtn.disabled = true
	connectCard.style.display = 'flex'
	log('Disconnected. Connect again to continue.', 'idle')
}

async function signTransfer() {
	if (!session) return
	signBtn.disabled = true
	txRow.style.display = 'none'

	const channels = deriveBridgeChannels(session.sharedKey)
	const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `req-${Date.now()}`

	const request = makeRequest({
		id,
		method: 'amadeus_signTransaction',
		origin: ORIGIN,
		params: {
			contract: 'Coin',
			method: 'transfer',
			args: [session.address, '1000000000', 'AMA'] // 1 AMA (9 decimals) to self
		}
	})

	const nodeUrl = nodeInput.value.trim() || 'https://mainnet-rpc.ama.one/api'

	// Listen for the sealed response, then send the sealed request. The wallet only
	// SIGNS (returns txPacked); the dApp submits it to a node — so do that here.
	const client = new BridgeClient({ bridgeUrl, clientId: channels.toDapp, pollWaitSeconds: 20 })
	const stop = client.start(
		async (frame) => {
			stop()
			try {
				const response = openResponse(
					session!.sharedKey,
					frame.payload as SealedEnvelope,
					id
				)
				if (!response.ok) {
					log(`Rejected: ${response.error.code} — ${response.error.message}`, 'err')
					return
				}
				const result = response.result as { txHash: string; txPacked: number[] }
				log('Signed — submitting to the chain…', 'wait')
				await submitTransaction(result.txPacked, { nodeUrl, wait: true })
				txHashEl.textContent = result.txHash
				txRow.style.display = 'flex'
				log('Sent — transaction submitted to the chain.', 'ok')
			} catch (error) {
				log(`Failed: ${(error as Error).message}`, 'err')
			} finally {
				signBtn.disabled = false
			}
		},
		(error) => log(`Bridge error: ${String(error)}`, 'err')
	)

	try {
		await client.send(channels.toWallet, id, sealRequest(session.sharedKey, request))
		log('Sign request sent — approve it in the wallet…', 'wait')
	} catch (error) {
		stop()
		signBtn.disabled = false
		log(`Send failed: ${(error as Error).message}`, 'err')
	}
}

connectBtn.addEventListener('click', () => void connect())
// Regenerate: start a fresh connect request (new challenge + QR), e.g. after the
// previous one expired. connect() tears down the old listener first.
regenBtn.addEventListener('click', () => void connect())

// Copy the connect link — useful for pasting into the wallet instead of scanning.
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

signBtn.addEventListener('click', () => void signTransfer())
