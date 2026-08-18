/**
 * Arbitrary-message signing ("personal sign") — the wallet proves control of an
 * account over a human-readable string (a login challenge, a terms acceptance, a
 * nonce). Unlike a transaction it never touches the chain; unlike an API key it
 * carries no audience/expiry — it is just a signature the dApp (or its backend)
 * can verify with `verifyMessage`.
 *
 * Recipe: signature = BLS.sign(sha256(utf8(message)), sk, { DST: MESSAGE_DST }).
 * The dedicated `MESSAGE_DST` is what makes this safe to expose: BLS mixes the
 * DST into the curve point, so a message signature can never be replayed as a
 * transaction or API-key signature (and vice-versa). No pubkey is folded in — a
 * single signature is already bound to its signer through verification against a
 * known address, so there is no rogue-key surface here.
 */

import { toBase58 } from '@amadeus-protocol/sdk'

import { MAX_MESSAGE_LENGTH, MESSAGE_DST } from '../constants'
import { WalletSdkError } from '../errors'
import { utf8ToBytes } from '../bytes'
import { deriveSigner, publicKeyFromAddress, signatureFromBase58, signHashed, verifyHashed } from './bls'

export interface SignMessageParams {
	/** Base58 wallet seed (private key). */
	seed: string
	/** The UTF-8 message to sign. */
	message: string
}

export interface SignMessageResult {
	/** The message that was signed, echoed back for display/verification. */
	message: string
	/** Base58 BLS signature (96 bytes). */
	signature: string
	/** The signing address (Base58 public key). */
	address: string
}

/** Assert a message is a non-empty string within the length bound. */
function assertMessage(message: string): void {
	if (typeof message !== 'string' || message.length === 0) {
		throw new WalletSdkError('INVALID_ARGUMENT', 'message is required')
	}
	if (message.length > MAX_MESSAGE_LENGTH) {
		throw new WalletSdkError(
			'INVALID_ARGUMENT',
			`message exceeds ${MAX_MESSAGE_LENGTH} characters`
		)
	}
}

/** Sign a UTF-8 message under `MESSAGE_DST`. */
export function signMessage(params: SignMessageParams): SignMessageResult {
	assertMessage(params.message)
	const { sk, pk } = deriveSigner(params.seed)
	const signature = signHashed(utf8ToBytes(params.message), sk, MESSAGE_DST)
	return { message: params.message, signature: toBase58(signature), address: toBase58(pk) }
}

export interface VerifyMessageParams {
	/** The UTF-8 message that was signed. */
	message: string
	/** Base58 BLS signature returned by `signMessage`. */
	signature: string
	/** The Base58 address (public key) that should have signed it. */
	address: string
}

/**
 * Verify a message signature against a claimed address. Never throws — malformed
 * input (bad Base58, wrong length, over-long message) returns `false`.
 */
export function verifyMessage(params: VerifyMessageParams): boolean {
	try {
		assertMessage(params.message)
		const publicKey = publicKeyFromAddress(params.address)
		const signature = signatureFromBase58(params.signature)
		return verifyHashed(signature, utf8ToBytes(params.message), publicKey, MESSAGE_DST)
	} catch {
		return false
	}
}
