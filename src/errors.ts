/** Stable error codes so callers can branch without string-matching messages. */
export type WalletSdkErrorCode =
	| 'INVALID_API_KEY'
	| 'BAD_SIGNATURE'
	| 'EXPIRED'
	| 'AUD_MISMATCH'
	| 'INVALID_ADDRESS'
	| 'INVALID_SIGNATURE'
	| 'INVALID_ARGUMENT'
	| 'SUBMIT_FAILED'
	| 'DECRYPT_FAILED'

export class WalletSdkError extends Error {
	readonly code: WalletSdkErrorCode

	constructor(code: WalletSdkErrorCode, message: string) {
		super(message)
		this.name = 'WalletSdkError'
		this.code = code
		// Restore prototype chain for instanceof across transpile targets.
		Object.setPrototypeOf(this, WalletSdkError.prototype)
	}
}
