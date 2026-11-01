/**
 * Cloudflare Pages Function —— 异画（签名）卡图代理
 *
 * 背景：异画卡图放在 hearthstone.wiki.gg（文件名后缀 _Premium3.png）。
 *      那边对跨站直接热链会返回 403（缺浏览器指纹和 Referer），
 *      而且没有 CORS 头，前端 <img> 直连必然白图。
 *
 * 这个 Function 服务端去取图，带上浏览器 UA + Referer，再回给前端：
 *   同源 → 没有 CORS 和防盗链问题，还能在 CF 边缘缓存一年。
 *
 * 路由：GET /api/hs-signature?card=<卡牌id>
 *   卡牌 id 只允许 [A-Za-z0-9_]（形如 EX1_573 / TOY_330），杜绝任意 URL 代理
 */

const WIKI = "https://hearthstone.wiki.gg/zh/images/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REFERER = "https://hearthstone.wiki.gg/zh/wiki/%E5%BC%82%E7%94%BB%E5%8D%A1";
const ID_RE = /^[A-Za-z0-9_]{1,48}$/;

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

  // 原图 ~256 KB；网格缩略图走 MediaWiki 的 thumb 路径（预先裁好的 256px）
  const target = w
    ? WIKI + "thumb/" + id + "_Premium3.png/" + w + "px-" + id + "_Premium3.png"
    : WIKI + id + "_Premium3.png";

  let upstream;
  try {
    upstream = await fetch(target, {
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
  } catch (e) {
    return new Response("upstream error: " + (e && e.message ? e.message : "fetch failed"), {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!upstream.ok) {
    return new Response("upstream " + upstream.status, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const res = new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "image/png",
      // 异画图内容不会变（文件名带固定后缀），可以长缓存
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    },
  });

  if (cache) context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
