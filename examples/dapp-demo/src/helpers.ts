import { AMA_TOKEN_DECIMALS, getTransactionErrorMessage } from '@amadeus-protocol/sdk'

const AMOUNT_PATTERN = new RegExp(
	`^(\\d+\\.?\\d{0,${AMA_TOKEN_DECIMALS}}|\\.\\d{1,${AMA_TOKEN_DECIMALS}})$`
)

/** Decimal AMA to atomic units as a string, or null if not a positive amount with at most 9 decimals. */
export function toAtomicAmount(input: string): string | null {
	const amount = input.trim()
	if (!AMOUNT_PATTERN.test(amount)) return null
	const [whole, fraction = ''] = amount.split('.')
	// BigInt, not toAtomicAma: floats drop the last digits of large amounts.
	const atomic =
		BigInt(whole) * 10n ** BigInt(AMA_TOKEN_DECIMALS) +
		BigInt(fraction.padEnd(AMA_TOKEN_DECIMALS, '0'))
	return atomic > 0n ? atomic.toString() : null
}

/** Contract-call args from the input: a JSON array (blank = []), or null if invalid. */
export function parseArgs(input: string): unknown[] | null {
	try {
		const args: unknown = JSON.parse(input.trim() || '[]')
		return Array.isArray(args) ? args : null
	} catch {
		return null
	}
}

/** Readable message for a node submit error code. */
export function submitErrorMessage(code: string): string {
	// The tx signature is bound to the network, so a wallet on the other network fails here.
	if (code === 'invalid_signature') {
		return 'The node rejected the signature — network mismatch? Pick the same network as the wallet.'
	}
	if (code === 'timeout') return 'Submitted, but not confirmed yet — check the explorer shortly.'
	return getTransactionErrorMessage(code)
}
