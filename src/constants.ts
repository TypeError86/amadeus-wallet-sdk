/**
 * Protocol constants for the Amadeus dApp <-> wallet connection layer.
 *
 * The Domain Separation Tags (DSTs) below are the single most safety-critical
 * values in this package. A signature made under one DST can NEVER verify under
 * another (BLS hash-to-curve mixes the DST into the point), which is exactly how
 * we guarantee an auth signature can never be replayed as a transaction, and
 * vice-versa. Two of these (`TX`, `APIKEY`) already exist in production — in
 * `@amadeus-protocol/sdk` and in the wallet extension respectively — and MUST
 * stay byte-for-byte identical here or existing tokens/txs stop verifying.
 */

/** Transactions. Owned by `@amadeus-protocol/sdk` (`signing.ts`). Do not change. */
export const TX_DST = 'AMADEUS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_TX_'

/**
 * KBS bearer / API-key tokens. Currently hand-rolled identically in the wallet
 * extension (`background/handlers/api-key.ts`) and in hub/prime-hub
 * (`utils/blsWallet.ts`). This package is the one audited home for it. Do not
 * change — `kbs.ama.one` verifies against this exact tag.
 */
export const API_KEY_DST = 'AMADEUS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_APIKEY_'

/**
 * Connection-auth transcript signatures. NEW in this package — nothing verified
 * it before, so there is no backward-compat constraint. Deliberately distinct
 * from every other DST so a connect proof is unusable anywhere else.
 */
export const CONNECT_DST = 'AMADEUS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_CONNECT_'

/** Byte lengths of the Amadeus BLS12-381 "long-signature" variant (G1 pk / G2 sig). */
export const PUBLIC_KEY_BYTE_LENGTH = 48
export const SIGNATURE_BYTE_LENGTH = 96
export const SEED_BYTE_LENGTH = 64

/**
 * Hard cap on the length of an api-key string accepted for decoding. A genuine
 * token is ~260 chars; this bounds untrusted input BEFORE the (quadratic) Base58
 * decode so a huge string can't stall the verifier's event loop. Generous enough
 * for a multi-hundred-char audience claim.
 */
export const MAX_API_KEY_STRING_LENGTH = 1024

/** x25519 / xchacha20-poly1305 session-box parameters. */
export const SESSION_PUBLIC_KEY_BYTE_LENGTH = 32
export const SESSION_SECRET_KEY_BYTE_LENGTH = 32
export const SESSION_NONCE_BYTE_LENGTH = 24

/** Wire protocol version. Absent in the extension today; new requests carry it. */
export const PROTOCOL_VERSION = 1

/** Label mixed into the connect transcript so its bytes are unambiguous. */
export const CONNECT_TRANSCRIPT_LABEL = 'amadeus-connect/v1'

/** The injected-provider global name and feature-detect flag. */
export const PROVIDER_GLOBAL = 'amadeus'

/**
 * The canonical wallet-ready window event. NOTE: several dApps historically
 * listened for the WRONG name `amadeus#initialized`; the real one the extension
 * dispatches is `amadeus-wallet#initialized`. Consumers should use this constant.
 */
export const WALLET_INITIALIZED_EVENT = 'amadeus-wallet#initialized'

/** All window CustomEvents the wallet dispatches on the page. */
export const WALLET_WINDOW_EVENTS = {
	initialized: 'amadeus-wallet#initialized',
	connected: 'amadeus-wallet#connected',
	disconnected: 'amadeus-wallet#disconnected',
	locked: 'amadeus-wallet#locked',
	unlocked: 'amadeus-wallet#unlocked',
	networkChanged: 'amadeus-wallet#networkChanged'
} as const

/** Provider `.on()` event names (EIP-1193-style). */
export const PROVIDER_EVENTS = [
	'accountsChanged',
	'connect',
	'disconnect',
	'lock',
	'unlock',
	'networkChanged'
] as const

/** The valid networks the wallet exposes. */
export const NETWORKS = ['mainnet', 'testnet', 'custom'] as const
