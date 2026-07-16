/**
 * End-to-end demo: a dApp and the wallet talking through @amadeus-protocol/wallet-sdk.
 * Runs the exact functions the mobile app and a dApp call — connect handshake,
 * shared-key derivation, then an encrypted signTransaction round-trip.
 *
 *   bun run examples/e2e-demo.mjs   (from the package dir)
 */

import {
	approveConnect,
	completeConnect,
	createConnectRequest,
	createMemorySeenStore,
	guardRequest,
	handleRequest,
	makeRequest,
	openRequest,
	openResponse,
	parseConnectUri,
	sealRequest,
	sealResponse
} from '../dist/index.js'
import { derivePublicKeyFromSeedBase58, generateKeypair, toBase58 } from '@amadeus-protocol/sdk'

// The wallet holds an account (seed lives in the encrypted vault on the phone).
const { privateKey: seed } = generateKeypair()
const address = derivePublicKeyFromSeedBase58(seed)
console.log('WALLET account:', address, '\n')

// 1. dApp creates a connect request and shows it as a link / QR.
const { uri, pending } = createConnectRequest({
	origin: 'https://hub.ama.one',
	redirectLink: 'https://hub.ama.one/cb'
})
console.log('1. dApp link/QR:', uri.slice(0, 96) + '…\n')

// 2. Wallet parses it, the user approves, and it signs the connect transcript.
const request = parseConnectUri(uri)
const walletSession = approveConnect(request, { seed, address })
console.log('2. wallet approved — signed the transcript, returned its session key + address\n')

// 3. dApp verifies the proof and establishes the encrypted session.
const session = completeConnect(pending, walletSession.response)
console.log('3. dApp verified -> connected as', session.address)
console.log(
	'   shared key matches on both sides:',
	toBase58(session.sharedKey) === toBase58(walletSession.sharedKey),
	'\n'
)

// 4. dApp sends a SEALED signTransaction request.
const seen = createMemorySeenStore()
const req = makeRequest({
	id: 'demo-1',
	method: 'amadeus_signTransaction',
	origin: session.origin,
	params: { contract: 'Coin', method: 'transfer', args: [address, '1000000000', 'AMA'] }
})
const sealed = sealRequest(session.sharedKey, req)
console.log('4. dApp -> wallet (encrypted):', JSON.stringify(sealed).slice(0, 68) + '…\n')

// 5. Wallet opens it, enforces expiry+replay, and signs the tx.
const opened = openRequest(walletSession.sharedKey, sealed)
guardRequest(opened, seen)
const response = handleRequest(opened, { seed, address })
const responseEnvelope = sealResponse(walletSession.sharedKey, response)
console.log('5. wallet signed the tx and replied (encrypted)\n')

// 6. dApp opens the reply.
const final = openResponse(session.sharedKey, responseEnvelope, 'demo-1')
console.log(
	'6. dApp receives:',
	final.ok ? 'OK  txHash=' + final.result.txHash : 'ERROR ' + JSON.stringify(final.error),
	'\n'
)

// Replay of the same request id is rejected.
try {
	guardRequest(opened, seen)
	console.log('replay: NOT rejected (bug!)')
} catch (e) {
	console.log('replay of the same request id is rejected:', e.code)
}

console.log('\n✅ End-to-end connect + encrypted sign round-trip works.')
