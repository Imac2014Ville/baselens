// BaseLens — pay-per-call Base chain utilities for AI agents (x402, USDC on Base).
import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { fetchMarkdown } from "./fetch.js";
import { newPools } from "./pools.js";
import { cloudPrices } from "./prices.js";
import { tokenRisk, rpcBatch as rpcBatchRaw } from "./risk.js";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";

const PAY_TO = "0x5b60a748582169C1cD3799B09406aFe99F174B88";
const NETWORK = "eip155:8453";
const FACILITATOR = "https://facilitator.payai.network";
const PRICE = "$0.01";

const TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  WETH: "0x4200000000000000000000000000000000000006", cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  EURC: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
};
const DECIMALS = { USDC: 6, USDbC: 6, WETH: 18, cbBTC: 8, cbETH: 18, DAI: 18, EURC: 6, AERO: 18 };
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ---------- chain helpers ----------
async function rpcBatch(calls) { return (await rpcBatchRaw(calls)).map(o => o.result); }
const rpc = async (m, p) => (await rpcBatch([[m, p]]))[0];
const hexToBig = h => (h && h !== "0x" ? BigInt(h) : 0n);
const fmt = (v, d) => { const s = v.toString().padStart(d + 1, "0"); const i = s.slice(0, -d) || "0", f = s.slice(-d).replace(/0+$/, ""); return d ? (f ? `${i}.${f}` : i) : s; };
const addrTopic = t => "0x" + t.slice(26);
const isAddr = a => /^0x[0-9a-fA-F]{40}$/.test(a || "");
const isHash = h => /^0x[0-9a-fA-F]{64}$/.test(h || "");

const hexText = h => new TextDecoder().decode(Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16)));
function decodeString(hex) {
  if (!hex || hex === "0x") return null;
  const b = hex.slice(2);
  if (b.length === 64) return hexText(b).replace(/\0+$/, "") || null; // bytes32
  try { const len = parseInt(b.slice(64, 128), 16); return hexText(b.slice(128, 128 + len * 2)); } catch { return null; }
}

async function tokenMeta(addrs) {
  const calls = addrs.flatMap(a => [["eth_call", [{ to: a, data: "0x95d89b41" }, "latest"]], ["eth_call", [{ to: a, data: "0x313ce567" }, "latest"]]]);
  const res = calls.length ? await rpcBatch(calls) : [];
  const meta = {};
  addrs.forEach((a, i) => { meta[a] = { symbol: decodeString(res[2 * i]), decimals: res[2 * i + 1] && res[2 * i + 1] !== "0x" ? Number(hexToBig(res[2 * i + 1])) : null }; });
  return meta;
}

async function explainTx(hash) {
  const [tx, rc, head] = await rpcBatch([["eth_getTransactionByHash", [hash]], ["eth_getTransactionReceipt", [hash]], ["eth_blockNumber", []]]);
  if (!tx) return { found: false, hash, note: "Transaction not found on Base mainnet (wrong chain, or not yet propagated)." };
  const block = rc ? await rpc("eth_getBlockByNumber", [rc.blockNumber, false]) : null;
  const transfers = (rc?.logs || []).filter(l => l.topics[0] === TRANSFER && l.topics.length === 3);
  const meta = await tokenMeta([...new Set(transfers.map(l => l.address.toLowerCase()))]);
  const fee = rc ? hexToBig(rc.gasUsed) * hexToBig(rc.effectiveGasPrice) + hexToBig(rc.l1Fee) : null;
  const tokenTransfers = transfers.map(l => {
    const m = meta[l.address.toLowerCase()] || {}, raw = hexToBig(l.data);
    return { token: l.address, symbol: m.symbol, from: addrTopic(l.topics[1]), to: addrTopic(l.topics[2]), raw: raw.toString(),
      amount: m.decimals != null ? fmt(raw, m.decimals) : null };
  });
  const summary = [];
  if (hexToBig(tx.value) > 0n) summary.push(`${fmt(hexToBig(tx.value), 18)} ETH from ${tx.from} to ${tx.to}`);
  for (const t of tokenTransfers) summary.push(`${t.amount ?? t.raw} ${t.symbol ?? t.token} from ${t.from} to ${t.to}`);
  return {
    found: true, hash, status: rc ? (rc.status === "0x1" ? "success" : "reverted") : "pending",
    blockNumber: rc ? Number(hexToBig(rc.blockNumber)) : null,
    confirmations: rc ? Number(hexToBig(head) - hexToBig(rc.blockNumber)) + 1 : 0,
    timestamp: block ? new Date(Number(hexToBig(block.timestamp)) * 1000).toISOString() : null,
    from: tx.from, to: tx.to, contractCreated: rc?.contractAddress || null,
    methodSelector: tx.input?.length >= 10 ? tx.input.slice(0, 10) : null,
    valueEth: fmt(hexToBig(tx.value), 18), feeEth: fee != null ? fmt(fee, 18) : null,
    tokenTransfers, logCount: rc?.logs?.length ?? 0,
    summary: summary.length ? summary : ["No ETH value or ERC-20 transfers (contract interaction only)."],
  };
}

async function walletSnapshot(address) {
  const a = address.toLowerCase(), pad = a.slice(2).padStart(64, "0");
  const names = Object.keys(TOKENS);
  const res = await rpcBatch([
    ["eth_getBalance", [a, "latest"]], ["eth_getTransactionCount", [a, "latest"]], ["eth_getCode", [a, "latest"]],
    ...names.map(n => ["eth_call", [{ to: TOKENS[n], data: "0x70a08231" + pad }, "latest"]]),
  ]);
  const balances = {};
  names.forEach((n, i) => { const v = hexToBig(res[3 + i]); if (v > 0n) balances[n] = fmt(v, DECIMALS[n]); });
  const code = res[2] || "0x";
  return {
    address, network: "base", ethBalance: fmt(hexToBig(res[0]), 18), nonce: Number(hexToBig(res[1])),
    type: code === "0x" ? "EOA" : code.startsWith("0xef0100") ? "EOA (EIP-7702 delegated)" : "contract",
    tokenBalances: balances, tokensChecked: names,
  };
}

async function x402Check(target, method = "GET") {
  method = String(method).toUpperCase() === "POST" ? "POST" : "GET";
  let u;
  try { u = new URL(target); } catch { return { ok: false, error: "invalid url" }; }
  if (u.protocol !== "https:") return { ok: false, error: "only https urls are checked" };
  const t0 = Date.now();
  let r;
  try { r = await fetch(u, { method, headers: { accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) }, body: method === "POST" ? "{}" : undefined, redirect: "manual", signal: AbortSignal.timeout(8000) }); }
  catch (e) { return { ok: false, url: target, reachable: false, error: String(e.message || e) }; }
  const latencyMs = Date.now() - t0, issues = [];
  const out = { url: target, method, reachable: true, httpStatus: r.status, latencyMs };
  if (r.status !== 402) { issues.push(`expected HTTP 402 for an unpaid ${method} request, got ${r.status}` + (r.status === 405 ? " (try method=POST)" : "")); return { ...out, ok: false, isX402: false, issues }; }
  let req = null, version = null;
  const hdr = r.headers.get("payment-required");
  if (hdr) { try { req = JSON.parse(atob(hdr)); version = req.x402Version; } catch { issues.push("PAYMENT-REQUIRED header is not valid base64 JSON"); } }
  if (!req) { try { req = await r.json(); version = req.x402Version; } catch { issues.push("402 body is not JSON and no PAYMENT-REQUIRED header"); } }
  const accepts = Array.isArray(req?.accepts) ? req.accepts : [];
  if (!accepts.length) issues.push("no 'accepts' payment options");
  const options = accepts.map(a => {
    const atomic = a.amount ?? a.maxAmountRequired;
    const known = Object.entries(TOKENS).find(([, t]) => t.toLowerCase() === String(a.asset).toLowerCase());
    const usd = atomic && known && ["USDC", "USDbC", "DAI"].includes(known[0]) ? Number(fmt(BigInt(atomic), known[0] === "DAI" ? 18 : 6)) : null;
    if (!a.payTo) issues.push("payment option missing payTo");
    if (!atomic) issues.push("payment option missing amount");
    return { scheme: a.scheme, network: a.network, asset: a.asset, assetSymbol: known?.[0] ?? a.extra?.name ?? null, amountAtomic: atomic, priceUsd: usd, payTo: a.payTo, maxTimeoutSeconds: a.maxTimeoutSeconds };
  });
  const discoverable = !!(req?.extensions?.bazaar || accepts.some(a => a.outputSchema));
  if (!discoverable) issues.push("no bazaar discovery metadata (agents can't see input/output schema)");
  return { ...out, ok: issues.length === 0, isX402: true, x402Version: version, description: req?.resource?.description ?? accepts[0]?.description ?? null, options, discoverable, issues };
}

// ---------- app ----------
const app = new Hono();
const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR }))
  .register(NETWORK, new ExactEvmScheme());
server.registerExtension(bazaarResourceServerExtension);

const route = (description, input, inputSchema, example, price = PRICE) => ({
  accepts: { scheme: "exact", price, network: NETWORK, payTo: PAY_TO },
  description, mimeType: "application/json",
  extensions: declareDiscoveryExtension({ input, inputSchema, output: { example } }),
});

const ROUTES = {
  "GET /new-pools": route("Newly created liquidity pools on Base in the last N minutes (Uniswap v2/v3/v4, Aerodrome): token, quote, initial price, liquidity (USD where measurable), hooks, flags. For trading/sniper agents; pair with /token-risk before buying.",
    { minutes: 30, quote: "weth", limit: 25 },
    { type: "object", properties: { minutes: { type: "number", description: "Look-back window, 1-120 (default 30)" }, quote: { type: "string", enum: ["any", "weth", "usdc"], description: "Quote token filter (default any)" }, minLiquidityUsd: { type: "number", description: "Minimum USD liquidity (excludes v4 pools, whose liquidity is not measured)" }, limit: { type: "number", description: "Max pools, 1-100 (default 25)" } } },
    { ok: true, count: 25, pools: [{ dex: "uniswap-v4", token: { symbol: "XYZ" }, quote: "WETH", ageMinutes: 3, priceUsd: 0.00012, flags: ["custom-hooks"] }] }),
  "GET /cloud-prices": route("Live Azure cloud compute prices for agents comparing costs: filter by region, SKU substring (e.g. H100, A100, D4s), GPU-only, OS, consumption/spot/reservation. Returns hourly and monthly USD, sorted cheapest first.",
    { gpu: true, region: "eastus" },
    { type: "object", properties: { region: { type: "string", description: "Azure region, e.g. eastus, westeurope" }, sku: { type: "string", description: "SKU substring, e.g. H100, NC, D4s" }, gpu: { type: "boolean", description: "GPU VM families only" }, priceType: { type: "string", enum: ["Consumption", "Spot", "Reservation"] }, os: { type: "string", enum: ["linux", "windows"] }, maxResults: { type: "number", description: "1-100 (default 25)" } } },
    { ok: true, count: 25, cheapest: { sku: "Standard_NV4as_v4", region: "eastus", hourlyUsd: 0.233 } }, "$0.02"),
  "GET /fetch": route("Fetch any public web page and get clean, LLM-ready markdown: main content (article/main), title, description, language, absolute links, word count. Text/JSON/markdown URLs are returned as-is. SSRF-safe, 2 MB cap, no JS rendering.",
    { url: "https://example.com" },
    { type: "object", properties: { url: { type: "string", description: "http(s) URL to fetch" }, maxChars: { type: "number", description: "Truncate markdown to this many characters (default 50000)" } }, required: ["url"] },
    { ok: true, title: "Example Domain", markdown: "# Example Domain\n\nThis domain is for use in illustrative examples...", wordCount: 30, truncated: false }, "$0.004"),
  "GET /token-risk": route("Base ERC-20 scam/honeypot check before you buy: simulated sell into the main pool, owner powers (mint, blacklist, pause, fee changes, upgradeable proxy), ownership renounced, owner holdings, liquidity in USD across Uniswap v2/v3 + Aerodrome, LP burn, price. Returns verdict LOW_RISK/CAUTION/HIGH_RISK/AVOID with a 0-100 risk score.",
    { token: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
    { type: "object", properties: { token: { type: "string", description: "ERC-20 contract address on Base" } }, required: ["token"] },
    { ok: true, symbol: "AERO", verdict: "LOW_RISK", riskScore: 0, flags: [], liquidityUsd: 48832868, priceUsd: 0.8378, sellSimulation: { simulated: true, sellToPoolSucceeds: true } }, "$0.02"),
  "GET /tx": route("Explain any Base mainnet transaction in plain English: status, confirmations, fee, decoded ERC-20 transfers with symbols and amounts. Use it to verify a payment landed.",
    { hash: "0x98023b255a23cf26d93492a6c3c542247cea95fa201dc83ed3fa91d3b6fcb57f" },
    { type: "object", properties: { hash: { type: "string", description: "Base tx hash (0x + 64 hex)" } }, required: ["hash"] },
    { found: true, status: "success", confirmations: 12, feeEth: "0.0000021", summary: ["14.99 USDC from 0xabc… to 0x85d…"] }),
  "GET /wallet": route("Snapshot of a Base address: ETH balance, nonce, EOA vs contract (incl. EIP-7702), and balances of major tokens (USDC, USDbC, WETH, cbBTC, cbETH, DAI, EURC, AERO).",
    { address: "0x4200000000000000000000000000000000000006" },
    { type: "object", properties: { address: { type: "string", description: "0x address" } }, required: ["address"] },
    { address: "0x…", ethBalance: "0.42", nonce: 17, type: "EOA", tokenBalances: { USDC: "120.5" } }, "$0.005"),
  "GET /x402check": route("Health-check any x402 paid endpoint before paying: reachable, latency, x402 version, price in USD, network, payTo, discovery metadata, and spec issues.",
    { url: "https://example.com/paid-endpoint", method: "GET" },
    { type: "object", properties: { url: { type: "string", description: "https URL of an x402 endpoint" }, method: { type: "string", enum: ["GET", "POST"], description: "HTTP method the endpoint uses (default GET)" } }, required: ["url"] },
    { ok: true, isX402: true, latencyMs: 180, options: [{ network: "eip155:8453", priceUsd: 0.01 }], issues: [] }),
};
const ORIGIN = "https://baselens.imac2014ville.workers.dev";
const TAGS = { "/new-pools": ["crypto", "base", "trading", "dex", "new-tokens"], "/cloud-prices": ["cloud", "pricing", "gpu", "azure", "finops"], "/fetch": ["web", "scrape", "markdown", "llm"], "/token-risk": ["crypto", "base", "security", "trading", "honeypot"],
  "/tx": ["crypto", "base", "payments", "explorer"], "/wallet": ["crypto", "base", "wallet", "balances"], "/x402check": ["x402", "monitoring", "devtools"] };
for (const k of Object.keys(ROUTES)) {
  const r = ROUTES[k], path = k.split(" ")[1];
  ROUTES["POST " + path] = { ...r, extensions: declareDiscoveryExtension({ bodyType: "json", input: r.extensions.bazaar.info.input.queryParams,
    inputSchema: r.extensions.bazaar.schema.properties.input.properties.queryParams, output: { example: r.extensions.bazaar.info.output.example } }) };
}

for (const [k, r] of Object.entries(ROUTES)) {
  const path = k.split(" ")[1];
  Object.assign(r, { resource: ORIGIN + path, serviceName: "BaseLens", tags: TAGS[path], iconUrl: ORIGIN + "/favicon.svg" });
}

// Workers forbid I/O at global scope and sharing promises across requests, so the
// facilitator sync runs inside whichever request gets there first, until it succeeds.
let paywall, synced = false;
app.use(async (c, next) => {
  if (c.env?.DEV_FREE === "1") return next(); // local testing only (wrangler dev --var DEV_FREE:1); never set in production
  if (!synced && ROUTES[`${c.req.method} ${c.req.path}`]) { await server.initialize(); synced = true; }
  paywall ??= paymentMiddleware(ROUTES, server, undefined, undefined, false);
  return paywall(c, next);
});

// Params come from the query string (GET) or a JSON body (POST).
const params = async c => c.req.method === "POST" ? await c.req.json().catch(() => ({})) : c.req.query();
app.on(["GET", "POST"], "/tx", async c => { const h = (await params(c)).hash; return isHash(h) ? c.json(await explainTx(h)) : c.json({ error: "pass ?hash=0x…(64 hex)" }, 400); });
const num = (v, d) => (v === undefined || v === "" || isNaN(Number(v)) ? d : Number(v));
const bool = v => v === true || v === "true" || v === "1";
app.on(["GET", "POST"], "/new-pools", async c => { const p = await params(c);
  return c.json(await newPools({ minutes: Math.min(Math.max(num(p.minutes, 30), 1), 120), quote: String(p.quote || "any").toLowerCase(), minLiquidityUsd: num(p.minLiquidityUsd, 0), limit: Math.min(Math.max(num(p.limit, 25), 1), 100) })); });
app.on(["GET", "POST"], "/cloud-prices", async c => { const p = await params(c);
  return c.json(await cloudPrices({ ...p, gpu: bool(p.gpu), maxResults: Math.min(Math.max(num(p.maxResults, 25), 1), 100) })); });
app.on(["GET", "POST"], "/fetch", async c => { const p = await params(c); return p.url ? c.json(await fetchMarkdown(p.url, { maxChars: Math.min(Number(p.maxChars) || 50000, 200000) })) : c.json({ error: "pass url=https://…" }, 400); });
app.on(["GET", "POST"], "/token-risk", async c => { const t = (await params(c)).token; return isAddr(t) ? c.json(await tokenRisk(t)) : c.json({ error: "pass token=0x…(40 hex)" }, 400); });
app.on(["GET", "POST"], "/wallet", async c => { const a = (await params(c)).address; return isAddr(a) ? c.json(await walletSnapshot(a)) : c.json({ error: "pass ?address=0x…(40 hex)" }, 400); });
app.on(["GET", "POST"], "/x402check", async c => { const p = await params(c); return p.url ? c.json(await x402Check(p.url, p.method)) : c.json({ error: "pass ?url=https://…" }, 400); });

const DOCS = {
  name: "BaseLens", description: "Pay-per-call tools for AI agents: Base token scam check, new Base pools feed, Azure cloud/GPU prices, web page to markdown, tx explainer, wallet snapshot, x402 endpoint checker. No API key, no signup: pay USDC on Base per call via x402.",
  payment: { protocol: "x402 v2", network: NETWORK, asset: "USDC", price: PRICE, payTo: PAY_TO },
  endpoints: [
    { method: "POST", path: "/new-pools {minutes, quote}", price: "$0.01", what: "New Base pools (Uni v2/v3/v4, Aerodrome)" },
    { method: "POST", path: "/cloud-prices {gpu, region, sku}", price: "$0.02", what: "Azure compute prices, cheapest first" },
    { method: "POST", path: "/fetch {url}", price: "$0.004", what: "Web page to clean markdown" },
    { method: "POST", path: "/token-risk {token}", price: "$0.02", what: "Base token scam/honeypot check" },
    { method: "GET", path: "/tx?hash=0x…", what: "Explain a Base transaction / verify a payment" },
    { method: "GET", path: "/wallet?address=0x…", what: "Base wallet snapshot with major token balances" },
    { method: "GET", path: "/x402check?url=https://…&method=GET|POST", what: "Health-check an x402 endpoint before paying it" },
  ],
  howToPay: "Call any endpoint; you get HTTP 402 with payment requirements. Use an x402 client (e.g. @x402/fetch, x402-axios, or an MCP x402 wallet) to sign and retry.",
};
app.get("/", c => c.json(DOCS));
app.get("/openapi.json", c => {
  const paths = {};
  for (const [k, r] of Object.entries(ROUTES)) {
    const [method, path] = k.split(" "), m = method.toLowerCase();
    const info = r.extensions.bazaar.info, schema = r.extensions.bazaar.schema.properties.input.properties;
    const inSchema = schema.queryParams || schema.body;
    const op = {
      operationId: path.slice(1) + (m === "post" ? "Post" : "Get"), summary: r.description.split(":")[0], description: r.description, tags: ["Base"],
      "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: r.accepts.price.slice(1) }, protocols: [{ x402: {} }] },
      responses: { 200: { description: "Successful response", content: { "application/json": { schema: { type: "object" }, example: info.output.example } } }, 402: { description: "Payment Required" } },
    };
    if (m === "post") op.requestBody = { required: true, content: { "application/json": { schema: inSchema } } };
    else op.parameters = Object.entries(inSchema.properties).map(([name, s]) => ({ name, in: "query", required: (inSchema.required || []).includes(name), schema: s, description: s.description }));
    (paths[path] ??= {})[m] = op;
  }
  return c.json({ openapi: "3.1.0", info: { title: "BaseLens", version: "1.1.0", contact: { name: "BaseLens", url: "https://github.com/Imac2014Ville/baselens" }, description: DOCS.description,
    "x-guidance": "Agent utilities paid per call in USDC on Base via x402. POST /new-pools {minutes, quote} ($0.01) lists newly created Base pools for trading agents. POST /cloud-prices {gpu, region, sku} ($0.02) returns Azure compute prices, cheapest first. POST /fetch {url} ($0.004) turns any web page into clean markdown. POST /token-risk {token} ($0.02) is a Base token scam/honeypot check with a verdict and risk score. Other Base tools ($0.005-0.01): POST /tx {hash} explains a transaction and verifies payments (status, confirmations, decoded ERC-20 transfers). POST /wallet {address} returns ETH + major token balances and account type. POST /x402check {url, method} health-checks another x402 endpoint (price, network, schema issues) before you pay it. GET with query params also works." },
    servers: [{ url: new URL(c.req.url).origin }], paths });
});
app.get("/.well-known/x402", c => c.json({ version: 1, resources: [...new Set(Object.keys(ROUTES).map(k => ORIGIN + k.split(" ")[1]))] }));
app.get("/health", c => c.json({ ok: true }));
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0052ff"/><circle cx="28" cy="28" r="13" fill="none" stroke="#fff" stroke-width="6"/><path d="M38 38l12 12" stroke="#fff" stroke-width="7" stroke-linecap="round"/></svg>`;
app.get("/favicon.ico", c => c.body(ICON, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }));
app.get("/favicon.svg", c => c.body(ICON, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }));

export { explainTx, walletSnapshot, x402Check };
export default app;
