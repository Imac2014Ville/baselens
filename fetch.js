// URL -> clean markdown fetcher for Cloudflare Workers (HTMLRewriter based). No deps.

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---------- SSRF guard ----------
function ipv4Blocked(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b, c] = [+m[1], +m[2], +m[3]];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function checkUrl(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http/https URLs are allowed";
  let h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return "missing hostname";
  if (u.username || u.password) return "credentials in URL not allowed";
  if (h.startsWith("[")) {
    const v6 = h.slice(1, -1);
    // v4-mapped (WHATWG normalizes to hex form ::ffff:7f00:1)
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
    if (mapped) {
      const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
      if (ipv4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)) return "blocked address";
      return null;
    }
    if (v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6) || v6.startsWith("::ffff:"))
      return "blocked address";
    return null;
  }
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal"))
    return "blocked hostname";
  if (ipv4Blocked(h)) return "blocked address";
  return null;
}

// ---------- entities ----------
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©",
  reg: "®", trade: "™", middot: "·", bull: "•", laquo: "«", raquo: "»",
  times: "×", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", larr: "←", rarr: "→", uarr: "↑", darr: "↓",
  minus: "−", plusmn: "±", frac12: "½", shy: "",
};
function decode(s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "";
      return String.fromCodePoint(cp);
    }
    const v = NAMED[e] ?? NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

// ---------- HTML -> markdown ----------
const SKIP = "script,style,noscript,svg,nav,footer,header,aside,form,iframe,template,head,title,select,button,.mw-editsection,sup.reference";
const BLOCK2 = "p,section,figure,figcaption,dl,details,summary,address,main,article";
const BLOCK1 = "div,dt,dd,tr,caption,fieldset";

function absUrl(href, base) {
  if (!href) return null;
  href = decode(href).trim();
  if (!href || href[0] === "#" || /^(javascript|mailto|tel|data):/i.test(href)) return null;
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

function cleanup(md) {
  const parts = md.split(/(```[\s\S]*?```)/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/, "").replace(/^ (?! )/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  }
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

async function convert(html, baseUrl, needMain) {
  const out = [];
  const links = [];
  const seen = new Set();
  const meta = { title: "", ogTitle: "", description: "", ogDescription: "", lang: null };
  let skip = 0, mainDepth = 0, inPre = 0, lastChar = "", buf = "", titleSeen = false;
  const lists = [];
  const tables = [];

  const active = () => skip === 0 && (!needMain || mainDepth > 0);
  const push = (s) => {
    if (!s || !active()) return;
    out.push(s);
    lastChar = s[s.length - 1];
  };
  // Replace everything emitted between element open and close with fn(inner).
  const region = (el, fn, after) => {
    const idx = out.length;
    out.push("");
    if (!el.onEndTag) return;
    el.onEndTag(() => {
      const inner = out.splice(idx + 1).join("");
      const r = fn(inner) || "";
      out[idx] = r;
      if (r) lastChar = r[r.length - 1];
      if (after) after();
    });
  };
  const wrap = (m) => (inner) => {
    if (!inner.trim()) return inner;
    const lead = /^\s/.test(inner) ? " " : "";
    const trail = /\s$/.test(inner) ? " " : "";
    return lead + m + inner.trim().replace(/\s*\n+\s*/g, " ") + m + trail;
  };
  const flushText = (raw) => {
    if (!active()) return;
    if (inPre) return push(decode(raw));
    let s = decode(raw).replace(/\s+/g, " ");
    if (s[0] === " " && (lastChar === "" || /\s/.test(lastChar))) s = s.slice(1);
    push(s);
  };

  const rw = new HTMLRewriter()
    .on("html", { element(el) { meta.lang = el.getAttribute("lang") || meta.lang; } })
    .on("title", {
      element() { if (!titleSeen) { titleSeen = true; meta._inTitle = true; } else meta._inTitle = false; },
      text(t) { if (meta._inTitle) meta.title += t.text; },
    })
    .on("meta", {
      element(el) {
        const key = (el.getAttribute("name") || el.getAttribute("property") || "").toLowerCase();
        const c = el.getAttribute("content");
        if (!c) return;
        if (key === "description" && !meta.description) meta.description = c;
        else if (key === "og:description" && !meta.ogDescription) meta.ogDescription = c;
        else if (key === "og:title" && !meta.ogTitle) meta.ogTitle = c;
      },
    })
    .on(SKIP, {
      element(el) {
        skip++;
        el.onEndTag(() => { skip--; });
      },
    })
    .on("article,main", {
      element(el) {
        mainDepth++;
        el.onEndTag(() => { mainDepth--; });
      },
    })
    .on("*", {
      text(t) {
        buf += t.text;
        if (t.lastInTextNode) {
          const b = buf;
          buf = "";
          flushText(b);
        }
      },
    })
    .on(BLOCK2, { element(el) { push("\n\n"); el.onEndTag?.(() => push("\n\n")); } })
    .on(BLOCK1, { element(el) { push("\n"); el.onEndTag?.(() => push("\n")); } })
    .on("br", { element() { push("\n"); } })
    .on("hr", { element() { push("\n\n---\n\n"); } })
    .on("h1,h2,h3,h4,h5,h6", {
      element(el) {
        const n = +el.tagName[1];
        region(el, (inner) => {
          const t = inner.replace(/\s+/g, " ").trim();
          return t ? `\n\n${"#".repeat(n)} ${t}\n\n` : "";
        });
      },
    })
    .on("a", {
      element(el) {
        const href = absUrl(el.getAttribute("href"), baseUrl);
        region(el, (inner) => {
          const t = inner.replace(/\s+/g, " ").trim().replace(/(^| )#{1,6} /g, "$1");
          if (!t) return "";
          if (!href) return inner;
          if (links.length < 50 && !seen.has(href + "\0" + t)) {
            seen.add(href + "\0" + t);
            links.push({ text: t, href });
          }
          const lead = /^\s/.test(inner) ? " " : "";
          const trail = /\s$/.test(inner) ? " " : "";
          return `${lead}[${t.replace(/[\[\]]/g, "")}](${href})${trail}`;
        });
      },
    })
    .on("strong,b", { element(el) { region(el, wrap("**")); } })
    .on("em,i", { element(el) { region(el, wrap("_")); } })
    .on("code", {
      element(el) {
        if (inPre) return;
        region(el, (inner) => {
          const t = inner.replace(/\s+/g, " ").trim();
          return t ? "`" + t.replace(/`/g, "'") + "`" : "";
        });
      },
    })
    .on("pre", {
      element(el) {
        inPre++;
        region(
          el,
          (inner) => {
            const t = inner.replace(/^\n+/, "").replace(/\s+$/, "");
            return t ? "\n\n```\n" + t + "\n```\n\n" : "";
          },
          () => { inPre--; }
        );
      },
    })
    .on("blockquote", {
      element(el) {
        region(el, (inner) => {
          const t = inner.trim();
          if (!t) return "";
          return "\n\n" + t.replace(/\n{3,}/g, "\n\n").split("\n").map((l) => (l ? "> " + l : ">")).join("\n") + "\n\n";
        });
      },
    })
    .on("ul,ol", {
      element(el) {
        lists.push({ ordered: el.tagName === "ol", n: 0 });
        const nested = lists.length > 1;
        region(
          el,
          (inner) => (inner.trim() ? (nested ? "\n" + inner : "\n\n" + inner.replace(/^\n+/, "") + "\n\n") : ""),
          () => { lists.pop(); }
        );
      },
    })
    .on("li", {
      element(el) {
        const top = lists[lists.length - 1];
        const depth = Math.max(lists.length - 1, 0);
        const bullet = top && top.ordered ? `${++top.n}. ` : "- ";
        region(el, (inner) => {
          const t = inner.trim().replace(/\n{2,}/g, "\n");
          return t ? "\n" + "  ".repeat(depth) + bullet + t + "\n" : "";
        });
      },
    })
    .on("table", {
      element(el) {
        if (tables.length) tables[tables.length - 1].complex = true;
        const st = { rows: [], cur: null, complex: false, th: false };
        tables.push(st);
        region(el, (inner) => {
          tables.pop();
          const cols = Math.max(0, ...st.rows.map((r) => r.length));
          const nonEmpty = st.rows.filter((r) => r.some(Boolean));
          const cells = nonEmpty.reduce((n, r) => n + r.length, 0);
          const empty = nonEmpty.reduce((n, r) => n + r.filter((c) => !c).length, 0);
          const dataLike = st.th || (nonEmpty.length >= 2 && empty / Math.max(cells, 1) < 0.15);
          if (st.complex || cols < 2 || nonEmpty.length < 1 || !dataLike || !inner.trim()) {
            return inner.trim() ? "\n\n" + inner.trim() + "\n\n" : "";
          }
          const fmt = (r) => "| " + Array.from({ length: cols }, (_, i) => (r[i] || "").replace(/\|/g, "\\|")).join(" | ") + " |";
          const lines = [fmt(nonEmpty[0]), "|" + " --- |".repeat(cols), ...nonEmpty.slice(1).map(fmt)];
          return "\n\n" + lines.join("\n") + "\n\n";
        });
      },
    })
    .on("tr", {
      element(el) {
        const st = tables[tables.length - 1];
        if (!st) return;
        st.cur = [];
        region(el, (inner) => {
          if (st.cur) st.rows.push(st.cur);
          st.cur = null;
          return inner;
        });
      },
    })
    .on("td,th", {
      element(el) {
        const st = tables[tables.length - 1];
        const isTh = el.tagName === "th";
        region(el, (inner) => {
          const t = inner.trim();
          if (st) {
            if (isTh) st.th = true;
            if (st.cur) st.cur.push(t.replace(/\s+/g, " "));
            else st.complex = true;
          }
          return t ? "\n" + t + "\n" : "";
        });
      },
    })
    .on("img", {
      element(el) {
        const alt = (el.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
        if (!alt) return;
        const src = absUrl(el.getAttribute("src") || el.getAttribute("data-src"), baseUrl);
        if (src) push(`![${decode(alt).replace(/[\[\]]/g, "")}](${src})`);
      },
    });

  await rw.transform(new Response(html)).arrayBuffer();
  if (buf) flushText(buf);
  return { markdown: cleanup(out.join("")), links, meta };
}

// ---------- body reading ----------
async function readBody(res) {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > MAX_BYTES) {
      chunks.push(value.subarray(0, MAX_BYTES - total));
      total = MAX_BYTES;
      try { await reader.cancel(); } catch {}
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

function decodeBytes(bytes, contentType) {
  let label = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || "")?.[1];
  if (!label) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  }
  try { return new TextDecoder(label || "utf-8").decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

// ---------- main ----------
export async function fetchMarkdown(url, { maxChars = 50000 } = {}) {
  try {
    let u;
    try { u = new URL(String(url || "")); } catch { return { ok: false, url, error: "invalid URL" }; }
    let bad = checkUrl(u);
    if (bad) return { ok: false, url, error: bad };

    const signal = AbortSignal.timeout(10000);
    let res;
    for (let hop = 0; ; hop++) {
      res = await fetch(u.href, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        try { await res.body?.cancel(); } catch {}
        if (!loc) return { ok: false, url, error: "redirect without location" };
        if (hop >= MAX_REDIRECTS) return { ok: false, url, error: "too many redirects" };
        try { u = new URL(loc, u); } catch { return { ok: false, url, error: "bad redirect location" }; }
        bad = checkUrl(u);
        if (bad) return { ok: false, url, error: "redirect blocked: " + bad };
        continue;
      }
      break;
    }

    const finalUrl = u.href;
    const contentType = res.headers.get("content-type") || "";
    const ct = contentType.split(";")[0].trim().toLowerCase();
    if (res.status >= 400) {
      try { await res.body?.cancel(); } catch {}
      return { ok: false, url, finalUrl, status: res.status, error: `HTTP ${res.status}` };
    }

    const isHtml = ct === "text/html" || ct === "application/xhtml+xml";
    const isText = ct.startsWith("text/") || /json|xml|markdown/.test(ct);
    if (ct && !isHtml && !isText) {
      try { await res.body?.cancel(); } catch {}
      return { ok: false, url, finalUrl, status: res.status, error: `unsupported content-type: ${ct}` };
    }

    const bytes = await readBody(res);
    const text = decodeBytes(bytes, contentType);
    const sniffHtml = !ct && /^\s*(<!doctype html|<html)/i.test(text);

    let markdown, title = "", description = "", lang = null, links = [];
    if (isHtml || sniffHtml) {
      const needMain = /<(article|main)[\s>]/i.test(text);
      let r = await convert(text, finalUrl, needMain);
      if (needMain && r.markdown.length < 200) {
        const r2 = await convert(text, finalUrl, false);
        if (r2.markdown.length > r.markdown.length) r = r2;
      }
      markdown = r.markdown;
      links = r.links;
      const m = r.meta;
      title = decode((m.title || m.ogTitle || "").replace(/\s+/g, " ").trim());
      description = decode((m.description || m.ogDescription || "").replace(/\s+/g, " ").trim());
      lang = m.lang;
    } else {
      markdown = text;
      if (ct.includes("json")) {
        try { markdown = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      }
    }

    const wordCount = markdown.split(/\s+/).filter(Boolean).length;
    let truncated = false;
    if (markdown.length > maxChars) {
      markdown = markdown.slice(0, maxChars);
      truncated = true;
    }
    return {
      ok: true,
      url,
      finalUrl,
      status: res.status,
      contentType: ct || null,
      title,
      description,
      lang,
      markdown,
      links,
      wordCount,
      truncated,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    const msg = e && e.name === "TimeoutError" ? "timeout after 10s" : String((e && e.message) || e);
    return { ok: false, url, error: msg };
  }
}
