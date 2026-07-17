import type { AddressInfo } from 'node:net'

import { derivePublicKeyFromSeedBase58, generateKeypair } from '@amadeus-protocol/sdk'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createBridgeServer } from '../../bridge/server.mjs'
import { BridgeClient } from '../transport/bridge'
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
import { approveConnect, completeConnect, createConnectRequest } from '../transport/session'
import { parseConnectUri } from '../transport/uri'
import { handleRequest } from '../wallet/handler'

describe('bridge transport (cross-device full flow)', () => {
	let server: Server
	let baseUrl: string

	beforeAll(async () => {
		server = createBridgeServer()
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		const { port } = server.address() as AddressInfo
		baseUrl = `http://127.0.0.1:${port}`
	})

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()))
	})

	it('carries an encrypted signTransaction request + response between two clients', async () => {
		const { privateKey: seed } = generateKeypair()
		const address = derivePublicKeyFromSeedBase58(seed)

		// 1. Connect handshake (out-of-band via QR/deep link), carrying the bridge URL.
		const { uri, pending } = createConnectRequest({
			origin: 'https://hub.ama.one',
			bridgeUrl: baseUrl
		})
		const request = parseConnectUri(uri)
		expect(request.bridgeUrl).toBe(baseUrl)
		const walletSession = approveConnect(request, { seed, address })
		const session = completeConnect(pending, walletSession.response)
		expect(session.bridgeUrl).toBe(baseUrl)

		// 2. Both sides connect to the relay under their session-key client ids.
		const dappBridge = new BridgeClient({
			bridgeUrl: baseUrl,
			clientId: session.selfPublicKey,
			pollWaitSeconds: 2
		})
		const walletBridge = new BridgeClient({
			bridgeUrl: baseUrl,
			clientId: walletSession.walletKeypair.publicKey,
			pollWaitSeconds: 2
		})

		// 3. Wallet listens: decrypt -> guard (expiry/replay) -> sign -> reply.
		const seen = createMemorySeenStore()
		const stopWallet = walletBridge.start(async (frame) => {
			const req = openRequest(walletSession.sharedKey, frame.payload)
			guardRequest(req, seen)
			const response = handleRequest(req, { seed, address })
			await walletBridge.send(
				frame.from,
				req.id,
				sealResponse(walletSession.sharedKey, response)
			)
		})

		// 4. dApp listens for the reply.
		let stopDapp = () => {}
		const gotResponse = new Promise<WalletResponse>((resolve) => {
			stopDapp = dappBridge.start((frame) => {
				resolve(openResponse(session.sharedKey, frame.payload, 'tx-1'))
			})
		})

		// 5. dApp sends the sealed signTransaction request over the bridge.
		const req = makeRequest({
			id: 'tx-1',
			method: 'amadeus_signTransaction',
			origin: session.origin,
			params: { contract: 'Coin', method: 'transfer', args: [address, '1000000000', 'AMA'] }
		})
		await dappBridge.send(session.walletPublicKey, 'tx-1', sealRequest(session.sharedKey, req))

		const response = await gotResponse
		stopWallet()
		stopDapp()

		expect(response.ok).toBe(true)
		if (response.ok) {
			expect(typeof (response.result as { txHash: string }).txHash).toBe('string')
		}
	}, 15_000)
})
