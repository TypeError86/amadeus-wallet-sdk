/**
 * Wallet-side request dispatch. Once the mobile app has opened + guarded an
 * inbound request and the user has approved it, this turns the request into a
 * signed response by routing to the right primitive. Keeping it here means the
 * app's approval screen only has to call one function; the wallet and extension
 * share identical request semantics.
 *
 * IMPORTANT: call this only AFTER `guardRequest` (expiry + replay) has passed and
 * the user has approved. It signs with the bound account's seed.
 */

import { PROTOCOL_VERSION } from '../constants'
import { generateApiKey } from '../crypto/apikey'
import { WalletSdkError } from '../errors'
import { generateApiKeyRequestSchema, signTransactionRequestSchema } from '../schema'
import { signTransaction } from '../tx'
import type { WalletRequest, WalletResponse } from '../transport/envelope'

export interface WalletHandlerContext {
	/** Seed (private key) of the account bound to this session. */
	seed: string
	/** Address (Base58 public key) of the bound account. */
	address: string
}

function ok(id: string, result: unknown): WalletResponse {
	return { v: PROTOCOL_VERSION, id, ok: true, result }
}

function fail(id: string, error: unknown): WalletResponse {
	const code = error instanceof WalletSdkError ? error.code : 'INTERNAL'
	const message = error instanceof Error ? error.message : 'unexpected error'
	return { v: PROTOCOL_VERSION, id, ok: false, error: { code, message } }
}

/**
 * Service one approved request and return a response ready to seal. Never throws
 * — failures come back as `{ ok: false, error }` so the transport can always
 * reply. `amadeus_switchNetwork` is deliberately delegated to the app (it mutates
 * wallet runtime state), signalled with a distinct error the caller can branch on.
 */
export function handleRequest(request: WalletRequest, ctx: WalletHandlerContext): WalletResponse {
	try {
		switch (request.method) {
			case 'amadeus_signTransaction': {
				const parsed = signTransactionRequestSchema.safeParse(request.params)
				if (!parsed.success) {
					throw new WalletSdkError('INVALID_ARGUMENT', 'invalid signTransaction params')
				}
				const signed = signTransaction({
					seed: ctx.seed,
					contract: parsed.data.contract,
					method: parsed.data.method,
					args: parsed.data.args,
					description: parsed.data.description
				})
				return ok(request.id, signed)
			}
			case 'amadeus_generateApiKey': {
				const parsed = generateApiKeyRequestSchema.safeParse(request.params)
				if (!parsed.success) {
					throw new WalletSdkError('INVALID_ARGUMENT', 'invalid generateApiKey params')
				}
				const { apiKey } = generateApiKey({
					seed: ctx.seed,
					aud: parsed.data.aud,
					expIn: parsed.data.exp_in
				})
				return ok(request.id, { apiKey })
			}
			case 'amadeus_getAccounts':
				return ok(request.id, { accounts: [ctx.address] })
			case 'amadeus_signMessage':
				// Structured, non-oracle message signing is not exposed in v0.1.
				throw new WalletSdkError(
					'INVALID_ARGUMENT',
					'amadeus_signMessage is not supported yet'
				)
			case 'amadeus_switchNetwork':
				throw new WalletSdkError(
					'INVALID_ARGUMENT',
					'amadeus_switchNetwork must be handled by the wallet app (it changes runtime state)'
				)
			default:
				throw new WalletSdkError('INVALID_ARGUMENT', `unknown method`)
		}
	} catch (error) {
		return fail(request.id, error)
	}
}
