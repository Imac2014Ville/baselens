// Ordered facilitator failover for x402. Same interface as @x402/core's HTTPFacilitatorClient
// (verify / settle / getSupported).
//
// Requirement stability: PayAI and Daydreams both advertise plain `exact` on eip155:8453 with no
// `extra` (EIP-3009 transferWithAuthorization), so a payload signed against requirements built
// from PayAI's /supported is valid on either. Dexter advertises `assetTransferMethod: permit2`
// for exact/eip155:8453, i.e. different requirements, so we NEVER take getSupported from it
// (that would change the 402 challenge). It is only tried as a last resort at verify/settle time,
// where it may still reject an EIP-3009 payload, which is harmless: the chain just ends with
// the last error.
import { HTTPFacilitatorClient } from "@x402/core/server";

export const DEFAULT_FACILITATORS = [
  { name: "payai", url: "https://facilitator.payai.network", supportedSource: true },
  { name: "daydreams", url: "https://facilitator.daydreams.systems", supportedSource: true },
  { name: "dexter", url: "https://x402.dexter.cash", supportedSource: false },
];

// Credit/allowance/quota-style failures from a facilitator (not payer-fault reasons).
const QUOTA_RE = /credit|allowance|quota|rate.?limit|insufficient_funds_facilitator|free.?tier|limit.?exceeded|payment.?required|too many|unauthori[sz]ed|forbidden|subscription|billing|exhaust/i;

function shouldFailover(err, resp) {
  if (err) {
    const status = err.statusCode ?? err.status;
    if (status === undefined) return true; // network error / timeout / parse error
    if (status >= 500 || status === 401 || status === 402 || status === 403 || status === 429) return true;
    const d = err.data ?? err; // VerifyError / SettleError carry the facilitator body
    return QUOTA_RE.test(String(d.invalidReason ?? d.errorReason ?? "") + " " + String(d.invalidMessage ?? d.errorMessage ?? err.message ?? ""));
  }
  // Non-throwing negative responses: only fail over on quota-type reasons, never on payer faults.
  if (resp && (resp.isValid === false || resp.success === false)) {
    return QUOTA_RE.test(String(resp.invalidReason ?? resp.errorReason ?? "") + " " + String(resp.invalidMessage ?? resp.errorMessage ?? ""));
  }
  return false;
}

export class FailoverFacilitatorClient {
  constructor(list = DEFAULT_FACILITATORS, opts = {}) {
    this.log = opts.log ?? console.log;
    this.list = list.map(f => ({ ...f, client: new HTTPFacilitatorClient({ url: f.url }) }));
  }

  async getSupported() {
    let lastErr;
    for (const f of this.list.filter(f => f.supportedSource)) {
      try { return await f.client.getSupported(); }
      catch (e) { lastErr = e; this.log(`[facilitator] getSupported failed on ${f.name}: ${e.message}`); }
    }
    throw lastErr ?? new Error("no facilitator available for getSupported");
  }

  async #run(op, payload, requirements) {
    let lastErr, lastResp;
    for (const f of this.list) {
      try {
        const resp = await f.client[op](payload, requirements);
        if (shouldFailover(null, resp) && f !== this.list.at(-1)) { lastResp = resp; this.log(`[facilitator] ${op} on ${f.name} returned quota-type failure, trying next`); continue; }
        this.log(`[facilitator] ${op} via ${f.name}`);
        return resp;
      } catch (e) {
        lastErr = e;
        if (!shouldFailover(e)) { this.log(`[facilitator] ${op} on ${f.name} rejected: ${e.message}`); throw e; }
        this.log(`[facilitator] ${op} on ${f.name} failed over: ${e.message}`);
      }
    }
    if (lastErr) throw lastErr;
    return lastResp;
  }

  verify(payload, requirements) { return this.#run("verify", payload, requirements); }
  settle(payload, requirements) { return this.#run("settle", payload, requirements); }
}
