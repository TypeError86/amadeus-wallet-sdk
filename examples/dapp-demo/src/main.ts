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
	type ConnectResponseParams,
	type EstablishedSession,
	type PendingConnect,
	type SealedEnvelope
} from '@amadeus-protocol/wallet-sdk'
import QRCode from 'qrcode'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const bridgeInput = $<HTMLInputElement>('bridge')
const connectBtn = $<HTMLButtonElement>('connect')
const regenBtn = $<HTMLButtonElement>('regen')
const copyBtn = $<HTMLButtonElement>('copylink')
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

let session: EstablishedSession | null = null
let bridgeUrl = ''
let stopConnectListener: (() => void) | null = null

type Status = 'idle' | 'wait' | 'ok' | 'err'
function log(message: string, state: Status = 'idle') {
	logEl.textContent = message
	statusEl.dataset.state = state
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
	sessionCard.style.display = 'flex'
	accountEl.textContent = session.address
	signBtn.disabled = false
	log(`Connected as ${session.address}`, 'ok')
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

	// Listen for the sealed response, then send the sealed request.
	const client = new BridgeClient({ bridgeUrl, clientId: channels.toDapp, pollWaitSeconds: 20 })
	const stop = client.start(
		(frame) => {
			stop()
			try {
				const response = openResponse(
					session!.sharedKey,
					frame.payload as SealedEnvelope,
					id
				)
				if (response.ok) {
					const result = response.result as { txHash: string }
					txHashEl.textContent = result.txHash
					txRow.style.display = 'flex'
					log('Signed — the wallet returned a transaction hash.', 'ok')
				} else {
					log(`Rejected: ${response.error.code} — ${response.error.message}`, 'err')
				}
			} catch (error) {
				log(`Bad response: ${(error as Error).message}`, 'err')
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

signBtn.addEventListener('click', () => void signTransfer())
