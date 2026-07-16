/**
 * Connection-auth signatures. When a dApp asks the wallet to connect, it must
 * prove control of its address. The wallet signs a TRANSCRIPT that binds the
 * whole handshake — origin, both x25519 session public keys, the dApp's
 * challenge, and the request id — NOT just the raw challenge nonce.
 *
 * Signing only the nonce is a key-substitution MITM: an attacker replays a
 * harvested `sig(challenge)` under their own session keys and ends up with a
 * fully-authenticated session. Binding the session keys + origin into the signed
 * bytes closes that, the same property SIWE / CAIP-122 rely on.
 *
 * The transcript is length-prefixed and label-tagged so its bytes are
 * unambiguous, and signed under `CONNECT_DST` so a connect proof can never be
 * reused as a transaction, api-key, or any other signature.
 */

import { toBase58 } from '@amadeus-protocol/sdk'

import { CONNECT_DST, CONNECT_TRANSCRIPT_LABEL } from '../constants'
import { concatBytes, u32be, utf8ToBytes } from '../bytes'
import {
	deriveSigner,
	publicKeyFromAddress,
	signatureFromBase58,
	signHashed,
	verifyHashed
} from './bls'

export interface ConnectTranscript {
	/** The dApp's origin, e.g. "https://app.amadeus.xyz". */
	origin: string
	/** The dApp's ephemeral x25519 session public key (Base58). */
	dappPublicKey: string
	/** The wallet's ephemeral x25519 session public key (Base58). */
	walletPublicKey: string
	/** Random challenge nonce chosen by the dApp. */
	challenge: string
	/** Unique id for this connect request. */
	requestId: string
}

/**
 * Deterministic canonical bytes for a transcript. Identical inputs -> identical
 * bytes on both wallet and dApp (that's the whole point of a shared package).
 * Every element is length-prefixed (including the label) so field boundaries are
 * unambiguous — no concatenation/canonicalization ambiguity even if the label is
 * ever made dynamic. Layout: u32(labelLen) ++ label ++ u32(fieldCount) ++
 * for each field: u32(len) ++ utf8(field).
 */
export function buildConnectTranscript(transcript: ConnectTranscript): Uint8Array {
	const fields = [
		transcript.origin,
		transcript.dappPublicKey,
		transcript.walletPublicKey,
		transcript.challenge,
		transcript.requestId
	]
	const label = utf8ToBytes(CONNECT_TRANSCRIPT_LABEL)
	const parts: Uint8Array[] = [u32be(label.length), label, u32be(fields.length)]
	for (const field of fields) {
		const bytes = utf8ToBytes(field)
		parts.push(u32be(bytes.length), bytes)
	}
	return concatBytes(...parts)
}

export interface SignConnectParams {
	/** Base58 wallet seed (private key). */
	seed: string
	transcript: ConnectTranscript
}

/** Wallet side: sign the transcript, returning a Base58 signature. */
export function signConnect(params: SignConnectParams): string {
	const { sk } = deriveSigner(params.seed)
	const signature = signHashed(buildConnectTranscript(params.transcript), sk, CONNECT_DST)
	return toBase58(signature)
}

export interface VerifyConnectParams {
	/** The address (Base58 public key) that claims to have signed. */
	address: string
	transcript: ConnectTranscript
	/** The Base58 signature returned by the wallet. */
	signature: string
}

/**
 * dApp side: verify the wallet controls `address` for this exact transcript.
 * Never throws — returns false on any malformed input or verification failure.
 */
export function verifyConnect(params: VerifyConnectParams): boolean {
	let publicKey: Uint8Array
	let signature: Uint8Array
	try {
		publicKey = publicKeyFromAddress(params.address)
		signature = signatureFromBase58(params.signature)
	} catch {
		return false
	}
	return verifyHashed(
		signature,
		buildConnectTranscript(params.transcript),
		publicKey,
		CONNECT_DST
	)
}
