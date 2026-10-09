// Cloud compute price lookup backed by the public, keyless Azure Retail Prices API.
const API = "https://prices.azure.com/api/retail/prices";
const TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = 5;
const cache = new Map();

const esc = (s) => String(s).replace(/'/g, "''");

function normalize(q) {
  q = q || {};
  const n = {
    service: String(q.service || "Virtual Machines").trim(),
    region: q.region ? String(q.region).trim().toLowerCase() : undefined,
    sku: q.sku ? String(q.sku).trim() : undefined,
    gpu: q.gpu === true || q.gpu === "true" || q.gpu === "1" || q.gpu === 1,
    priceType: undefined,
    os: q.os ? String(q.os).trim().toLowerCase() : undefined,
    maxResults: Math.min(100, Math.max(1, parseInt(q.maxResults, 10) || 25)),
    sort: "price",
  };
  if (q.priceType) {
    const p = String(q.priceType).trim().toLowerCase();
    n.priceType = { consumption: "Consumption", reservation: "Reservation", spot: "Spot" }[p];
    if (!n.priceType) throw new Error("priceType must be Consumption, Reservation or Spot");
  }
  if (!n.priceType) n.priceType = "Consumption"; // default: pay-as-you-go
  for (const k of ["service", "region", "sku"]) if (n[k] && !/^[\w .\-]{1,64}$/.test(n[k])) throw new Error(`${k} may only contain letters, digits, space, _ . - (max 64 chars)`);
  if (n.os && n.os !== "linux" && n.os !== "windows") throw new Error("os must be linux or windows");
  return n;
}

function buildFilter(n) {
  const f = [`serviceName eq '${esc(n.service)}'`];
  if (n.region) f.push(`armRegionName eq '${esc(n.region)}'`);
  if (n.priceType === "Spot") f.push(`priceType eq 'Consumption'`, `contains(meterName,'Spot')`);
  else {
    if (n.priceType) f.push(`priceType eq '${n.priceType}'`);
  }
  if (n.sku) f.push(`contains(armSkuName,'${esc(n.sku)}')`);
  if (n.gpu) {
    f.push("(" + ["NC", "ND", "NV", "NG"].map((p) => `contains(armSkuName,'Standard_${p}')`).join(" or ") + ")");
  }
  if (n.os === "windows") f.push(`contains(productName,'Windows')`);
  return f.join(" and ");
}

function termHours(term) {
  const m = /(\d+)\s*Year/i.exec(term || "");
  return m ? Number(m[1]) * 8760 : null;
}

function toItem(r) {
  const unit = r.unitOfMeasure || "";
  let hourly = null;
  if (r.type === "Reservation") {
    const h = termHours(r.reservationTerm);
    if (h) hourly = r.unitPrice / h;
  } else if (/^1\s*Hour$/i.test(unit.trim())) hourly = r.unitPrice;
  if (hourly == null) return null;
  const spot = /spot/i.test(r.meterName || "");
  return {
    sku: r.skuName,
    armSkuName: r.armSkuName,
    region: r.armRegionName,
    priceType: spot ? "Spot" : r.type,
    os: /windows/i.test(r.productName || "") ? "windows" : "linux",
    unitPrice: r.unitPrice,
    unit: r.type === "Reservation" ? `${r.reservationTerm} (total)` : unit,
    hourlyUsd: Math.round(hourly * 1e5) / 1e5,
    monthlyUsd: Math.round(hourly * 730 * 100) / 100,
    meterName: r.meterName,
    productName: r.productName,
    effectiveStartDate: r.effectiveStartDate,
  };
}

export async function cloudPrices(q) {
  let n;
  try { n = normalize(q); } catch (e) { return { ok: false, error: e.message }; }
  const key = JSON.stringify(n);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;

  try {
    let url = `${API}?$filter=${encodeURIComponent(buildFilter(n))}`;
    const items = [];
    let pages = 0, more = false;
    while (url && pages < MAX_PAGES) {
      let res;
      for (let a = 0; ; a++) {
        res = await fetch(url, { headers: { accept: "application/json" } });
        if (res.status !== 429 || a >= 3) break;
        const ra = Number(res.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, Math.min(8000, (ra > 0 ? ra * 1000 : 1500 * 2 ** a))));
      }
      if (!res.ok) throw new Error(`Azure Retail Prices API returned HTTP ${res.status}`);
      const j = await res.json();
      pages++;
      for (const r of j.Items || []) {
        const mn = r.meterName || "";
        if (n.priceType !== "Spot" && (/spot/i.test(mn) || /low priority/i.test(mn))) continue;
        const it = toItem(r);
        if (!it) continue;
        if (n.os && it.os !== n.os) continue;
        items.push(it);
      }
      url = j.NextPageLink || null;
      if (url && items.length >= n.maxResults * 4) { more = true; break; }
    }
    if (url) more = true;
    items.sort((a, b) => a.hourlyUsd - b.hourlyUsd);
    const out = items.slice(0, n.maxResults);
    const v = {
      ok: true,
      source: "azure-retail-prices",
      currency: "USD",
      query: n,
      count: out.length,
      items: out,
      cheapest: out[0] || null,
      note:
        "Azure retail list prices (pay-as-you-go, no negotiated discounts). monthlyUsd = hourly * 730. Reservation hourly = term total / term hours." +
        (more ? ` Results drawn from the first ${pages} page(s) of upstream data; narrow the query (region/sku) for completeness.` : ""),
    };
    cache.set(key, { t: Date.now(), v });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return v;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
