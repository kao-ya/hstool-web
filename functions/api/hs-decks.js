/**
 * Cloudflare Pages Function —— 同源取数代理
 *
 * 背景：hstopdecks.com 的公开 API（/api/v1/find、/api/v1/meta）现在应用层直接断流，
 *      而且它对跨域请求按 Origin 校验一律 403、响应也没有 CORS 头，所以浏览器直连必然
 *      Failed to fetch。但它的「卡组详情页」是能取到内容的（实测前 ~125KB，卡组代码、
 *      胜率、合成尘都在这一段里）。这个 Function 就干一件事：服务端去抓那些页面，
 *      解析成干净 JSON 还给前端——因为同源，浏览器不再受 CORS 约束。
 *
 * 路由：
 *   GET /api/hs-decks?mode=index              卡组索引（name / 职业 / 详情页路径）
 *   GET /api/hs-decks?mode=deck&slug=deck-xxx 单套详情（代码 / 胜率 / 尘 / 模式）
 */

const UPSTREAM = "https://hstopdecks.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CLASS_ZH = {
  dk: "死亡骑士", demonhunter: "恶魔猎手", druid: "德鲁伊", hunter: "猎人",
  mage: "法师", paladin: "圣骑士", priest: "牧师", rogue: "潜行者",
  shaman: "萨满祭司", warlock: "术士", warrior: "战士", neutral: "中立",
};
const CLASS_RE =
  /(死亡骑士|恶魔猎手|德鲁伊|猎人|法师|圣骑士|牧师|潜行者|萨满祭司|术士|战士|中立)/;

// 卡组代码：以 AAEB / AAEC / AAED 等开头的 base64 长串
const CODE_RE = /\b(AAE[A-Za-z0-9+/]{30,}={0,2})\b/;

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * 抓一页 HTML。对方经常只发一段就断连，这里把「截断」当成正常结果：
 * 只要收到过字节就解析，读流报错/超时都不算失败。
 */
async function grab(path, timeoutMs = 12000, maxBytes = 400000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const chunks = [];
  let total = 0;
  let status = 0;
  try {
    const res = await fetch(UPSTREAM + path, {
      signal: ctl.signal,
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml",
        "accept-encoding": "identity",
      },
    });
    status = res.status;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        let step;
        try {
          step = await reader.read();
        } catch (e) {
          break; // 对端断连，已收到的内容照用
        }
        if (step.done) break;
        chunks.push(step.value);
        total += step.value.length;
        if (total >= maxBytes) { try { await reader.cancel(); } catch (e) {} break; }
      }
    }
  } catch (e) {
    // 连不上 / 被 abort：有旧字节就继续
  } finally {
    clearTimeout(timer);
  }
  return { text: new TextDecoder("utf-8").decode(concat(chunks)), status, bytes: total };
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseIndex(html) {
  const out = [];
  const seen = new Set();
  const re = /"name":"([^"]{1,60})","url":"https:\/\/hstopdecks\.com\/(decks\/deck-([a-z]+)-[A-Za-z0-9]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const path = "/" + m[2];
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, slug: m[2].replace(/^decks\//, ""), name: stripTags(m[1]), cls: CLASS_ZH[m[3]] || m[3] });
  }
  return out;
}

function parseDeck(html, path) {
  const desc = (/<meta name="description" content="([^"]{0,400})"/.exec(html) || [])[1] || "";
  const headline = (/"@type":"Article","headline":"([^"]{1,80})"/.exec(html) || [])[1] || "";
  const h1 = stripTags((/<h1[^>]*>([\s\S]{0,120}?)<\/h1>/.exec(html) || [])[1] || "");
  const code = (CODE_RE.exec(html) || [])[1] || "";

  const wr = /胜率\s*([0-9]{1,2}(?:\.[0-9])?)\s*%/.exec(desc) || /([0-9]{1,2}\.[0-9])%<\/span>/.exec(html);
  const dust = /合成\s*([0-9,]{3,8})\s*尘/.exec(desc) || /([0-9,]{3,8})\s*尘/.exec(html);
  const games = /([0-9,]{2,7})\s*局/.exec(html);
  const fmt = /(标准模式|狂野模式|经典模式|幻变模式)/.exec(desc);
  const tier = /Tier\s*([SABC1-4])/i.exec(html);
  const clsZh = CLASS_RE.exec(desc) || CLASS_RE.exec(html);
  const slug = (path.match(/deck-([a-z]+)-/) || [])[1] || "";
  const modified = (/"dateModified":"([0-9-]{8,10})"/.exec(html) || [])[1] || "";

  return {
    path,
    slug: path.replace(/^\/decks\//, ""),
    name: stripTags(headline || h1) || "(未命名)",
    cls: clsZh ? clsZh[1] : (CLASS_ZH[slug] || ""),
    format: fmt ? fmt[1] : "",
    code,
    winrate: wr ? Number(wr[1]) : null,
    games: games ? Number(games[1].replace(/,/g, "")) : null,
    dust: dust ? Number(dust[1].replace(/,/g, "")) : null,
    tier: tier ? tier[1].toUpperCase() : "",
    updated: modified,
    desc: stripTags(desc).slice(0, 160),
  };
}

function json(body, status = 200, cacheSeconds = 600) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=" + cacheSeconds,
      "access-control-allow-origin": "*",
    },
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const mode = url.searchParams.get("mode") || "index";
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: "GET" });

  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (e) { /* 缓存不可用就直连 */ }
  }

  let res;
  if (mode === "deck") {
    const slug = (url.searchParams.get("slug") || "").trim();
    if (!/^deck-[a-z]+-[A-Za-z0-9]+$/.test(slug)) {
      return json({ ok: false, error: "slug 参数不合法，应形如 deck-priest-ljsKDj0Grc" }, 400, 0);
    }
    const r = await grab("/decks/" + slug);
    if (!r.bytes) {
      return json({ ok: false, mode, error: "upstream-empty", status: r.status, hint: "对方没有返回内容（断流）" }, 502, 0);
    }
    const deck = parseDeck(r.text, "/decks/" + slug);
    res = json({ ok: !!deck.code, mode, upstream_status: r.status, upstream_bytes: r.bytes, deck }, deck.code ? 200 : 200, 900);
  } else {
    const cls = (url.searchParams.get("cls") || "").trim();
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(800, Number(url.searchParams.get("limit")) || 800));

    const r = await grab("/meta");
    if (!r.bytes) {
      return json({ ok: false, mode, error: "upstream-empty", status: r.status, hint: "对方没有返回内容（断流）" }, 502, 0);
    }
    let list = parseIndex(r.text);
    if (cls) list = list.filter(d => d.cls === cls);
    if (q) list = list.filter(d => d.name.toLowerCase().indexOf(q) >= 0);
    const total = list.length;
    if (list.length > limit) list = list.slice(0, limit);
    res = json({ ok: true, mode, upstream_status: r.status, upstream_bytes: r.bytes, total, count: list.length, decks: list }, 200, 900);
  }

  if (cache) {
    try { context.waitUntil(cache.put(cacheKey, res.clone())); } catch (e) { /* 忽略 */ }
  }
  return res;
}
