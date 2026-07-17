/**
 * Deep-link / QR URI construction and parsing for the connect handshake.
 *
 * The connect bootstrap params (dApp session pubkey, challenge, request id,
 * origin) are necessarily PLAINTEXT — there is no shared key yet, and they are
 * public handshake material. Everything AFTER connect is sealed (see envelope).
 *
 * Query parsing is hand-rolled with encode/decodeURIComponent so it is fully
 * portable across Node, browsers, and React Native/Hermes (no dependency on a
 * URL/URLSearchParams polyfill).
 */

import { PROTOCOL_VERSION } from '../constants'
import { WalletSdkError } from '../errors'

export const URI_SCHEME = 'amadeus'

export interface ConnectRequestParams {
	origin: string
	/** dApp ephemeral x25519 session public key (Base58). */
	dappPublicKey: string
	challenge: string
	requestId: string
	/** Unix-seconds expiry. */
	exp: number
	/** Same-device return target; omit for QR / bridge (cross-device). */
	redirectLink?: string
	/** Relay base URL for post-connect sealed messages (cross-device). */
	bridgeUrl?: string
}

export interface ConnectResponseParams {
	requestId: string
	address: string
	/** Wallet ephemeral x25519 session public key (Base58). */
	walletPublicKey: string
	/** Base58 connect-transcript signature. */
	signature: string
}

function buildQuery(entries: Record<string, string | undefined>): string {
	return Object.entries(entries)
		.filter(([, v]) => v !== undefined && v !== '')
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
		.join('&')
}

function parseQuery(query: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const pair of query.split('&')) {
		if (!pair) continue
		const eq = pair.indexOf('=')
		const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq))
		out[key] = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1))
	}
	return out
}

/** Split a URI into { scheme, path, query } without relying on the URL class. */
function splitUri(uri: string): { scheme: string; path: string; query: string } {
	const schemeSep = uri.indexOf('://')
	if (schemeSep < 0) throw new WalletSdkError('INVALID_ARGUMENT', 'not a valid URI')
	const scheme = uri.slice(0, schemeSep)
	const rest = uri.slice(schemeSep + 3)
	const q = rest.indexOf('?')
	return {
		scheme,
		path: q < 0 ? rest : rest.slice(0, q),
		query: q < 0 ? '' : rest.slice(q + 1)
	}
}

const CONNECT_PATH = `v${PROTOCOL_VERSION}/connect`

/** Build the `amadeus://vN/connect?...` URI a dApp shows as a link or QR. */
export function buildConnectUri(params: ConnectRequestParams): string {
	const query = buildQuery({
		origin: params.origin,
		dapp_key: params.dappPublicKey,
		challenge: params.challenge,
		id: params.requestId,
		exp: String(params.exp),
		redirect: params.redirectLink,
		bridge: params.bridgeUrl
	})
	return `${URI_SCHEME}://${CONNECT_PATH}?${query}`
}

/** Parse + validate a connect URI. Throws `INVALID_ARGUMENT` on anything off. */
export function parseConnectUri(uri: string): ConnectRequestParams {
	const { scheme, path, query } = splitUri(uri)
	if (scheme !== URI_SCHEME) {
		throw new WalletSdkError('INVALID_ARGUMENT', `unexpected scheme "${scheme}"`)
	}
	if (path !== CONNECT_PATH) {
		throw new WalletSdkError('INVALID_ARGUMENT', `unexpected path "${path}"`)
	}
	const q = parseQuery(query)
	const exp = Number(q.exp)
	if (!q.origin || !q.dapp_key || !q.challenge || !q.id || !Number.isInteger(exp)) {
		throw new WalletSdkError('INVALID_ARGUMENT', 'connect URI is missing required fields')
	}
	return {
		origin: q.origin,
		dappPublicKey: q.dapp_key,
		challenge: q.challenge,
		requestId: q.id,
		exp,
		redirectLink: q.redirect || undefined,
		bridgeUrl: q.bridge || undefined
	}
}

/**
 * Build the same-device callback URI the wallet opens to return the connect
 * response to the dApp. `data` fields are plaintext connect material (the shared
 * key is derived from them); post-connect requests use sealed envelopes instead.
 */
export function buildConnectResponseUri(
	redirectLink: string,
	response: ConnectResponseParams
): string {
	const sep = redirectLink.includes('?') ? '&' : '?'
	const query = buildQuery({
		id: response.requestId,
		address: response.address,
		wallet_key: response.walletPublicKey,
		sig: response.signature
	})
	return `${redirectLink}${sep}${query}`
}

/** Parse a connect response from a callback URL's query string. */
export function parseConnectResponseUri(uri: string): ConnectResponseParams {
	const q = parseQuery(uri.includes('?') ? uri.slice(uri.indexOf('?') + 1) : uri)
	if (!q.id || !q.address || !q.wallet_key || !q.sig) {
		throw new WalletSdkError('INVALID_ARGUMENT', 'connect response is missing required fields')
	}
	return {
		requestId: q.id,
		address: q.address,
		walletPublicKey: q.wallet_key,
		signature: q.sig
	}
}
