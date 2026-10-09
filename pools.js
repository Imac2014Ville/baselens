// New liquidity pools on Base (Uniswap V2/V3, Aerodrome) from factory event logs.
const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"];
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const FACTORIES = [
  { dex: "uniswap-v2", addr: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", topic: "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9" },
  { dex: "uniswap-v3", addr: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", topic: "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118" },
  { dex: "aerodrome", addr: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", topic: "0x2128d88d14c80cb081c1252a5acff7a264671bf199ce226b53788fb26065005e" },
  { dex: "uniswap-v4", addr: "0x498581fF718922c3f8e6A244956aF099B2652b2b", topic: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438" },
];
const MAX_CANDIDATES = 300;
const BATCH = 50;
const LOG_CHUNK = 2000;

async function post(body) {
  let last;
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(RPCS[a % RPCS.length], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      const arr = Array.isArray(j) ? j : [j];
      if (arr.some(o => o.error && /rate|limit|too many|range|exceed/i.test(o.error.message || "") || (o.error && o.error.code === -32011))) { last = new Error("rpc limited"); }
      else return j;
    } catch (e) { last = e; }
    await new Promise(ok => setTimeout(ok, 300 * (a + 1)));
  }
  throw last || new Error("Base RPC unavailable");
}
async function rpc(method, params) {
  let j;
  for (let a = 0; a < 4; a++) {
    j = await post({ jsonrpc: "2.0", id: 1, method, params });
    if (j && j.result != null) return j.result;
    await new Promise(ok => setTimeout(ok, 300 * (a + 1)));
  }
  throw new Error((j && j.error && j.error.message) || "rpc returned no result");
}
async function batch(calls) { // -> array of {result|error}, in order
  const out = [];
  const chunks = [];
  for (let i = 0; i < calls.length; i += BATCH) chunks.push(calls.slice(i, i + BATCH));
  const res = await Promise.all(chunks.map(async ch => {
    const j = await post(ch.map(([method, params], id) => ({ jsonrpc: "2.0", id, method, params })));
    const arr = Array.isArray(j) ? j : [];
    return ch.map((_, k) => arr.find(o => Number(o.id) === k) || { error: { message: "missing" } });
  }));
  for (const r of res) out.push(...r);
  return out;
}
const pad = a => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const addrAt = (data, i) => "0x" + data.slice(2 + 64 * i + 24, 2 + 64 * (i + 1)).toLowerCase();
const topicAddr = t => "0x" + t.slice(26).toLowerCase();
const big = h => (h && h !== "0x" ? BigInt(h) : 0n);
function decStr(h) {
  if (!h || h === "0x" || h.length < 130) return null;
  try {
    const hex = h.slice(2);
    if (hex.length === 64) { // bytes32
      return Buffer_free(hex);
    }
    const len = parseInt(hex.slice(64, 128), 16);
    const bytes = hex.slice(128, 128 + len * 2).match(/../g) || [];
    return new TextDecoder().decode(new Uint8Array(bytes.map(b => parseInt(b, 16)))).replace(/[\u0000-\u001f]/g, "").slice(0, 64);
  } catch { return null; }
}
function Buffer_free(hex) {
  const bytes = (hex.match(/../g) || []).map(b => parseInt(b, 16)).filter(b => b);
  return new TextDecoder().decode(new Uint8Array(bytes));
}
const numOrNull = (x, d) => (x === undefined ? d : x);

export async function newPools({ minutes = 30, quote = "any", minLiquidityUsd = 0, limit = 25 } = {}) {
  minutes = Math.max(1, Math.min(120, Number(minutes) || 30));
  limit = Math.max(1, Math.min(100, Number(limit) || 25));
  minLiquidityUsd = Number(minLiquidityUsd) || 0;
  quote = String(quote || "any").toLowerCase();
  if (!["any", "weth", "usdc"].includes(quote)) quote = "any";

  const latestBlk = await rpc("eth_getBlockByNumber", ["latest", false]);
  const toBlock = parseInt(latestBlk.number, 16);
  const latestTs = parseInt(latestBlk.timestamp, 16);
  const fromBlock = Math.max(0, toBlock - Math.ceil((minutes * 60) / 2));

  // 1. factory logs (chunked)
  const ranges = [];
  for (let s = fromBlock; s <= toBlock; s += LOG_CHUNK) ranges.push([s, Math.min(toBlock, s + LOG_CHUNK - 1)]);
  const logCalls = [];
  for (const f of FACTORIES) for (const [s, e] of ranges)
    logCalls.push(["eth_getLogs", [{ address: f.addr, topics: [f.topic], fromBlock: "0x" + s.toString(16), toBlock: "0x" + e.toString(16) }]]);
  const logRes = await batch(logCalls);
  if (logRes.some(r => r.error)) throw new Error("eth_getLogs failed: " + (logRes.find(r => r.error).error.message));
  let cands = [];
  logCalls.forEach((c, i) => {
    const f = FACTORIES.find(x => x.addr === c[1][0].address);
    for (const l of logRes[i].result || []) {
      let pool;
      if (f.dex === "uniswap-v4") {
        const sq = BigInt("0x" + l.data.slice(2 + 64 * 3, 2 + 64 * 4));
        const hooks = addrAt(l.data, 2);
        cands.push({ dex: f.dex, pool: l.topics[1], poolId: l.topics[1], hooks, sqrt: sq, createdBlock: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16),
          t0: topicAddr(l.topics[2]), t1: topicAddr(l.topics[3]), extra: { poolId: l.topics[1], fee: parseInt(l.data.slice(2, 66), 16), hooks } });
        continue;
      }
      if (f.dex === "uniswap-v2") pool = addrAt(l.data, 0);
      else if (f.dex === "uniswap-v3") pool = addrAt(l.data, 1);
      else pool = addrAt(l.data, 0);
      cands.push({ dex: f.dex, pool, createdBlock: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16),
        t0: topicAddr(l.topics[1]), t1: topicAddr(l.topics[2]),
        extra: f.dex === "uniswap-v3" ? { fee: parseInt(l.topics[3], 16) } : f.dex === "aerodrome" ? { stable: big(l.topics[3]) === 1n } : {} });
    }
  });
  cands.sort((a, b) => b.createdBlock - a.createdBlock || b.logIndex - a.logIndex);
  const truncated = cands.length > MAX_CANDIDATES;
  cands = cands.slice(0, MAX_CANDIDATES);

  // 2. classify quote side
  for (const c of cands) {
    let q, t;
    const Z = "0x0000000000000000000000000000000000000000";
    if (c.dex === "uniswap-v4") { if (c.t0 === Z) { c.native = true; c.t0 = WETH; } }
    if (c.t0 === WETH || c.t1 === WETH) { q = WETH; t = c.t0 === WETH ? c.t1 : c.t0; }
    else if (c.t0 === USDC || c.t1 === USDC) { q = USDC; t = c.t0 === USDC ? c.t1 : c.t0; }
    else { q = c.t0; t = c.t1; c.other = true; }
    c.q = q; c.tok = t;
  }
  if (quote === "weth") cands = cands.filter(c => c.q === WETH);
  if (quote === "usdc") cands = cands.filter(c => c.q === USDC);

  // 3. reserves + ETH price
  const bal = d => ["eth_call", [{ to: d.q, data: "0x70a08231" + pad(d.pool) }, "latest"]];
  const balIdx = cands.map((c, i) => (c.dex === "uniswap-v4" ? -1 : i)).filter(i => i >= 0);
  const calls = balIdx.map(i => bal(cands[i]));
  calls.push(["eth_call", [{ to: ETH_USD_FEED, data: "0x50d25bcd" }, "latest"]]);
  const res = await batch(calls);
  const ethUsd = Number(big(res[res.length - 1].result)) / 1e8 || 0;
  const decCache = { [WETH]: 18, [USDC]: 6 };
  const needDec = [...new Set(cands.filter(c => c.other).map(c => c.q))];
  if (needDec.length) {
    const dr = await batch(needDec.map(a => ["eth_call", [{ to: a, data: "0x313ce567" }, "latest"]]));
    needDec.forEach((a, i) => { decCache[a] = dr[i].result && dr[i].result !== "0x" ? Number(big(dr[i].result)) : 18; });
  }
  const resOf = {}; balIdx.forEach((ci, k) => { resOf[ci] = res[k]; });
  cands.forEach((c, i) => {
    if (c.dex === "uniswap-v4") { c.rawQ = null; c.quoteReserve = null; c.liquidityUsd = null; return; }
    const raw = big(resOf[i].result);
    c.rawQ = raw;
    c.quoteReserve = Number(raw) / 10 ** (decCache[c.q] ?? 18);
    c.liquidityUsd = c.q === WETH ? c.quoteReserve * ethUsd * 2 : c.q === USDC ? c.quoteReserve * 2 : null;
  });
  // V3 pools with no liquidity check: balance 0 -> flagged
  let out = cands.filter(c => minLiquidityUsd > 0 ? (c.liquidityUsd ?? 0) >= minLiquidityUsd : true);
  const total = out.length;
  out = out.slice(0, limit);

  // 4. metadata for tokens + (exact) timestamps
  const tokens = [...new Set(out.flatMap(c => [c.tok, ...(c.other ? [c.q] : [])]))];
  const metaCalls = tokens.flatMap(a => ["0x95d89b41", "0x06fdde03", "0x313ce567"].map(d => ["eth_call", [{ to: a, data: d }, "latest"]]));
  const blocks = [...new Set(out.map(c => c.createdBlock))];
  const blkCalls = blocks.map(b => ["eth_getBlockByNumber", ["0x" + b.toString(16), false]]);
  const mr = await batch([...metaCalls, ...blkCalls]);
  const meta = {};
  tokens.forEach((a, i) => {
    const [s, n, d] = mr.slice(i * 3, i * 3 + 3);
    meta[a] = { address: a, symbol: decStr(s.result), name: decStr(n.result), decimals: d.result && d.result !== "0x" ? Number(big(d.result)) : null };
  });
  const ts = {};
  blocks.forEach((b, i) => { const r = mr[metaCalls.length + i].result; ts[b] = r ? parseInt(r.timestamp, 16) : latestTs - (toBlock - b) * 2; });

  const now = Math.floor(Date.now() / 1000);
  const pools = out.map(c => {
    const flags = [];
    if (c.dex === "uniswap-v4") { flags.push("v4-liquidity-unknown"); if (c.hooks !== "0x0000000000000000000000000000000000000000") flags.push("custom-hooks"); }
    if (c.rawQ === 0n) flags.push("no-liquidity");
    if (c.q !== WETH && c.q !== USDC) flags.push("quote-not-weth-or-usdc");
    if (!meta[c.tok].symbol) flags.push("no-symbol");
    if (c.liquidityUsd !== null && c.rawQ !== null && c.rawQ > 0n && c.liquidityUsd < 1000) flags.push("low-liquidity");
    const qname = c.q === WETH ? "WETH" : c.q === USDC ? "USDC" : (meta[c.q]?.symbol || "OTHER");
    let priceUsd;
    if (c.dex === "uniswap-v4" && c.sqrt > 0n && (c.q === WETH || c.q === USDC)) {
      const dT = meta[c.tok].decimals ?? 18, dQ = decCache[c.q];
      const p = (Number(c.sqrt) / 2 ** 96) ** 2; // token1 raw per token0 raw
      const qPerTok = (c.tok === c.t0 ? p : 1 / p) * 10 ** (dT - dQ);
      priceUsd = qPerTok * (c.q === WETH ? ethUsd : 1);
    }
    return {
      dex: c.dex, pool: c.pool, ...c.extra, createdBlock: c.createdBlock,
      createdAt: new Date(ts[c.createdBlock] * 1000).toISOString(),
      ageMinutes: Math.round(((now - ts[c.createdBlock]) / 60) * 10) / 10,
      token: meta[c.tok],
      quote: { address: c.q, symbol: qname, decimals: decCache[c.q] ?? 18 },
      quoteReserve: c.quoteReserve,
      liquidityUsd: c.liquidityUsd === null ? null : Math.round(c.liquidityUsd * 100) / 100,
      ...(priceUsd !== undefined ? { priceUsd } : {}),
      flags,
    };
  });
  return { ok: true, chain: "base", fromBlock, toBlock, minutes, count: pools.length, totalMatched: total,
    ...(truncated ? { truncated: true } : {}), pools, note: "Run /token-risk on any token before buying" };
}
