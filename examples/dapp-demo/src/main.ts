/**
 * Amadeus dApp demo: connect by QR, then exercise the wallet's request types
 * over the bridge — transfer to any account, an arbitrary contract call, and an
 * API-key request. The wallet only SIGNS transactions (returns txPacked); the
 * dApp submits them to the chosen node.
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
	verifyMessage,
	type ConnectResponseParams,
	type EstablishedSession,
	type PendingConnect,
	type SealedEnvelope,
	type WalletRequest
} from '@amadeus-protocol/wallet-sdk'
import QRCode from 'qrcode'
import { parseArgs, submitErrorMessage, toAtomicAmount } from './helpers'

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const bridgeInput = byId<HTMLInputElement>('bridge')
const nodeInput = byId<HTMLInputElement>('node')
const netseg = byId<HTMLDivElement>('netseg')
const connectCard = byId<HTMLDivElement>('connect-card')
const connectBtn = byId<HTMLButtonElement>('connect')
const regenBtn = byId<HTMLButtonElement>('regen')
const copyBtn = byId<HTMLButtonElement>('copylink')
const disconnectBtn = byId<HTMLButtonElement>('disconnect')
const qrBox = byId<HTMLDivElement>('qr')
const qrCanvas = byId<HTMLCanvasElement>('qrcanvas')
const linkEl = byId<HTMLAnchorElement>('link')
const sessionCard = byId<HTMLDivElement>('session-card')
const acctList = byId<HTMLDivElement>('accounts')
const accountsLabel = byId<HTMLSpanElement>('accounts-label')
const recipientInput = byId<HTMLInputElement>('recipient')
const amountInput = byId<HTMLInputElement>('amount')
const sendTransferBtn = byId<HTMLButtonElement>('send-transfer')
const scContractInput = byId<HTMLInputElement>('sc-contract')
const scMethodInput = byId<HTMLInputElement>('sc-method')
const scArgsInput = byId<HTMLInputElement>('sc-args')
const signScBtn = byId<HTMLButtonElement>('sign-sc')
const msgInput = byId<HTMLInputElement>('msg')
const signMsgBtn = byId<HTMLButtonElement>('sign-msg')
const genApiBtn = byId<HTMLButtonElement>('gen-apikey')
const resultBox = byId<HTMLDivElement>('result')
const resultTitle = byId<HTMLSpanElement>('result-title')
const resultSub = byId<HTMLSpanElement>('result-sub')
const resultRows = byId<HTMLDivElement>('result-rows')
const resultLink = byId<HTMLAnchorElement>('result-link')
const statusEl = byId<HTMLDivElement>('status')
const logEl = byId<HTMLPreElement>('log')

const ORIGIN = window.location.origin
const REQUEST_TIMEOUT_MS = 120_000

const NODE_URLS: Record<string, string> = {
	mainnet: 'https://mainnet-rpc.ama.one/api',
	testnet: 'https://testnet-rpc.ama.one/api'
}
const EXPLORERS: Record<string, string> = {
	mainnet: 'https://explorer.ama.one',
	testnet: 'https://testnet.explorer.ama.one'
}

interface WalletAccount {
	address: string
	name: string
}

interface DemoState {
	session: EstablishedSession | null
	bridgeUrl: string
	currentNet: string
	stopConnectListener: (() => void) | null
	accounts: WalletAccount[]
	selectedAddress: string
	// AMA balance per account: undefined = still loading, null = failed.
	balances: Record<string, number | null>
	cancelPending: Set<() => void>
}

const state: DemoState = {
	session: null,
	bridgeUrl: '',
	currentNet: 'mainnet',
	stopConnectListener: null,
	accounts: [],
	selectedAddress: '',
	balances: {},
	cancelPending: new Set()
}

type Status = 'idle' | 'wait' | 'ok' | 'err'
function log(message: string, status: Status = 'idle') {
	logEl.textContent = message
	statusEl.dataset.state = status
}

const shortAddr = (address: string) =>
	address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address
const nodeUrl = () => nodeInput.value.trim() || NODE_URLS.mainnet
const actionButtons = () => [sendTransferBtn, signScBtn, signMsgBtn, genApiBtn]
const setBusy = (busy: boolean) => actionButtons().forEach((button) => (button.disabled = busy))
const genId = () =>
	typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `req-${Date.now()}`

const explorerTxUrl = (hash: string) => {
	const base = EXPLORERS[state.currentNet]
	return base ? `${base}/tx/${hash}` : null
}

/** Network selector: mainnet/testnet lock the node URL; custom lets you type one. */
function setNetwork(net: string) {
	state.currentNet = net
	for (const button of netseg.querySelectorAll<HTMLButtonElement>('.seg')) {
		button.classList.toggle('active', button.dataset.net === net)
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

function startConnectRequest(): { uri: string; pending: PendingConnect } | null {
	try {
		return createConnectRequest({ origin: ORIGIN, bridgeUrl: state.bridgeUrl })
	} catch (error) {
		log(`Cannot start: ${(error as Error).message}`, 'err')
		return null
	}
}

async function connect() {
	state.bridgeUrl = bridgeInput.value.trim() || 'https://bridge.ama.one'
	state.stopConnectListener?.()

	const request = startConnectRequest()
	if (!request) return
	const { uri, pending } = request

	await QRCode.toCanvas(qrCanvas, uri, { width: 240, margin: 1 })
	qrBox.style.display = 'flex'
	linkEl.href = uri
	linkEl.textContent = uri

	// Listen on the connect channel for the wallet's (public) connect response.
	const connectClient = new BridgeClient({
		bridgeUrl: state.bridgeUrl,
		clientId: deriveConnectChannel(pending.dappKeypair.publicKey),
		pollWaitSeconds: 20
	})
	state.stopConnectListener = connectClient.start(
		(frame) => {
			state.stopConnectListener?.()
			try {
				state.session = completeConnect(pending, frame.payload as ConnectResponseParams)
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
	const { session } = state
	if (!session) return
	qrBox.style.display = 'none'
	connectCard.style.display = 'none'
	sessionCard.style.display = 'flex'
	// Seed with the connected account so the UI works even if the wallet is an
	// older build without amadeus_getAccounts; loadAccounts() then enriches it.
	state.accounts = [{ address: session.address, name: 'Connected account' }]
	state.selectedAddress = session.address
	state.balances = {}
	renderAccounts()
	void loadBalances()
	void loadAccounts()
	setBusy(false)
	log(`Connected as ${shortAddr(session.address)}`, 'ok')
}

/** Format an AMA balance for the account list (undefined = loading, null = failed). */
function fmtBal(balance: number | null | undefined): string {
	if (balance === undefined) return '…'
	if (balance === null) return '—'
	return balance.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

/** Render every wallet account as a selectable row with its balance. */
function renderAccounts() {
	accountsLabel.textContent =
		state.accounts.length > 1 ? `Wallet accounts · ${state.accounts.length}` : 'Wallet account'
	acctList.replaceChildren()
	for (const acct of state.accounts) {
		const row = document.createElement('button')
		row.type = 'button'
		row.className = 'acct-row' + (acct.address === state.selectedAddress ? ' selected' : '')
		row.dataset.addr = acct.address

		const radio = document.createElement('span')
		radio.className = 'acct-radio'

		const info = document.createElement('span')
		info.className = 'acct-info'
		const name = document.createElement('span')
		name.className = 'acct-name'
		name.textContent = acct.name
		const addr = document.createElement('span')
		addr.className = 'acct-addr'
		addr.textContent = shortAddr(acct.address)
		info.append(name, addr)

		const bal = document.createElement('span')
		bal.className = 'acct-bal'
		bal.append(fmtBal(state.balances[acct.address]))
		const unit = document.createElement('span')
		unit.className = 'u'
		unit.textContent = ' AMA'
		bal.append(unit)

		row.append(radio, info, bal)
		acctList.append(row)
	}
}

/** Pick which account signs the next request; updates the transfer placeholder. */
function selectAccount(address: string) {
	state.selectedAddress = address
	recipientInput.placeholder = `Recipient address (blank = ${shortAddr(address)})`
	renderAccounts()
	const acct = state.accounts.find((account) => account.address === address)
	log(`Active account: ${acct?.name ?? shortAddr(address)}`, 'ok')
}

/** Ask the wallet for its full account list (auto-answered — no user approval). */
async function loadAccounts() {
	await sendRequest(
		'amadeus_getAccounts',
		{},
		(result) => {
			const list = (result as { accounts?: WalletAccount[] }).accounts
			if (!list?.length) return
			state.accounts = list
			if (!list.some((account) => account.address === state.selectedAddress)) {
				state.selectedAddress = list[0].address
			}
			renderAccounts()
			void loadBalances()
		},
		{ silent: true }
	)
}

/** Fetch each account's AMA balance from the selected node and refresh the list. */
async function loadBalances() {
	const targets = state.accounts.map((account) => account.address)
	await Promise.all(
		targets.map(async (address) => {
			try {
				const res = await fetch(`${nodeUrl()}/wallet/balance_all/${address}`)
				const json = (await res.json()) as { balances?: { symbol: string; float: number }[] }
				const ama = json.balances?.find((balance) => balance.symbol === 'AMA')
				state.balances[address] = ama ? ama.float : 0
			} catch {
				state.balances[address] = null
			}
		})
	)
	renderAccounts()
}

function disconnect() {
	state.stopConnectListener?.()
	state.stopConnectListener = null
	state.cancelPending.forEach((cancel) => cancel())
	setBusy(false)
	state.session = null
	state.accounts = []
	state.selectedAddress = ''
	state.balances = {}
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
	for (const [label, value] of opts.rows) {
		const row = document.createElement('div')
		row.className = 'rrow'
		const key = document.createElement('span')
		key.className = 'k'
		key.textContent = label
		const val = document.createElement('span')
		val.className = 'v'
		val.textContent = value
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
	onResult: (result: unknown) => void | Promise<void>,
	opts: { account?: string; silent?: boolean } = {}
) {
	if (!state.session) return
	const { sharedKey } = state.session
	// `silent` requests (e.g. getAccounts, auto-answered by the wallet) don't
	// prompt the user, so they neither disable the action buttons nor log "approve".
	if (!opts.silent) {
		setBusy(true)
		resultBox.style.display = 'none'
	}

	const channels = deriveBridgeChannels(sharedKey)
	const id = genId()
	const client = new BridgeClient({
		bridgeUrl: state.bridgeUrl,
		clientId: channels.toDapp,
		pollWaitSeconds: 20
	})
	const finish = () => {
		window.clearTimeout(timer)
		stop()
		state.cancelPending.delete(finish)
	}

	const stop = client.start(
		async (frame) => {
			finish()
			try {
				const response = openResponse(sharedKey, frame.payload as SealedEnvelope, id)
				if (!response.ok) {
					if (!opts.silent) log(`Rejected: ${response.error.code} — ${response.error.message}`, 'err')
					return
				}
				await onResult(response.result)
			} catch (error) {
				if (!opts.silent) log(`Failed: ${(error as Error).message}`, 'err')
			} finally {
				if (!opts.silent) setBusy(false)
			}
		},
		(error) => {
			if (!opts.silent) log(`Bridge error: ${String(error)}`, 'err')
		}
	)
	// Without this, a wallet that never answers leaves the buttons disabled for good.
	const timer = window.setTimeout(() => {
		finish()
		if (!opts.silent) {
			setBusy(false)
			log('No answer from the wallet after 2 minutes. Check the wallet and try again.', 'err')
		}
	}, REQUEST_TIMEOUT_MS)
	state.cancelPending.add(finish)

	try {
		const request = makeRequest({ id, method, origin: ORIGIN, params, account: opts.account })
		await client.send(channels.toWallet, id, sealRequest(sharedKey, request))
		if (!opts.silent) log('Request sent — approve it in the wallet…', 'wait')
	} catch (error) {
		finish()
		if (!opts.silent) {
			setBusy(false)
			log(`Send failed: ${(error as Error).message}`, 'err')
		}
	}
}

/** Submit the signed txPacked to the node (submit_and_wait) and return the hash. */
async function submitSigned(result: unknown): Promise<string> {
	const signed = result as { txHash: string; txPacked: number[] }
	log('Signed — submitting to the chain…', 'wait')
	const reply = await submitTransaction(signed.txPacked, { nodeUrl: nodeUrl(), wait: true })
	// The node answers 200 with { error: "<code>" } when it rejects a tx.
	const { error: code, receipt } = (reply ?? {}) as {
		error?: unknown
		receipt?: { success?: boolean; result?: unknown }
	}
	if (code !== 'ok') throw new Error(submitErrorMessage(String(code ?? reply)))
	if (receipt?.success === false) {
		throw new Error(
			`On-chain, but the call failed: ${submitErrorMessage(String(receipt.result))}`
		)
	}
	return signed.txHash
}

function sendTransfer() {
	if (!state.session) return
	const self = state.selectedAddress || state.session.address
	const recipient = recipientInput.value.trim() || self
	const amount = amountInput.value.trim() || '1'
	const atomic = toAtomicAmount(amount)
	if (!atomic) {
		log('Enter a valid amount.', 'err')
		return
	}
	const fromAcct = state.accounts.find((account) => account.address === self)
	void sendRequest(
		'amadeus_signTransaction',
		{ contract: 'Coin', method: 'transfer', args: [recipient, atomic, 'AMA'] },
		async (result) => {
			const hash = await submitSigned(result)
			showResult({
				title: 'Transfer confirmed',
				sub: recipient === self ? 'Sent to yourself (shows as Sent + Received)' : 'Sent',
				rows: [
					['From', fromAcct?.name ?? shortAddr(self)],
					['Amount', `${amount} AMA`],
					['To', recipient === self ? `${shortAddr(recipient)} (self)` : shortAddr(recipient)],
					['Tx hash', shortAddr(hash)]
				],
				explorerHash: hash
			})
			void loadBalances()
			log('Transfer confirmed on-chain.', 'ok')
		},
		{ account: self }
	)
}

function signContractCall() {
	if (!state.session) return
	const contract = scContractInput.value.trim()
	const method = scMethodInput.value.trim()
	if (!contract || !method) {
		log('Contract and method are required.', 'err')
		return
	}
	const args = parseArgs(scArgsInput.value)
	if (!args) {
		log('Args must be a JSON array, e.g. ["addr","1000000000","AMA"].', 'err')
		return
	}
	const { selectedAddress } = state
	const signer = state.accounts.find((account) => account.address === selectedAddress)
	void sendRequest(
		'amadeus_signTransaction',
		{ contract, method, args },
		async (result) => {
			const hash = await submitSigned(result)
			showResult({
				title: 'Contract call confirmed',
				rows: [
					['Signer', signer?.name ?? shortAddr(selectedAddress)],
					['Call', `${contract}.${method}`],
					['Tx hash', shortAddr(hash)]
				],
				explorerHash: hash
			})
			log('Contract call confirmed on-chain.', 'ok')
		},
		{ account: selectedAddress }
	)
}

function signMsg() {
	if (!state.session) return
	const message = msgInput.value.trim()
	if (!message) {
		log('Enter a message to sign.', 'err')
		return
	}
	const { selectedAddress } = state
	const signer = state.accounts.find((account) => account.address === selectedAddress)
	void sendRequest(
		'amadeus_signMessage',
		{ message },
		(result) => {
			const signed = result as { message: string; signature: string; address: string }
			// Prove the signature is real by verifying it right here in the dApp.
			const valid = verifyMessage({
				message: signed.message,
				signature: signed.signature,
				address: signed.address
			})
			showResult({
				title: 'Message signed',
				sub: valid
					? 'Signature verified in the dApp — no on-chain transaction'
					: 'Warning: signature did NOT verify',
				rows: [
					['Signer', signer?.name ?? shortAddr(signed.address)],
					['Message', signed.message],
					['Signature', signed.signature],
					['Verified', valid ? 'yes ✓' : 'no ✗']
				]
			})
			log(valid ? 'Message signed and verified.' : 'Signature failed to verify.', valid ? 'ok' : 'err')
		},
		{ account: selectedAddress }
	)
}

function requestApiKey() {
	if (!state.session) return
	const { selectedAddress } = state
	const signer = state.accounts.find((account) => account.address === selectedAddress)
	void sendRequest(
		'amadeus_generateApiKey',
		{ aud: ORIGIN, exp_in: 3600 },
		(result) => {
			showResult({
				title: 'API key issued',
				sub: 'Signed by the wallet — no on-chain transaction',
				rows: [
					['Signer', signer?.name ?? shortAddr(selectedAddress)],
					['API key', (result as { apiKey: string }).apiKey]
				]
			})
			log('API key issued by the wallet.', 'ok')
		},
		{ account: selectedAddress }
	)
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

netseg.addEventListener('click', (event) => {
	const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('.seg')
	if (btn?.dataset.net) setNetwork(btn.dataset.net)
})

disconnectBtn.addEventListener('click', disconnect)

acctList.addEventListener('click', (event) => {
	const row = (event.target as HTMLElement).closest<HTMLButtonElement>('.acct-row')
	if (row?.dataset.addr && row.dataset.addr !== state.selectedAddress)
		selectAccount(row.dataset.addr)
})

sendTransferBtn.addEventListener('click', sendTransfer)
signScBtn.addEventListener('click', signContractCall)
signMsgBtn.addEventListener('click', signMsg)
genApiBtn.addEventListener('click', requestApiKey)
