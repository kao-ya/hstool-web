/**
 * Cloudflare Pages Function —— 异画（签名）卡图代理
 *
 * 背景：异画卡图放在 hearthstone.wiki.gg，文件名后缀 _Premium3.png；
 *      少数卡只有「签名插画」_signature_art.png；还有一部分卡只存在于英文站
 *      （/images/），中文站（/zh/images/）没有同名文件 —— 例如 BE_013 克苏恩，帝国之眼。
 *      那边对跨站直接热链会返回 403（缺浏览器指纹和 Referer），
 *      而且没有 CORS 头，前端 <img> 直连必然白图。
 *
 * 这个 Function 服务端按候选顺序依次去取图，带上浏览器 UA + Referer，再回给前端：
 *   同源 → 没有 CORS 和防盗链问题，还能在 CF 边缘缓存一年。
 *
 * 路由：GET /api/hs-signature?card=<卡牌id>&w=<256|512|1024>
 *   卡牌 id 只允许 [A-Za-z0-9_]（形如 EX1_573 / TOY_330），杜绝任意 URL 代理
 */

// 候选站点：先中文站，再英文站（英文站文件更全；图本身与语言无关）
const BASES = [
  "https://hearthstone.wiki.gg/zh/images/",
  "https://hearthstone.wiki.gg/images/",
];
// 候选后缀：完整异画卡面优先，其次只有插画的签名图
const SUFFIXES = ["_Premium3.png", "_signature_art.png"];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REFERER = "https://hearthstone.wiki.gg/zh/wiki/%E5%BC%82%E7%94%BB%E5%8D%A1";
const ID_RE = /^[A-Za-z0-9_]{1,48}$/;

function buildTargets(id, w) {
  const list = [];
  for (let s = 0; s < SUFFIXES.length; s++) {
    for (let b = 0; b < BASES.length; b++) {
      const file = id + SUFFIXES[s];
      const url = w
        ? BASES[b] + "thumb/" + file + "/" + w + "px-" + file
        : BASES[b] + file;
      list.push(url);
    }
  }
  return list;
}

async function tryFetch(target) {
  return fetch(target, {
    headers: {
      "User-Agent": UA,
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Referer: REFERER,
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "same-origin",
    },
    cf: { cacheTtl: 2592000, cacheEverything: true },
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = (url.searchParams.get("card") || "").trim();
  const width = parseInt(url.searchParams.get("w") || "0", 10) || 0;

  if (!ID_RE.test(id)) {
    return new Response("bad card id", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  // 只允许常用档位，避免有人拿这个口子批量生成任意尺寸的缩略图
  const w = [256, 512, 1024].indexOf(width) >= 0 ? width : 0;

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(url.origin + "/api/hs-signature?card=" + id + "&w=" + w, { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const targets = buildTargets(id, w);
  const tried = [];
  let lastErr = "";
  let hadError = false; // 网络异常 / 上游 5xx：属于「暂时取不到」，不能当成「没有这张图」

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    let upstream;
    try {
      upstream = await tryFetch(target);
    } catch (e) {
      lastErr = (e && e.message) ? e.message : "fetch failed";
      tried.push(target + " -> throw");
      hadError = true;
      continue;
    }
    const ctype = (upstream.headers.get("Content-Type") || "").toLowerCase();
    if (!upstream.ok || ctype.indexOf("image/") !== 0) {
      tried.push(target + " -> " + upstream.status);
      if (upstream.status >= 500) hadError = true;
      continue;
    }
    const res = new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": ctype,
        // 异画图内容不会变（文件名带固定后缀），可以长缓存
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
        // 便于排查命中哪一路候选（不含隐私信息）
        "X-Sig-Src": target.replace("https://hearthstone.wiki.gg", ""),
      },
    });
    if (cache) context.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }

  // 全都 404 → 这张卡确实没有异画图，回 404（前端据此记「没有」缓存）；
  // 出现网络异常或上游 5xx → 回 502，让前端下次还能再试（不写否定缓存）。
  const status = hadError ? 502 : 404;
  const miss = new Response("no signature art: " + tried.join(" | ") + (lastErr ? " | " + lastErr : ""), {
    status: status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // 404 在边缘缓存一天（省掉重复探测）；502 不缓存
      "Cache-Control": hadError ? "no-store" : "public, max-age=86400",
    },
  });
  if (cache && !hadError) context.waitUntil(cache.put(cacheKey, miss.clone()));
  return miss;
}
