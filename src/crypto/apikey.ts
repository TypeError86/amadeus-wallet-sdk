/**
 * BLS12-381 API-key bearer tokens — the ONE audited implementation, replacing
 * the byte-identical copies currently hand-rolled in the wallet extension
 * (`background/handlers/api-key.ts`) and hub/prime-hub (`utils/blsWallet.ts`).
 *
 * Token layout (concatenated, then Base58-encoded):
 *   [ jsonBytes (variable) | pubkey (48) | signature (96) ]
 *
 *   jsonBytes = utf8(JSON.stringify({ aud, exp }))   // key order: aud THEN exp
 *   exp       = floor(now/1000) + expIn              // unix seconds
 *   signature = BLS.sign(sha256(jsonBytes || pubkey), sk, { DST: API_KEY_DST })
 *
 * Folding the pubkey into the signed hash blocks rogue-key attacks. `kbs.ama.one`
 * verifies against exactly this construction — do not alter the field order,
 * concatenation, or DST.
 */

import { fromBase58, toBase58 } from '@amadeus-protocol/sdk'

import {
	API_KEY_DST,
	MAX_API_KEY_STRING_LENGTH,
	PUBLIC_KEY_BYTE_LENGTH,
	SIGNATURE_BYTE_LENGTH
} from '../constants'
import { WalletSdkError } from '../errors'
import { bytesToUtf8, concatBytes, utf8ToBytes } from '../bytes'
import { deriveSigner, signHashed, verifyHashed } from './bls'

export interface ApiKeyPayload {
	aud: string
	exp: number
}

export interface GenerateApiKeyParams {
	/** Base58 wallet seed (private key). */
	seed: string
	/** Audience claim the bearer will present to. */
	aud: string
	/** Lifetime in seconds from now. */
	expIn: number
	/** Override "now" (ms since epoch) — for deterministic tests. */
	now?: number
}

export interface GenerateApiKeyResult {
	apiKey: string
	payload: ApiKeyPayload
}

export function generateApiKey(params: GenerateApiKeyParams): GenerateApiKeyResult {
	if (!params.aud || params.aud.length === 0) {
		throw new WalletSdkError('INVALID_ARGUMENT', 'aud is required')
	}
	if (!Number.isInteger(params.expIn) || params.expIn <= 0) {
		throw new WalletSdkError('INVALID_ARGUMENT', 'expIn must be a positive integer (seconds)')
	}

	const { sk, pk } = deriveSigner(params.seed)
	const nowMs = params.now ?? Date.now()
	const exp = Math.floor(nowMs / 1000) + params.expIn

	// IMPORTANT: object literal order (aud, then exp) fixes the JSON byte layout.
	const jsonBytes = utf8ToBytes(JSON.stringify({ aud: params.aud, exp }))
	const signed = concatBytes(jsonBytes, pk)
	const signature = signHashed(signed, sk, API_KEY_DST)
	const token = concatBytes(jsonBytes, pk, signature)

	return { apiKey: toBase58(token), payload: { aud: params.aud, exp } }
}

export interface DecodedApiKey {
	payload: ApiKeyPayload
	publicKey: Uint8Array
	signature: Uint8Array
	/** The raw JSON bytes that were signed — needed to re-verify exactly. */
	jsonBytes: Uint8Array
	/** The signing address (Base58 of `publicKey`). */
	address: string
}

/** Parse a token into its parts. Throws `WalletSdkError('INVALID_API_KEY')` on malformed input. */
export function decodeApiKey(apiKey: string): DecodedApiKey {
	// Bound untrusted input BEFORE the quadratic Base58 decode so an oversized
	// string can't stall the verifier (event-loop DoS).
	if (
		typeof apiKey !== 'string' ||
		apiKey.length === 0 ||
		apiKey.length > MAX_API_KEY_STRING_LENGTH
	) {
		throw new WalletSdkError('INVALID_API_KEY', 'api key length is out of range')
	}

	let raw: Uint8Array
	try {
		raw = fromBase58(apiKey)
	} catch {
		throw new WalletSdkError('INVALID_API_KEY', 'api key is not valid Base58')
	}

	const jsonEnd = raw.length - PUBLIC_KEY_BYTE_LENGTH - SIGNATURE_BYTE_LENGTH
	if (jsonEnd <= 0) {
		throw new WalletSdkError('INVALID_API_KEY', 'api key is too short to contain a payload')
	}

	const jsonBytes = raw.slice(0, jsonEnd)
	const publicKey = raw.slice(jsonEnd, jsonEnd + PUBLIC_KEY_BYTE_LENGTH)
	const signature = raw.slice(jsonEnd + PUBLIC_KEY_BYTE_LENGTH)

	let parsed: unknown
	try {
		parsed = JSON.parse(bytesToUtf8(jsonBytes))
	} catch {
		throw new WalletSdkError('INVALID_API_KEY', 'api key payload is not valid JSON')
	}

	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		typeof (parsed as ApiKeyPayload).aud !== 'string' ||
		typeof (parsed as ApiKeyPayload).exp !== 'number' ||
		!Number.isFinite((parsed as ApiKeyPayload).exp)
	) {
		throw new WalletSdkError(
			'INVALID_API_KEY',
			'api key payload must be { aud: string, exp: number }'
		)
	}

	const payload = parsed as ApiKeyPayload
	return { payload, publicKey, signature, jsonBytes, address: toBase58(publicKey) }
}

export interface VerifyApiKeyOptions {
	/** If provided, the token's `aud` must equal this. */
	aud?: string
	/** Override "now" (ms since epoch) — for deterministic tests. */
	now?: number
	/** Treat the token as expired this many seconds early (clock-skew guard). Default 0. */
	leewaySeconds?: number
}

export type VerifyApiKeyResult =
	| { valid: true; payload: ApiKeyPayload; address: string }
	| { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'aud_mismatch' }

/**
 * Full verification: structure -> BLS signature (under the API-key DST, with the
 * pubkey folded in) -> expiry -> optional audience. Returns a discriminated
 * result rather than throwing on the common "invalid" paths.
 */
export function verifyApiKey(
	apiKey: string,
	options: VerifyApiKeyOptions = {}
): VerifyApiKeyResult {
	let decoded: DecodedApiKey
	try {
		decoded = decodeApiKey(apiKey)
	} catch {
		return { valid: false, reason: 'malformed' }
	}

	const signed = concatBytes(decoded.jsonBytes, decoded.publicKey)
	if (!verifyHashed(decoded.signature, signed, decoded.publicKey, API_KEY_DST)) {
		return { valid: false, reason: 'bad_signature' }
	}

	const nowSec = Math.floor((options.now ?? Date.now()) / 1000)
	const leeway = options.leewaySeconds ?? 0
	if (decoded.payload.exp <= nowSec + leeway) {
		return { valid: false, reason: 'expired' }
	}

	if (options.aud !== undefined && decoded.payload.aud !== options.aud) {
		return { valid: false, reason: 'aud_mismatch' }
	}

	return { valid: true, payload: decoded.payload, address: decoded.address }
}
