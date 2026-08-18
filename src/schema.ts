/**
 * Runtime validation for untrusted wire input (deep links, QR payloads, bridge
 * frames, cross-origin messages). Validate BEFORE any request is shown for
 * approval or signed. Zod is used here because it is already the schema library
 * on the wallet + dApp side; the lower-level SDK uses `effect` internally, which
 * is intentionally not a dependency of this package.
 */

import { fromBase58 } from '@amadeus-protocol/sdk'
import { z } from 'zod'

import {
	MAX_MESSAGE_LENGTH,
	NETWORKS,
	PUBLIC_KEY_BYTE_LENGTH,
	SESSION_PUBLIC_KEY_BYTE_LENGTH
} from './constants'

/** A Base58 string that decodes to exactly `length` bytes. */
function base58OfLength(length: number, label: string) {
	return z.string().refine(
		(v) => {
			try {
				return fromBase58(v).length === length
			} catch {
				return false
			}
		},
		{ message: `${label} must decode to ${length} bytes` }
	)
}

/** http(s) origin, matching the extension's `originSchema`. */
export const originSchema = z
	.string()
	.refine((v) => /^https?:\/\//.test(v), { message: 'origin must be an http(s) URL' })

/** A Base58 string that decodes to a 48-byte Amadeus public key / address. */
export const addressSchema = base58OfLength(PUBLIC_KEY_BYTE_LENGTH, 'address')

/** A Base58 string that decodes to a 32-byte x25519 session public key. */
export const sessionPublicKeySchema = base58OfLength(
	SESSION_PUBLIC_KEY_BYTE_LENGTH,
	'session public key'
)

export const networkSchema = z.enum(NETWORKS)

/** `signTransaction` params — mirrors `ExternalSignRequestMessageSchema`. */
export const signTransactionRequestSchema = z.object({
	contract: z.string().min(1),
	method: z.string().min(1),
	args: z.array(z.unknown()),
	description: z.string().optional()
})

/** `generateApiKey` params — mirrors `ExternalApiKeyRequestMessageSchema`. */
export const generateApiKeyRequestSchema = z.object({
	aud: z.string().min(1),
	exp_in: z.number().int().positive()
})

/** `signMessage` params — an arbitrary UTF-8 message, bounded for safety. */
export const signMessageRequestSchema = z.object({
	message: z.string().min(1).max(MAX_MESSAGE_LENGTH)
})

/** The connect transcript fields carried by a deep link / QR payload. */
export const connectTranscriptSchema = z.object({
	origin: originSchema,
	dappPublicKey: sessionPublicKeySchema,
	walletPublicKey: sessionPublicKeySchema,
	challenge: z.string().min(1),
	requestId: z.string().min(1)
})

export type SignTransactionRequestInput = z.infer<typeof signTransactionRequestSchema>
export type GenerateApiKeyRequestInput = z.infer<typeof generateApiKeyRequestSchema>
export type SignMessageRequestInput = z.infer<typeof signMessageRequestSchema>
export type ConnectTranscriptInput = z.infer<typeof connectTranscriptSchema>
