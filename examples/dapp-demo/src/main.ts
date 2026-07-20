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
const signBtn = $<HTMLButtonElement>('sign')
const qrBox = $<HTMLDivElement>('qr')
const qrCanvas = $<HTMLCanvasElement>('qrcanvas')
const linkEl = $<HTMLAnchorElement>('link')
const sessionCard = $<HTMLDivElement>('session-card')
const accountEl = $<HTMLSpanElement>('account')
const txRow = $<HTMLDivElement>('txrow')
const txHashEl = $<HTMLSpanElement>('txhash')
const logEl = $<HTMLPreElement>('log')

const ORIGIN = window.location.origin

let session: EstablishedSession | null = null
let bridgeUrl = ''
let stopConnectListener: (() => void) | null = null

function log(message: string) {
	logEl.textContent = message
}

async function connect() {
	bridgeUrl = bridgeInput.value.trim() || 'http://localhost:8787'
	stopConnectListener?.()

	let request: { uri: string; pending: PendingConnect }
	try {
		request = createConnectRequest({ origin: ORIGIN, bridgeUrl })
	} catch (error) {
		log(`Cannot start: ${(error as Error).message}`)
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
				log(`Connect verification failed: ${(error as Error).message}`)
			}
		},
		(error) => log(`Bridge error: ${String(error)}`)
	)

	log('Scan the QR with the Amadeus wallet and approve the connection…')
}

function onConnected() {
	if (!session) return
	qrBox.style.display = 'none'
	sessionCard.style.display = 'flex'
	accountEl.textContent = session.address
	signBtn.disabled = false
	log(`Connected as ${session.address}`)
}

async function signTransfer() {
	if (!session) return
	signBtn.disabled = true
	txRow.style.display = 'none'

	const channels = deriveBridgeChannels(session.sharedKey)
	const id =
		typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `req-${Date.now()}`

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
				const response = openResponse(session!.sharedKey, frame.payload as SealedEnvelope, id)
				if (response.ok) {
					const result = response.result as { txHash: string }
					txHashEl.textContent = result.txHash
					txRow.style.display = 'flex'
					log('Signed! The wallet returned a transaction hash.')
				} else {
					log(`Rejected: ${response.error.code} — ${response.error.message}`)
				}
			} catch (error) {
				log(`Bad response: ${(error as Error).message}`)
			} finally {
				signBtn.disabled = false
			}
		},
		(error) => log(`Bridge error: ${String(error)}`)
	)

	try {
		await client.send(channels.toWallet, id, sealRequest(session.sharedKey, request))
		log('Sign request sent — approve it in the wallet…')
	} catch (error) {
		stop()
		signBtn.disabled = false
		log(`Send failed: ${(error as Error).message}`)
	}
}

connectBtn.addEventListener('click', () => void connect())
signBtn.addEventListener('click', () => void signTransfer())
