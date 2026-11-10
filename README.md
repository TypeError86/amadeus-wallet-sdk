# @amadeus-protocol/wallet-sdk

The connection layer between Amadeus dApps and Amadeus wallets: the typed
`window.amadeus` provider and a client for it, a React hook, Amadeus Connect (QR /
deep link + an end-to-end encrypted relay to the mobile wallet), the wallet-side
request handler, transaction and message signing, and BLS API-key tokens.

The Amadeus mobile wallet runs this package on its side of Amadeus Connect, so a
dApp that uses it runs the same crypto and protocol code as the wallet it talks to.
Key derivation, encoding and transaction building come from
[`@amadeus-protocol/sdk`](https://www.npmjs.com/package/@amadeus-protocol/sdk);
this package adds only the dApp ↔ wallet layer.

**Full documentation: [docs.ama.one/wallet-sdk](https://docs.ama.one/wallet-sdk)**

## Install

```sh
npm install @amadeus-protocol/wallet-sdk @amadeus-protocol/sdk
# or
bun add @amadeus-protocol/wallet-sdk @amadeus-protocol/sdk
```

- Peer dependency `@amadeus-protocol/sdk` `^1.3.0` (required); `react` `>=18`
  only for the `/react` entry point.
- ESM only, Node.js 20+ on servers. Runs in browsers, Node.js and React Native
  (Hermes; session keys, nonces and ids come from `crypto.getRandomValues`, so
  polyfill it there, e.g. with `react-native-get-random-values`).

| Import path                          | Contents                                                    |
| ------------------------------------ | ----------------------------------------------------------- |
| `@amadeus-protocol/wallet-sdk`       | Everything below except React                               |
| `@amadeus-protocol/wallet-sdk/react` | `useWallet` and its types `UseWalletResult`, `WalletStatus` |

## What's in the package

| Area                                    | Main exports                                                                                                                                                                                                                   | Docs                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **Injected client** (browser extension) | `createInjectedWalletClient`, `WalletClient`, `ApiKeyStore`                                                                                                                                                                    | [Connect a dApp](https://docs.ama.one/wallet-sdk/connect-a-dapp)             |
| **React**                               | `useWallet` (from `/react`)                                                                                                                                                                                                    | [React](https://docs.ama.one/wallet-sdk/react)                               |
| **Provider contract**                   | `AmadeusProvider`, `getAmadeusProvider`, `isProviderAvailable`, `AmadeusEventPayloadMap`, `PROVIDER_EVENTS`, `WALLET_WINDOW_EVENTS`, `WALLET_INITIALIZED_EVENT`                                                                | [Provider reference](https://docs.ama.one/wallet-sdk/provider-reference)     |
| **Amadeus Connect** (dApp side)         | `createConnectRequest`, `completeConnect`, `parseConnectResponseUri`, `BridgeClient`, `deriveConnectChannel`, `deriveBridgeChannels`, `makeRequest`, `sealRequest`, `openResponse`, `DEFAULT_BRIDGE_URL`                       | [Amadeus Connect](https://docs.ama.one/wallet-sdk/amadeus-connect)           |
| **Wallet side**                         | `parseConnectUri`, `isConnectRequestExpired`, `assertAllowedBridgeUrl`, `approveConnect`, `buildConnectResponseUri`, `openRequest`, `guardRequest`, `createMemorySeenStore`, `handleRequest`, `sealResponse`, `WALLET_METHODS` | [Wallet integration](https://docs.ama.one/wallet-sdk/wallet-integration)     |
| **Transactions**                        | `signTransaction`, `submitTransaction`, `encodeBinaryValues`, `decodeBinaryValues`, `describeBinaryValues`                                                                                                                     | [Signing and API keys](https://docs.ama.one/wallet-sdk/signing-and-api-keys) |
| **Messages**                            | `signMessage`, `verifyMessage`                                                                                                                                                                                                 | [Signing and API keys](https://docs.ama.one/wallet-sdk/signing-and-api-keys) |
| **API keys**                            | `generateApiKey`, `verifyApiKey`, `decodeApiKey`                                                                                                                                                                               | [Signing and API keys](https://docs.ama.one/wallet-sdk/signing-and-api-keys) |
| **Wire validation**                     | zod schemas: `signTransactionRequestSchema`, `signMessageRequestSchema`, `generateApiKeyRequestSchema`, `switchAccountRequestSchema`, `connectTranscriptSchema`, `addressSchema`, `originSchema`, `networkSchema`              | [Provider reference](https://docs.ama.one/wallet-sdk/provider-reference)     |
| **Low-level crypto**                    | `signConnect`, `verifyConnect`, `buildConnectTranscript`, `generateSessionKeypair`, `deriveSharedKey`, `seal`, `open`, `deriveSigner`, `signHashed`, `verifyHashed`                                                            | [Signing and API keys](https://docs.ama.one/wallet-sdk/signing-and-api-keys) |
| **Constants and errors**                | DSTs (`TX_DST`, `MESSAGE_DST`, `API_KEY_DST`, `CONNECT_DST`), byte lengths, `PROTOCOL_VERSION`, `NETWORKS`; `WalletSdkError` with a stable `code`                                                                              | [Overview](https://docs.ama.one/wallet-sdk)                                  |

`signTransaction`, `signMessage` and `generateApiKey` take a seed: they are what a
wallet runs. A dApp asks the wallet for their results instead.

## Browser extension

`createInjectedWalletClient()` wraps the injected `window.amadeus` provider. The
wallet only signs; `signAndSubmit` posts the signed bytes to the node you pass,
and `nodeUrl` must include `/api`.

```ts
import { toAtomicAma } from '@amadeus-protocol/sdk'
import { createInjectedWalletClient } from '@amadeus-protocol/wallet-sdk'

const recipient = '<Base58 address>'
const wallet = createInjectedWalletClient()

if (wallet.isAvailable()) {
	const account = await wallet.connect()
	const { txHash } = await wallet.signAndSubmit(
		{
			contract: 'Coin',
			method: 'transfer',
			args: [recipient, String(toAtomicAma(1.5)), 'AMA']
		},
		{ nodeUrl: 'https://mainnet-rpc.ama.one/api', wait: true }
	)
	console.log(`${account} sent ${txHash}`)
}
```

The client also has `getAccount`, `getNetwork`, `signTransaction`, `on` / `off`
for provider events, `ensureApiKey` (returns a cached API key or asks the wallet
for a new one) and `switchAccount(target?)`. `switchAccount` asks the wallet to
change the active account; the extension asks the user to approve (it resolves
at once only when `target` is already active), and the call throws
`WalletSdkError` code `UNSUPPORTED` on extension builds without
`requestSwitchAccount`.

The extension can inject `window.amadeus` after your script runs. Listen for
`WALLET_INITIALIZED_EVENT` (`amadeus-wallet#initialized`, not
`amadeus#initialized`), or use the React hook, which does it for you.

## React

```tsx
import { useWallet } from '@amadeus-protocol/wallet-sdk/react'

export function WalletButton() {
	const { status, account, connect, switchAccount } = useWallet()

	if (status === 'unavailable') return <p>Install the Amadeus Wallet extension</p>
	if (status !== 'connected') {
		return (
			<button onClick={() => void connect()} disabled={status === 'connecting'}>
				Connect wallet
			</button>
		)
	}
	return <button onClick={() => void switchAccount()}>{account}</button>
}
```

`useWallet()` returns `status` (`unavailable`, `disconnected`, `connecting`,
`connected`), `account`, `network`, `isAvailable`, the underlying `client`, and
`connect`, `disconnect`, `switchAccount`, `signTransaction`, `signAndSubmit`,
`ensureApiKey`. It moves from `unavailable` to `disconnected` when the provider
is injected late. If the provider is present when the hook mounts, it also reads
the current account and network and keeps them in sync with the wallet's events.
`disconnect()` only clears the hook's local state.

## Amadeus Connect (mobile wallet)

For the Amadeus mobile wallet, on another device or the same one:

1. The dApp calls `createConnectRequest({ origin })` and shows the returned
   `amadeus://v1/connect?...` URI as a QR code or link. Requests expire after 120
   seconds by default and carry a relay URL (`https://bridge.ama.one` unless you
   pass `bridgeUrl`).
2. The wallet signs a transcript binding the origin, both session keys, the
   challenge and the request id, and returns its address. The dApp receives it
   over the relay (`deriveConnectChannel`) or the redirect link and calls
   `completeConnect`, which verifies the signature and derives the shared key.
3. Requests (`amadeus_signTransaction`, `amadeus_signMessage`,
   `amadeus_getAccounts`, `amadeus_generateApiKey`) then travel as sealed
   envelopes over `BridgeClient`, on two channels derived from the shared key.

Over Amadeus Connect, `amadeus_switchNetwork` and `amadeus_switchAccount` come
back as error responses from `handleRequest`; switching is left to the wallet app.
See [Amadeus Connect](https://docs.ama.one/wallet-sdk/amadeus-connect) for a
complete dApp implementation.

## Wallet side

A wallet answers Amadeus Connect with a few calls. Check expiry and replay before
showing anything to the user, and sign only after they approve:

```ts
import type { NetworkType } from '@amadeus-protocol/sdk'
import {
	approveConnect,
	assertAllowedBridgeUrl,
	createMemorySeenStore,
	guardRequest,
	handleRequest,
	isConnectRequestExpired,
	openRequest,
	parseConnectUri,
	sealResponse,
	type SealedEnvelope,
	type WalletRequest
} from '@amadeus-protocol/wallet-sdk'

interface Account {
	seed: string
	address: string
	network: NetworkType
}

// Use a persisted store in a real wallet so replays fail across restarts.
const seenRequests = createMemorySeenStore()

export function acceptConnect(uri: string, account: Account) {
	const request = parseConnectUri(uri)
	if (isConnectRequestExpired(request)) throw new Error('Connect request expired')
	if (request.bridgeUrl) assertAllowedBridgeUrl(request.bridgeUrl)
	// Ask the user to approve request.origin before this line.
	return approveConnect(request, { seed: account.seed, address: account.address })
}

export async function answer(
	sharedKey: Uint8Array,
	envelope: SealedEnvelope,
	accountFor: (address?: string) => Account,
	confirm: (request: WalletRequest) => Promise<boolean>
): Promise<SealedEnvelope | null> {
	const request = openRequest(sharedKey, envelope)
	guardRequest(request, seenRequests)
	if (!(await confirm(request))) return null
	return sealResponse(sharedKey, handleRequest(request, accountFor(request.account)))
}
```

`request.account` is set when the dApp picks which of your accounts signs; when it
is absent, sign with the account bound at connect. `handleRequest` never throws:
failures come back as `{ ok: false, error }`.
Transactions are signed for `network` (mainnet when omitted), so a testnet
transaction cannot be replayed on mainnet. See
[Wallet integration](https://docs.ama.one/wallet-sdk/wallet-integration).

## API-key tokens

`generateApiKey` produces the BLS bearer token `kbs.ama.one` verifies:
`base58( json{aud,exp} ‖ pubkey48 ‖ sig96 )`, signed over `sha256(json ‖ pubkey)`
under the `_APIKEY_` DST. A test asserts it is byte-identical to the recipe the
extension and hub used before. Verification needs no wallet and no network:

```ts
import { verifyApiKey } from '@amadeus-protocol/wallet-sdk'

export function authenticate(authorization: string): string {
	const result = verifyApiKey(authorization.replace(/^Bearer /, ''), { aud: 'amadeus' })
	if (!result.valid) throw new Error(`Rejected API key: ${result.reason}`)
	return result.address
}
```

The token's address is the public key of the `seed` you sign with. A recovery
phrase can open two addresses (standard `eip2333`, and `legacy` for wallets
created by older extension and app builds), so when you start from a phrase,
resolve the seed with `resolveCandidateForAddress` (`@amadeus-protocol/sdk`
1.6.0+). It returns `null` if neither derivation opens the address and throws on
an invalid phrase:

```ts
import { resolveCandidateForAddress } from '@amadeus-protocol/sdk'
import { generateApiKey } from '@amadeus-protocol/wallet-sdk'

export function apiKeyForAddress(phrase: string, walletAddress: string): string {
	const candidate = resolveCandidateForAddress(phrase, walletAddress)
	if (!candidate) throw new Error('This phrase does not open that address')
	return generateApiKey({ seed: candidate.seed, aud: 'amadeus', expIn: 3600 }).apiKey
}
```

## Security notes

- **Distinct DSTs** (`_TX_`, `_MSG_`, `_APIKEY_`, `_CONNECT_`) make a signature
  from one context unusable in another. Testnet transactions use the core SDK's
  separate `_TX_TESTNET_` tag.
- **Message signing** (`signMessage`) signs a UTF-8 string of at most 4096
  characters under its own `_MSG_` tag, so a signed message can never verify as a
  transaction, an API key or a connect proof.
- **Connect auth signs the full transcript**: origin, both session keys,
  challenge and request id, not just a nonce, which closes key substitution.
- **Session box**: x25519 + XChaCha20-Poly1305 via `@noble` (Hermes-safe). It
  fails closed on any tamper.
- **Replay and expiry**: `guardRequest` rejects expired requests and reused ids.
  Give it a persisted store in production.
- **Untrusted relay**: after connect, channel ids derive from the shared key, so
  the relay sees only ciphertext between opaque ids. The connect response itself
  is plaintext, protected by the connect signature. Bridge URLs must be https
  (http only for localhost).

## Develop

```sh
bun install
bun run test        # vitest
bun run typecheck
bun run lint
bun run build       # tsdown -> dist/
bun run examples/e2e-demo.mjs   # connect + encrypted sign round trip, after build
```

`examples/dapp-demo` is a minimal browser dApp that connects to the wallet by QR
over the relay.

## License

MIT
