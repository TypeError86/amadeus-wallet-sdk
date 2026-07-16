/**
 * @amadeus-protocol/wallet-sdk
 *
 * One audited home for the Amadeus dApp <-> wallet connection layer: BLS
 * API-key tokens, transaction signing, connection-auth signing, an encrypted
 * session channel, the typed provider contract, and wire-schema validation.
 * Reuses `@amadeus-protocol/sdk` for all key derivation, encoding, and tx building.
 */

export * from './constants'
export * from './errors'
export * from './bytes'
export * from './binary'
export * from './tx'
export * from './types'
export * from './schema'

// Crypto
export * from './crypto/bls'
export * from './crypto/apikey'
export * from './crypto/connect'
export * from './crypto/box'

// Transport (connect handshake + sealed envelopes + deep-link/QR URIs)
export * from './transport/envelope'
export * from './transport/uri'
export * from './transport/session'

// Wallet-side request dispatch + framework-agnostic dApp client.
// React bindings live in the `@amadeus-protocol/wallet-sdk/react` subpath.
export * from './wallet/handler'
export * from './client/injected'
