# BaseLens

Pay-per-call Base mainnet utilities for AI agents. **No API key, no signup.** Each call costs **$0.01 USDC on Base**, paid automatically via [x402](https://x402.org).

**Live:** https://baselens.imac2014ville.workers.dev · [OpenAPI](https://baselens.imac2014ville.workers.dev/openapi.json)

| Endpoint | What it does |
|---|---|
| `POST /tx` `{ "hash": "0x…" }` | Explains a Base transaction in plain English: status, confirmations, fee, decoded ERC-20 transfers (symbol + amount). Handy for **verifying a payment landed**. |
| `POST /wallet` `{ "address": "0x…" }` | ETH balance, nonce, EOA vs contract (detects EIP-7702 delegation), balances of USDC, USDbC, WETH, cbBTC, cbETH, DAI, EURC, AERO. |
| `POST /x402check` `{ "url": "https://…", "method": "GET" }` | Health-checks another x402 endpoint **before you pay it**: reachable, latency, x402 version, USD price, network, payTo, discovery metadata, spec issues. |

`GET` with query params works too (`/tx?hash=0x…`).

## Use it from an agent

```js
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(privateKeyToAccount(process.env.PK)) }],
});
const r = await pay("https://baselens.imac2014ville.workers.dev/tx", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ hash: "0x98023b255a23cf26d93492a6c3c542247cea95fa201dc83ed3fa91d3b6fcb57f" }),
});
console.log(await r.json());
```

Any x402 v2 client works (e.g. `@x402/fetch`, `@x402/axios`, or MCP wallets such as agentcash).

## Example response (`/tx`)

```json
{
  "found": true, "status": "success", "confirmations": 442,
  "from": "0xab73…", "to": "0x8335…2913", "feeEth": "0.000001007458660576",
  "tokenTransfers": [{ "symbol": "USDC", "amount": "14.99", "from": "0xab73…", "to": "0x85d3…" }],
  "summary": ["14.99 USDC from 0xab73… to 0x85d3…"]
}
```

## Self-host

Cloudflare Worker, Hono, and `@x402/hono`. Data comes straight from the public Base RPC; no third-party API keys.

```sh
npm install && npx wrangler deploy
```

Change `PAY_TO` in `index.js` to your own address. Settlement goes through the PayAI facilitator, so you don't need a key.

MIT licensed.
