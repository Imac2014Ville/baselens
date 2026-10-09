// Static landing page, llms.txt, robots.txt and sitemap.xml for BaseLens.
const ORIGIN = "https://baselens.imac2014ville.workers.dev";
const GH = "https://github.com/Imac2014Ville/baselens";
const DEPVET = "https://depvet.imac2014ville.workers.dev";
const DESC = "BaseLens: pay-per-call Base chain and web tools for AI agents. Token scam check, new pools, tx explainer, wallet snapshot, Azure GPU prices, web-to-markdown. USDC on Base via x402, no API key.";

export const TOOLS = [
  { path: "/token-risk", price: "$0.02", what: "Base ERC-20 scam/honeypot check: simulated sell, owner powers, liquidity, LP burn; verdict + 0-100 risk score.", q: "token=0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
  { path: "/new-pools", price: "$0.01", what: "Newly created Base liquidity pools (Uniswap v2/v3/v4, Aerodrome) with price, liquidity and flags.", q: "minutes=30&quote=weth" },
  { path: "/fetch", price: "$0.004", what: "Any public web page as clean, LLM-ready markdown. SSRF-safe, 2 MB cap.", q: "url=https://example.com" },
  { path: "/cloud-prices", price: "$0.02", what: "Live Azure VM/GPU prices by region and SKU, cheapest first.", q: "gpu=true&region=eastus" },
  { path: "/tx", price: "$0.01", what: "Explain a Base transaction in plain English; verify a payment landed.", q: "hash=0x98023b255a23cf26d93492a6c3c542247cea95fa201dc83ed3fa91d3b6fcb57f" },
  { path: "/wallet", price: "$0.005", what: "Base address snapshot: ETH, nonce, EOA vs contract, major token balances.", q: "address=0x4200000000000000000000000000000000000006" },
  { path: "/x402check", price: "$0.01", what: "Health-check any x402 endpoint before paying: latency, price, network, spec issues.", q: "url=https://example.com/paid-endpoint" },
];

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function landingHtml() {
  const rows = TOOLS.map(t => `<tr><td><code>${t.path}</code></td><td>${t.price}</td><td>${esc(t.what)}</td></tr>`).join("");
  const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "WebAPI", name: "BaseLens", description: DESC, url: ORIGIN + "/", documentation: ORIGIN + "/openapi.json" });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BaseLens — pay-per-call Base &amp; web tools for AI agents</title>
<meta name="description" content="${DESC}">
<link rel="canonical" href="${ORIGIN}/">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website"><meta property="og:site_name" content="BaseLens">
<meta property="og:title" content="BaseLens — pay-per-call Base &amp; web tools for AI agents">
<meta property="og:description" content="${DESC}"><meta property="og:url" content="${ORIGIN}/">
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="BaseLens — pay-per-call Base &amp; web tools for AI agents">
<meta name="twitter:description" content="${DESC}">
<script type="application/ld+json">${ld}</script>
<style>
:root{--bg:#fff;--fg:#14171f;--mut:#5b6472;--card:#f4f6fa;--bd:#dfe3ea;--ac:#0052ff}
@media(prefers-color-scheme:dark){:root{--bg:#0d1017;--fg:#e6e9ef;--mut:#98a1b0;--card:#161b24;--bd:#262d3a;--ac:#6b9bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}h1{font-size:2rem;margin:.2em 0}h2{margin-top:2.2em;font-size:1.3rem}
p.lead{color:var(--mut);font-size:1.1rem}a{color:var(--ac)}code,pre{font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:12px 14px;overflow-x:auto}
code{background:var(--card);padding:1px 5px;border-radius:4px}pre code{background:none;padding:0}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--bd);vertical-align:top}
.links a{display:inline-block;margin:0 14px 8px 0}.tbl{overflow-x:auto}footer{margin-top:3em;color:var(--mut);font-size:.9rem}
</style></head><body><main>
<header><h1>BaseLens</h1><p class="lead">Pay-per-call Base chain and web tools for AI agents. No API key, no signup: pay a fraction of a cent in USDC on Base per request, over the <a href="https://x402.org">x402</a> protocol.</p>
<p class="links"><a href="/openapi.json">OpenAPI</a><a href="https://www.x402scan.com/">x402scan</a><a href="${GH}">GitHub</a><a href="${DEPVET}">DepVet (sister service)</a><a href="/llms.txt">llms.txt</a></p></header>
<h2>What it is</h2>
<p>BaseLens is a set of small HTTP tools that agents call when they need on-chain facts or a clean web page. Each endpoint answers an unpaid request with <code>HTTP 402</code> and machine-readable payment requirements; an x402 client signs a USDC authorization and retries. Failed lookups are not charged.</p>
<h2>Tools</h2>
<div class="tbl"><table><thead><tr><th>Endpoint</th><th>Price</th><th>What you get</th></tr></thead><tbody>${rows}</tbody></table></div>
<p>Every endpoint accepts <code>GET</code> with query params or <code>POST</code> with a JSON body.</p>
<h2>Example: the 402 flow with curl</h2>
<pre><code>$ curl -i "${ORIGIN}/token-risk?token=0x940181a94A35A4569E4529A3CDfB74e38FD98631"
HTTP/2 402
payment-required: eyJ4NDAyVmVyc2lvbiI6Mi4uLn0=   # base64 JSON: scheme "exact", network eip155:8453,
                                                  # asset USDC, amount 20000 (= $0.02), payTo 0x5b60...B88
# An x402 client signs the payment, then retries with a PAYMENT-SIGNATURE header:
$ curl "${ORIGIN}/token-risk?token=0x9401..." -H "PAYMENT-SIGNATURE: &lt;signed payload&gt;"
{"ok":true,"symbol":"AERO","verdict":"LOW_RISK","riskScore":0,"flags":[],"liquidityUsd":48832868,"priceUsd":0.8378}</code></pre>
<h2>Example: JavaScript with @x402/fetch</h2>
<pre><code>import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.PRIVATE_KEY); // wallet holding USDC on Base
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(signer) }],
});
const res = await pay("${ORIGIN}/token-risk?token=0x940181a94A35A4569E4529A3CDfB74e38FD98631");
console.log(await res.json()); // { verdict: "LOW_RISK", riskScore: 0, ... }</code></pre>
<h2>Links</h2>
<ul><li><a href="/openapi.json">/openapi.json</a>: machine-readable spec with prices</li><li><a href="/.well-known/x402">/.well-known/x402</a>: resource list</li>
<li><a href="https://www.x402scan.com/">x402scan</a>: x402 service directory</li><li><a href="${GH}">Source on GitHub</a></li>
<li><a href="${DEPVET}">DepVet</a>: sister pay-per-call service for dependency vetting</li></ul>
<footer>Payments settle in USDC on Base (eip155:8453) to 0x5b60a748582169C1cD3799B09406aFe99F174B88.</footer>
</main></body></html>`;
}

export function llmsTxt() {
  return `# BaseLens

> Pay-per-call Base chain and web tools for AI agents. No API key or signup: each call is paid in USDC on Base via the x402 protocol (HTTP 402 -> sign -> retry).

Base URL: ${ORIGIN}
OpenAPI: ${ORIGIN}/openapi.json
Source: ${GH}
Sister service: DepVet, ${DEPVET}

## Endpoints (GET with query params, or POST with JSON body)
${TOOLS.map(t => `- ${t.path} (${t.price}): ${t.what} Example: ${t.path}?${t.q}`).join("\n")}

## How to pay
Call an endpoint without payment to receive HTTP 402 with a PAYMENT-REQUIRED header (base64 JSON: scheme exact, network eip155:8453, asset USDC). Use an x402 client (@x402/fetch, x402-axios, or an MCP x402 wallet) to sign and retry. Malformed requests return 400 and lookups that fail return non-2xx, so they are not charged.
`;
}

export const robotsTxt = () => `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`;
export const sitemapXml = () => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${["/", "/openapi.json", "/llms.txt"].map(p => `<url><loc>${ORIGIN}${p}</loc></url>`).join("\n")}\n</urlset>\n`;
