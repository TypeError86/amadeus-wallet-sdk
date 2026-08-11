/**
 * The connect handshake, orchestrated for both sides. This is where the crypto
 * primitives (connect transcript signing + x25519 box) and the URI transport
 * come together into an actual dApp <-> wallet session.
 *
 * Flow:
 *   dApp:   createConnectRequest()  -> show `uri` (link/QR), keep `pending`
 *   wallet: parseConnectUri(uri) -> [approve in UI] -> approveConnect()
 *                                -> return `response` to the dApp
 *   dApp:   completeConnect(pending, response) -> EstablishedSession
 *
 * After that both sides hold the same `sharedKey` and exchange sealed envelopes
 * (see envelope.ts). The wallet signs the transcript binding origin + BOTH
 * session keys + challenge + requestId, so a captured proof can't be replayed
 * under substituted keys.
 */

import { toBase58 } from '@amadeus-protocol/sdk'

import { DEFAULT_BRIDGE_URL } from '../constants'
import { randomBytes, randomId } from '../bytes'
import { signConnect, verifyConnect, type ConnectTranscript } from '../crypto/connect'
import { deriveSharedKey, generateSessionKeypair, type SessionKeypair } from '../crypto/box'
import { WalletSdkError } from '../errors'
import { buildConnectUri, type ConnectRequestParams, type ConnectResponseParams } from './uri'

// ── dApp side ───────────────────────────────────────────────────────────────

/** State the dApp keeps locally between issuing a connect request and completing it. */
export interface PendingConnect {
	requestId: string
	challenge: string
	origin: string
	/** The dApp's ephemeral session keypair (secret stays local). */
	dappKeypair: SessionKeypair
	exp: number
	bridgeUrl?: string
}

export interface EstablishedSession {
	/** The connected wallet address (Base58 public key). */
	address: string
	/** 32-byte symmetric key for sealing/opening envelopes. Keep in memory only. */
	sharedKey: Uint8Array
	/** The wallet's session key — the peer's bridge client id to send frames to. */
	walletPublicKey: string
	/** This dApp's session key — its own bridge client id to listen on. */
	selfPublicKey: string
	origin: string
	/** Relay base URL for post-connect sealed messages, if provided. */
	bridgeUrl?: string
}

/** dApp: create a connect request. Returns the URI to display and the pending state to keep. */
export function createConnectRequest(options: {
	origin: string
	redirectLink?: string
	bridgeUrl?: string
	ttlSeconds?: number
	now?: number
}): { uri: string; pending: PendingConnect } {
	const dappKeypair = generateSessionKeypair()
	const challenge = toBase58(randomBytes(16))
	const requestId = randomId()
	const nowSec = Math.floor((options.now ?? Date.now()) / 1000)
	const exp = nowSec + (options.ttlSeconds ?? 120)
	// Fall back to the production relay when the dApp doesn't pin its own.
	const bridgeUrl = options.bridgeUrl ?? DEFAULT_BRIDGE_URL

	const params: ConnectRequestParams = {
		origin: options.origin,
		dappPublicKey: dappKeypair.publicKey,
		challenge,
		requestId,
		exp,
		redirectLink: options.redirectLink,
		bridgeUrl
	}
	return {
		uri: buildConnectUri(params),
		pending: {
			requestId,
			challenge,
			origin: options.origin,
			dappKeypair,
			exp,
			bridgeUrl
		}
	}
}

/**
 * dApp: verify the wallet's connect response and establish the session. Throws
 * `INVALID_ARGUMENT` if the response is for a different request, or
 * `BAD_SIGNATURE` if the connect proof does not verify against the transcript.
 */
export function completeConnect(
	pending: PendingConnect,
	response: ConnectResponseParams
): EstablishedSession {
	if (response.requestId !== pending.requestId) {
		throw new WalletSdkError('INVALID_ARGUMENT', 'response does not match the pending request')
	}
	const transcript: ConnectTranscript = {
		origin: pending.origin,
		dappPublicKey: pending.dappKeypair.publicKey,
		walletPublicKey: response.walletPublicKey,
		challenge: pending.challenge,
		requestId: pending.requestId
	}
	if (!verifyConnect({ address: response.address, transcript, signature: response.signature })) {
		throw new WalletSdkError('BAD_SIGNATURE', 'connect proof failed verification')
	}
	// deriveSharedKey validates the wallet's session key (fails closed on a bad point).
	const sharedKey = deriveSharedKey(response.walletPublicKey, pending.dappKeypair.secretKey)
	return {
		address: response.address,
		sharedKey,
		walletPublicKey: response.walletPublicKey,
		selfPublicKey: pending.dappKeypair.publicKey,
		origin: pending.origin,
		bridgeUrl: pending.bridgeUrl
	}
}

// ── wallet side ───────────────────────────────────────────────────────────────

export interface WalletSession {
	/** The response to hand back to the dApp (via callback URI or bridge frame). */
	response: ConnectResponseParams
	/** 32-byte symmetric key for sealing/opening envelopes. Keep in memory only. */
	sharedKey: Uint8Array
	/** The wallet's ephemeral session keypair for this dApp (its own bridge client id). */
	walletKeypair: SessionKeypair
	/** The dApp's session key — the peer's bridge client id to send frames to. */
	peerPublicKey: string
	/** Relay base URL for post-connect sealed messages, if the dApp supplied one. */
	bridgeUrl?: string
}

/**
 * Wallet: approve a connect request and produce the signed response + session.
 * Call this ONLY AFTER the user has approved in the UI and the request's expiry
 * has been checked. `address` is the account that will be bound to this session
 * (bind to a specific account, not the live "active" one).
 */
export function approveConnect(
	request: ConnectRequestParams,
	options: { seed: string; address: string }
): WalletSession {
	const walletKeypair = generateSessionKeypair()
	const transcript: ConnectTranscript = {
		origin: request.origin,
		dappPublicKey: request.dappPublicKey,
		walletPublicKey: walletKeypair.publicKey,
		challenge: request.challenge,
		requestId: request.requestId
	}
	const signature = signConnect({ seed: options.seed, transcript })
	// deriveSharedKey validates the dApp's session key (fails closed on a bad point).
	const sharedKey = deriveSharedKey(request.dappPublicKey, walletKeypair.secretKey)

	return {
		response: {
			requestId: request.requestId,
			address: options.address,
			walletPublicKey: walletKeypair.publicKey,
			signature
		},
		sharedKey,
		walletKeypair,
		peerPublicKey: request.dappPublicKey,
		bridgeUrl: request.bridgeUrl
	}
}

/** Whether a parsed connect request has expired (wallet should reject/re-park). */
export function isConnectRequestExpired(request: ConnectRequestParams, now?: number): boolean {
	return request.exp <= Math.floor((now ?? Date.now()) / 1000)
}
