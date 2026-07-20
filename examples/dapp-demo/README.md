# Amadeus dApp Demo

A minimal browser dApp that connects to the Amadeus wallet by QR and requests a
signature — end to end over the bridge relay.

## Run it

1. **Start the bridge relay** (from the wallet-sdk package root):
   ```sh
   node bridge/server.mjs        # listens on http://localhost:8787
   ```
2. **Start the demo:**
   ```sh
   cd examples/dapp-demo
   bun install
   bun run dev                   # prints a http://localhost:5173 URL
   ```
3. Open the URL, click **Connect wallet**, and **scan the QR** with the Amadeus
   wallet (Home → Connect) and approve.
4. Click **Sign test transfer** and approve in the wallet — the returned tx hash
   appears in the demo.

## Cross-device note

For a real phone wallet + desktop dApp, the bridge must be reachable from the
phone AND be **https** (the wallet only allows `http` for `localhost`). Expose the
local relay with a tunnel (e.g. `cloudflared`/`ngrok`) or deploy it, and put that
https URL in the "Bridge URL" field before connecting. Same-device / simulator can
use `http://localhost:8787`.
