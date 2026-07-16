# @amadeus-protocol/wallet-sdk

One audited home for the Amadeus dApp ↔ wallet connection layer. The wallet
(mobile + extension) and every dApp import the **same** crypto and protocol code,
so the two sides can never drift — which is the entire point.

Built on top of [`@amadeus-protocol/sdk`](https://www.npmjs.com/package/@amadeus-protocol/sdk)
(key derivation, encoding, `TransactionBuilder`). This package adds only the
connection layer.

> **Status: v0.1 — crypto + protocol core.** Transports (deep link / QR / bridge)
> and React hooks are not in this release. See "Roadmap" below.

## What's in this release

| Area                   | Exports                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **API-key tokens**     | `generateApiKey`, `verifyApiKey`, `decodeApiKey`                                                                                       |
| **Transactions**       | `signTransaction`, `submitTransaction`                                                                                                 |
| **Connection auth**    | `signConnect`, `verifyConnect`, `buildConnectTranscript`                                                                               |
| **Session encryption** | `generateSessionKeypair`, `deriveSharedKey`, `seal`, `open`                                                                            |
| **Provider contract**  | `AmadeusProvider`, `getAmadeusProvider`, `isProviderAvailable`, event/response types                                                   |
| **Wire validation**    | zod schemas: `signTransactionRequestSchema`, `generateApiKeyRequestSchema`, `connectTranscriptSchema`, `addressSchema`, `originSchema` |
| **Binary args**        | `encodeBinaryValues`, `decodeBinaryValues`, `describeBinaryValues`                                                                     |
| **Constants**          | all DSTs, byte lengths, event names, `PROTOCOL_VERSION`                                                                                |

## Why unify the API-key token first

It was hand-rolled in **three** places (the extension, `hub`, and `prime-hub`),
all of which must stay byte-identical to the `kbs.ama.one` backend. `generateApiKey`
here reproduces that exact token — `base58( json{aud,exp} ‖ pubkey48 ‖ sig96 )`
signed over `sha256(json ‖ pubkey)` under the `_APIKEY_` DST — and a test asserts
byte-for-byte equality with the original recipe. Consumers can now delete their copies.

```ts
import { generateApiKey, verifyApiKey } from '@amadeus-protocol/wallet-sdk'

const { apiKey } = generateApiKey({ seed, aud: 'amadeus', expIn: 7 * 24 * 3600 })
// ... later, on any verifier:
const result = verifyApiKey(apiKey, { aud: 'amadeus' })
if (result.valid) console.log(result.address)
```

## Security notes

- **Distinct DSTs** (`_TX_`, `_APIKEY_`, `_CONNECT_`) make a signature from one
  context cryptographically unusable in another.
- **Connect auth signs the full transcript** — origin + both session keys +
  challenge + request id — not just the nonce, which closes the key-substitution
  MITM.
- **No arbitrary message-signing oracle**: connection proof only ever signs a
  structured, length-prefixed transcript.
- **Session box** uses x25519 + XChaCha20-Poly1305 via `@noble` (Hermes-safe; no
  `tweetnacl` "no PRNG" issue) and fails closed on any tamper.

## Develop

```sh
bun install
bun run test        # vitest
bun run typecheck
bun run build       # tsdown -> dist/
```

## Roadmap

1. **Transports** — deep link / Universal Link ingress, QR pairing, and a
   self-hosted encrypted bridge, all speaking one envelope.
2. **`/react`** — `WalletProvider` + `useWallet()` so dApps stop copy-pasting
   provider glue (and the `amadeus#initialized` vs `amadeus-wallet#initialized`
   bug gets fixed once).
3. **Adoption** — migrate the extension, `hub`, and `prime-hub` off their
   hand-rolled crypto onto this package.
