/**
 * The encrypted request/response envelope that flows over ANY transport (deep
 * link, QR, or the cross-device bridge). Post-connect, both sides hold the x25519
 * shared key, so every request and response is sealed — even same-device deep
 * links carry ciphertext, so a hijacked scheme yields an unusable blob.
 *
 * Methods mirror the wallet extension's provider vocabulary so a dApp integrates
 * once against the same names on every transport.
 */

import { z } from 'zod'

import { PROTOCOL_VERSION } from '../constants'
import { bytesToUtf8, utf8ToBytes } from '../bytes'
import { open, seal, type SealedEnvelope } from '../crypto/box'
import { WalletSdkError } from '../errors'

export const WALLET_METHODS = [
	'amadeus_signTransaction',
	'amadeus_signMessage',
	'amadeus_getAccounts',
	'amadeus_generateApiKey',
	'amadeus_switchNetwork'
] as const

export type WalletMethod = (typeof WALLET_METHODS)[number]

export interface WalletRequest {
	/** Protocol version. */
	v: number
	/** Unique, one-time request id (replay key). */
	id: string
	method: WalletMethod
	/** The dApp origin, echoed for display in the approval UI. */
	origin: string
	params: unknown
	/** Unix-seconds expiry. */
	exp: number
}

export type WalletResponse =
	| { v: number; id: string; ok: true; result: unknown }
	| { v: number; id: string; ok: false; error: { code: string; message: string } }

const walletRequestSchema = z.object({
	v: z.number().int(),
	id: z.string().min(1).max(128),
	method: z.enum(WALLET_METHODS),
	origin: z.string().min(1),
	params: z.unknown(),
	exp: z.number().int()
})

const walletResponseSchema = z.union([
	z.object({
		v: z.number().int(),
		id: z.string().min(1).max(128),
		ok: z.literal(true),
		result: z.unknown()
	}),
	z.object({
		v: z.number().int(),
		id: z.string().min(1).max(128),
		ok: z.literal(false),
		error: z.object({ code: z.string(), message: z.string() })
	})
])

/** Build an unsealed request with the current protocol version and a TTL. */
export function makeRequest(params: {
	id: string
	method: WalletMethod
	origin: string
	params: unknown
	ttlSeconds?: number
	now?: number
}): WalletRequest {
	const nowSec = Math.floor((params.now ?? Date.now()) / 1000)
	return {
		v: PROTOCOL_VERSION,
		id: params.id,
		method: params.method,
		origin: params.origin,
		params: params.params,
		exp: nowSec + (params.ttlSeconds ?? 120)
	}
}

export function sealRequest(sharedKey: Uint8Array, request: WalletRequest): SealedEnvelope {
	return seal(sharedKey, utf8ToBytes(JSON.stringify(request)))
}

/**
 * Decrypt + structurally validate an inbound request. Throws `DECRYPT_FAILED` if
 * the envelope is not authentic, `INVALID_ARGUMENT` if the plaintext is not a
 * well-formed request. Does NOT check expiry/replay — call `guardRequest` for
 * that policy step (kept separate so the crypto and the policy are distinct).
 */
export function openRequest(sharedKey: Uint8Array, envelope: SealedEnvelope): WalletRequest {
	const bytes = open(sharedKey, envelope)
	let parsed: unknown
	try {
		parsed = JSON.parse(bytesToUtf8(bytes))
	} catch {
		throw new WalletSdkError('INVALID_ARGUMENT', 'request is not valid JSON')
	}
	const result = walletRequestSchema.safeParse(parsed)
	if (!result.success) {
		throw new WalletSdkError('INVALID_ARGUMENT', 'request failed schema validation')
	}
	return result.data as WalletRequest
}

export function sealResponse(sharedKey: Uint8Array, response: WalletResponse): SealedEnvelope {
	return seal(sharedKey, utf8ToBytes(JSON.stringify(response)))
}

/**
 * Decrypt + validate an inbound response, optionally asserting it answers
 * `expectedId` (defends against a swapped/mismatched reply).
 */
export function openResponse(
	sharedKey: Uint8Array,
	envelope: SealedEnvelope,
	expectedId?: string
): WalletResponse {
	const bytes = open(sharedKey, envelope)
	let parsed: unknown
	try {
		parsed = JSON.parse(bytesToUtf8(bytes))
	} catch {
		throw new WalletSdkError('INVALID_ARGUMENT', 'response is not valid JSON')
	}
	const result = walletResponseSchema.safeParse(parsed)
	if (!result.success) {
		throw new WalletSdkError('INVALID_ARGUMENT', 'response failed schema validation')
	}
	const response = result.data as WalletResponse
	if (expectedId !== undefined && response.id !== expectedId) {
		throw new WalletSdkError('INVALID_ARGUMENT', 'response id does not match the request')
	}
	return response
}

/**
 * A one-time-id store for replay defense. The in-memory default is fine for a
 * single process; the mobile wallet should supply a PERSISTED implementation
 * (e.g. expo-secure-store) so a crash/relaunch inside the TTL window can't let a
 * captured approval replay. `has`+`add` must be atomic in the persisted impl.
 */
export interface SeenStore {
	has(id: string): boolean
	add(id: string): void
}

export function createMemorySeenStore(maxEntries = 10_000): SeenStore {
	const ids = new Set<string>()
	return {
		has: (id) => ids.has(id),
		add: (id) => {
			if (ids.size >= maxEntries) ids.delete(ids.values().next().value as string)
			ids.add(id)
		}
	}
}

/**
 * Policy gate: enforce expiry + one-time id BEFORE acting on a request (i.e.
 * before building/signing anything). Atomic check-and-add against `store`.
 * Throws `EXPIRED` or `INVALID_ARGUMENT` (duplicate).
 */
export function guardRequest(request: WalletRequest, store: SeenStore, now?: number): void {
	const nowSec = Math.floor((now ?? Date.now()) / 1000)
	if (request.exp <= nowSec) {
		throw new WalletSdkError('EXPIRED', 'request has expired')
	}
	if (store.has(request.id)) {
		throw new WalletSdkError('INVALID_ARGUMENT', 'duplicate request id (replay)')
	}
	store.add(request.id)
}
