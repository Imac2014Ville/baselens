import { keccak_256 } from "@noble/hashes/sha3";
// Token risk check for Base ERC-20s, built purely from on-chain reads (public Base RPC).
const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base"];
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70"; // Chainlink ETH/USD on Base
const UNI_V2_FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6";
const UNI_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const AERO_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const DEAD = ["0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000"];
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PROBE = "0x00000000000000000000000000000000b10c4e55"; // fake holder used for the sell simulation

// Selectors whose presence in bytecode signals owner powers over holders.
const POWERS = {
  "40c10f19": "mint(address,uint256)", "a0712d68": "mint(uint256)", "8456cb59": "pause()",
  "f9f92be4": "blacklist(address)", "44337ea1": "addToBlacklist(address)", "153b0d1e": "setBlacklist(address,bool)",
  "455a4396": "blacklistAddress(address,bool)", "9c0db5f3": "setBots(address[],bool)",
  "69fe0e2d": "setFee(uint256)", "0b78f9c0": "setFees(uint256,uint256)", "c647b20e": "setTaxes(uint256,uint256)",
  "0cc835a3": "setBuyFee(uint256)", "8b4cee08": "setSellFee(uint256)",
  "ec28438a": "setMaxTxAmount(uint256)", "ea1644d5": "setMaxWalletSize(uint256)",
  "c2e5ec04": "setTradingEnabled(bool)", "8a8c523c": "enableTrading()", "c9567bf9": "openTrading()",
  "437823ec": "excludeFromFee(address)", "3659cfe6": "upgradeTo(address)",
};
const SEVERE = new Set(["40c10f19", "a0712d68", "f9f92be4", "44337ea1", "153b0d1e", "455a4396", "9c0db5f3", "8456cb59", "3659cfe6"]);

async function rpcBatch(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 10) {
    const chunk = calls.slice(i, i + 10);
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(RPCS[(attempt + i / 10) % RPCS.length], { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(chunk.map(([method, params], id) => ({ jsonrpc: "2.0", id, method, params }))) });
      res = await r.json().catch(() => null);
      if (Array.isArray(res)) res = res.map(o => ({ ...o, id: Number(o.id) }));
      const limited = Array.isArray(res) && res.some(o => o.error && /rate|limit|too many/i.test(o.error.message || "") );
      if (Array.isArray(res) && !limited) break;
      if (limited && attempt === 3) break;
      await new Promise(ok => setTimeout(ok, 400 * (attempt + 1))); // public RPC rate limit
    }
    if (!Array.isArray(res)) throw new Error("Base RPC unavailable (rate limited); retry shortly");
    out.push(...chunk.map((_, j) => res.find(o => o.id === j) || {}));
  }
  return out; // full JSON-RPC objects so callers can see errors (reverts)
}
const call = (to, data, block = "latest", override) => ["eth_call", override ? [{ to, data }, block, override] : [{ to, data }, block]];
const pad = a => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const big = h => (h && h !== "0x" ? BigInt(h) : 0n);
const word = (h, i = 0) => "0x" + (h || "").slice(2 + 64 * i, 2 + 64 * (i + 1));
const addr = h => (h && h.length >= 66 ? "0x" + h.slice(26, 66) : null);
const ZERO = "0x0000000000000000000000000000000000000000";
const hexText = h => new TextDecoder().decode(Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16)));
function str(hex) {
  if (!hex || hex === "0x") return null;
  const b = hex.slice(2);
  if (b.length === 64) return hexText(b).replace(/\0+$/, "") || null;
  try { const len = parseInt(b.slice(64, 128), 16); return hexText(b.slice(128, 128 + len * 2)); } catch { return null; }
}
const units = (v, d) => Number(v) / 10 ** d;

// PUSH4 operands in runtime bytecode = the function selectors the contract dispatches on.
function selectors(code) {
  const s = new Set(), b = code.slice(2);
  for (let i = 0; i < b.length; i += 2) {
    const op = parseInt(b.slice(i, i + 2), 16);
    if (op === 0x63) s.add(b.slice(i + 2, i + 10));
    if (op >= 0x60 && op <= 0x7f) i += (op - 0x5f) * 2;
  }
  return s;
}

// Find the balanceOf mapping slot (solidity: keccak(holder . slot)) so we can fake a balance via state override.
function keccak(hex) {
  const bytes = Uint8Array.from(hex.match(/../g), x => parseInt(x, 16));
  return "0x" + [...keccak_256(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sellSimulation(token, pool, decimals) {
  const amount = 10n ** BigInt(decimals) * 1000n;
  const valueHex = "0x" + amount.toString(16).padStart(64, "0");
  for (const slot of [0, 1, 2, 3, 4, 5, 6, 51, 101, 9, 10]) {
    const key = keccak(pad(PROBE) + slot.toString(16).padStart(64, "0"));
    const override = { [token]: { stateDiff: { [key]: valueHex } } };
    const [bal] = await rpcBatch([call(token, "0x70a08231" + pad(PROBE), "latest", override)]);
    if (big(bal.result) !== amount) continue;
    const [tx] = await rpcBatch([["eth_call", [{ from: PROBE, to: token, data: "0xa9059cbb" + pad(pool) + amount.toString(16).padStart(64, "0") }, "latest", override]]]);
    if (tx.error) return { simulated: true, sellToPoolSucceeds: false, revertReason: (tx.error.message || "reverted").slice(0, 160) };
    return { simulated: true, sellToPoolSucceeds: true };
  }
  return { simulated: false, note: "balance storage layout not standard; sell simulation skipped" };
}

export { rpcBatch };
export async function tokenRisk(token) {
  token = token.toLowerCase();
  const [code, implSlot, name, symbol, decimals, supply, owner, getOwner, ethUsd] = await rpcBatch([
    ["eth_getCode", [token, "latest"]], ["eth_getStorageAt", [token, EIP1967_IMPL, "latest"]],
    call(token, "0x06fdde03"), call(token, "0x95d89b41"), call(token, "0x313ce567"), call(token, "0x18160ddd"),
    call(token, "0x8da5cb5b"), call(token, "0x893d20e8"), call(ETH_USD_FEED, "0x50d25bcd"),
  ]);
  if (!code.result || code.result === "0x") return { ok: false, token, error: "no contract at this address on Base" };
  if (decimals.error || supply.error) return { ok: false, token, error: "not an ERC-20 (decimals/totalSupply call failed)" };

  const dec = Number(big(decimals.result)), total = big(supply.result);
  const ethPrice = units(big(ethUsd.result), 8);
  const impl = addr(implSlot.result);
  const isProxy = !!impl && impl !== ZERO;
  let runtime = code.result;
  if (isProxy) { const [ic] = await rpcBatch([["eth_getCode", [impl, "latest"]]]); runtime = ic.result || runtime; }
  const sels = selectors(runtime);
  const powers = Object.entries(POWERS).filter(([s]) => sels.has(s)).map(([, n]) => n);
  const ownerAddr = addr(owner.result) || addr(getOwner.result);
  const renounced = !ownerAddr || ownerAddr === ZERO || DEAD.includes(ownerAddr);

  // Pools: Uniswap V2, Uniswap V3 (4 fee tiers), Aerodrome (volatile + stable), each vs WETH and USDC.
  const quotes = [WETH, USDC];
  const lookups = [];
  for (const q of quotes) {
    lookups.push(["uniswap-v2", q, call(UNI_V2_FACTORY, "0xe6a43905" + pad(token) + pad(q))]);
    for (const fee of [100, 500, 3000, 10000]) lookups.push([`uniswap-v3-${fee}`, q, call(UNI_V3_FACTORY, "0x1698ee82" + pad(token) + pad(q) + fee.toString(16).padStart(64, "0"))]);
    for (const st of [0, 1]) lookups.push([st ? "aerodrome-stable" : "aerodrome-volatile", q, call(AERO_FACTORY, "0x79bc57d5" + pad(token) + pad(q) + st.toString(16).padStart(64, "0"))]);
  }
  const found = (await rpcBatch(lookups.map(l => l[2]))).map((r, i) => ({ dex: lookups[i][0], quote: lookups[i][1], pool: addr(r.result) }))
    .filter(p => p.pool && p.pool !== ZERO);
  const balCalls = found.flatMap(p => [call(p.quote, "0x70a08231" + pad(p.pool)), call(token, "0x70a08231" + pad(p.pool))]);
  // LP burn check for V2-style pools: LP tokens held by dead addresses / LP supply.
  const lpCalls = found.filter(p => p.dex === "uniswap-v2" || p.dex.startsWith("aerodrome")).flatMap(p => [
    call(p.pool, "0x18160ddd"), ...DEAD.map(d => call(p.pool, "0x70a08231" + pad(d)))]);
  const ownerCall = !renounced ? [call(token, "0x70a08231" + pad(ownerAddr))] : [];
  const deadCalls = DEAD.map(d => call(token, "0x70a08231" + pad(d)));
  const res = await rpcBatch([...balCalls, ...lpCalls, ...ownerCall, ...deadCalls]);

  // V3 prices come from slot0 (balances are not 50/50 in concentrated pools).
  const v3 = found.filter(p => p.dex.startsWith("uniswap-v3"));
  const slot0 = v3.length ? await rpcBatch(v3.map(p => call(p.pool, "0x3850c7bd"))) : [];
  const qDec = q => (q === WETH ? 18 : 6), qUsdPer = q => (q === WETH ? ethPrice : 1);
  let k = 0;
  const pools = found.map(p => {
    const qBal = big(res[k++].result), tBal = big(res[k++].result);
    const qUsd = units(qBal, qDec(p.quote)) * qUsdPer(p.quote), tAmt = units(tBal, dec);
    let priceUsd = null;
    if (p.dex.startsWith("uniswap-v3")) {
      const sp = big(word(slot0[v3.indexOf(p)]?.result, 0));
      if (sp > 0n) {
        const raw = (Number(sp) / 2 ** 96) ** 2; // token1 per token0 in raw units
        const tokenIs0 = token < p.quote;
        const qPerT = tokenIs0 ? raw * 10 ** (dec - qDec(p.quote)) : (1 / raw) * 10 ** (dec - qDec(p.quote));
        priceUsd = qPerT * qUsdPer(p.quote);
      }
    } else if (p.dex !== "aerodrome-stable" && tAmt > 0) priceUsd = qUsd / tAmt;
    return { dex: p.dex, pool: p.pool, quote: p.quote === WETH ? "WETH" : "USDC", quoteReserve: units(qBal, qDec(p.quote)), tokenReserve: tAmt, quoteUsd: qUsd, priceUsd };
  });
  const ref = [...pools].filter(p => p.priceUsd).sort((a, b) => b.quoteUsd - a.quoteUsd)[0];
  const refPrice = ref?.priceUsd ?? null;
  let liquidityUsd = 0;
  for (const p of pools) { p.liquidityUsd = Math.round(p.quoteUsd + (refPrice ? p.tokenReserve * refPrice : p.quoteUsd)); liquidityUsd += p.liquidityUsd; delete p.quoteUsd; }
  for (const p of pools.filter(p => p.dex === "uniswap-v2" || p.dex.startsWith("aerodrome"))) {
    const lpSupply = big(res[k++].result), burned = DEAD.reduce((s) => s + big(res[k++].result), 0n);
    p.lpBurnedPct = lpSupply > 0n ? Math.round(Number((burned * 10000n) / lpSupply)) / 100 : null;
  }
  const ownerBal = !renounced ? big(res[k++].result) : 0n;
  const deadBal = big(res[k++].result) + big(res[k++].result);
  const circulating = total - deadBal;
  const pct = v => (circulating > 0n ? Math.round(Number((v * 10000n) / circulating)) / 100 : null);
  const best = pools.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
  if (best && refPrice) best.priceUsd ??= refPrice;

  const sim = best ? await sellSimulation(token, best.pool, dec) : { simulated: false, note: "no pool found" };

  // Score: 0 (safe) .. 100 (avoid)
  const flags = [];
  let score = 0;
  const add = (pts, sev, msg) => { score += pts; flags.push({ severity: sev, issue: msg }); };
  if (sim.simulated && !sim.sellToPoolSucceeds) add(60, "critical", "Simulated transfer into the main pool REVERTS: likely honeypot / sells blocked");
  if (!pools.length) add(35, "high", "No Uniswap/Aerodrome pool vs WETH or USDC found on Base: cannot exit");
  else if (liquidityUsd < 10000) add(20, "high", `Very low liquidity (~$${Math.round(liquidityUsd)})`);
  else if (liquidityUsd < 100000) add(8, "medium", `Thin liquidity (~$${Math.round(liquidityUsd)})`);
  if (isProxy && !renounced) add(15, "high", "Upgradeable proxy controlled by an owner: code can change");
  else if (isProxy) add(8, "medium", "Upgradeable proxy");
  if (!renounced) {
    const severe = powers.filter(p => SEVERE.has(Object.keys(POWERS).find(s => POWERS[s] === p)));
    if (severe.length) add(15, "high", `Owner-controllable functions present: ${severe.join(", ")}`);
    const soft = powers.filter(p => !severe.includes(p));
    if (soft.length) add(7, "medium", `Owner can change fees/limits/trading: ${soft.join(", ")}`);
    const op = pct(ownerBal);
    if (op != null && op > 20) add(15, "high", `Owner wallet holds ${op}% of circulating supply`);
    else if (op != null && op > 5) add(6, "medium", `Owner wallet holds ${op}% of circulating supply`);
  }
  const v2 = pools.find(p => p.lpBurnedPct != null);
  if (v2 && v2.lpBurnedPct < 50 && v2 === best && liquidityUsd < 1000000) add(8, "medium", `Only ${v2.lpBurnedPct}% of main LP tokens are burned: liquidity can be pulled`);
  score = Math.min(100, score);
  const verdict = score >= 60 ? "AVOID" : score >= 30 ? "HIGH_RISK" : score >= 12 ? "CAUTION" : "LOW_RISK";

  return {
    ok: true, token, chain: "base", name: str(name.result), symbol: str(symbol.result), decimals: dec,
    totalSupply: units(total, dec), burnedSupply: units(deadBal, dec),
    verdict, riskScore: score, flags,
    owner: renounced ? null : ownerAddr, ownershipRenounced: renounced, ownerHoldingsPct: renounced ? null : pct(ownerBal),
    proxy: isProxy ? { implementation: impl } : null, ownerFunctionsDetected: powers,
    sellSimulation: sim, liquidityUsd: Math.round(liquidityUsd), priceUsd: refPrice, pools: pools.slice(0, 6),
    ethUsd: ethPrice,
    disclaimer: "Automated on-chain heuristics, not financial advice. Absence of flags does not guarantee safety.",
  };
}
