/**
 * Transaction signing + submission.
 *
 * Signing reuses `@amadeus-protocol/sdk`'s `TransactionBuilder` verbatim (so the
 * packed bytes are identical to what the extension produces today) and layers on
 * the two behaviors the wallet's sign handler applies: restore JSON-transported
 * binary args, and convert a `Coin.transfer` Base58 recipient to raw bytes.
 * The wallet signs only; the caller submits the returned `txPacked` to a node.
 */

import { fromBase58, type SerializableValue, TransactionBuilder } from '@amadeus-protocol/sdk'

import { decodeBinaryValues } from './binary'
import { WalletSdkError } from './errors'

export interface SignTransactionParams {
	/** Base58 wallet seed (private key). */
	seed: string
	contract: string
	method: string
	/** Args may contain tagged binary values (see `encodeBinaryValues`). */
	args: unknown[]
	description?: string
}

export interface SignedTransaction {
	/** Base58 transaction hash. */
	txHash: string
	/** Packed transaction bytes as a plain number[] — ready to POST to a node. */
	txPacked: number[]
}

export function signTransaction(params: SignTransactionParams): SignedTransaction {
	const builder = new TransactionBuilder(params.seed)

	// Restore any binary args that were wrapped for a JSON/text transport.
	let processedArgs = decodeBinaryValues(params.args) as unknown[]

	// Coin.transfer's recipient (arg 0) is a Base58 address on the wire but must
	// be raw bytes for the SDK to encode it as BYTES. Matches the extension.
	if (
		params.contract === 'Coin' &&
		params.method === 'transfer' &&
		typeof processedArgs[0] === 'string'
	) {
		processedArgs = [fromBase58(processedArgs[0]), processedArgs[1], processedArgs[2]]
	}

	const { txHash, txPacked } = builder.buildAndSign(
		params.contract,
		params.method,
		processedArgs as SerializableValue[]
	)
	return { txHash, txPacked: Array.from(txPacked) }
}

export interface SubmitTransactionOptions {
	/** Base URL of the node API, e.g. "https://mainnet-rpc.ama.one/api". */
	nodeUrl: string
	/** Wait for inclusion (`/tx/submit_and_wait`) vs fire-and-forget (`/tx/submit`). */
	wait?: boolean
	/** Abort the request after this many ms. */
	timeoutMs?: number
}

/**
 * Submit packed transaction bytes to a node as an octet-stream, the way the
 * dApps do today. Returns the parsed JSON body when possible, else raw text.
 */
export async function submitTransaction(
	txPacked: number[] | Uint8Array,
	options: SubmitTransactionOptions
): Promise<unknown> {
	// nodeUrl is trusted config, but guard the scheme so a stray file:// or other
	// non-http target can never be fetched.
	if (!/^https?:\/\//.test(options.nodeUrl)) {
		throw new WalletSdkError('INVALID_ARGUMENT', 'nodeUrl must be an http(s) URL')
	}

	const bytes = txPacked instanceof Uint8Array ? txPacked : Uint8Array.from(txPacked)
	// Hand fetch a standalone ArrayBuffer — a clean BodyInit across DOM lib
	// versions and RN, and it never carries a shared/offset backing buffer.
	const body = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer
	const path = options.wait ? '/tx/submit_and_wait' : '/tx/submit'
	const url = `${options.nodeUrl.replace(/\/$/, '')}${path}`

	// Always arm a timeout so a hung node can't block the caller forever.
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)

	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/octet-stream' },
			body,
			signal: controller.signal
		})
		const text = await res.text()
		if (!res.ok) {
			throw new WalletSdkError('SUBMIT_FAILED', `node returned ${res.status}: ${text}`)
		}
		try {
			return JSON.parse(text)
		} catch {
			return text
		}
	} finally {
		clearTimeout(timer)
	}
}
