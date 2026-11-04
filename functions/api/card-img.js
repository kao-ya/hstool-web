// 卡图同源代理（给「卡组长图」用）
// GET /api/card-img?u=render/latest/zhCN/256x/CS2_029.png
//
// 只做一件事：把 art.hearthstonejson.com 的卡面图片代取回来，并补上
// Access-Control-Allow-Origin: *。因为该图床本身不发这个头，
// 前端 canvas 直接 drawImage 会把画布标记为「被污染」，toBlob() 直接抛
// SecurityError，长图就导不出来。
//
// 安全：u 参数用白名单正则强校验，只允许卡面图的三段固定路径，
// 不存在用它去请求任意地址的空间。

// 允许两类：① render/latest/…/*.png（带卡框的卡面）② 512x|256x/*.jpg|png（方形插画）
// 卡组行底图用的是插画（512×512 jpg），破碎效果要从这里取像素，所以必须放行。
const ALLOWED = /^(?:render\/latest\/(?:zhCN|enUS)\/(?:256x|512x|orig)\/[A-Za-z0-9_]+\.png|(?:256x|512x)\/[A-Za-z0-9_]+\.(?:jpg|png))$/;
const UPSTREAM = "https://art.hearthstonejson.com/v1/";

function bad(status, msg) {
  return new Response(msg, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
  });
}

export async function onRequestGet(context) {
  const { request } = context;
  const u = new URL(request.url).searchParams.get("u") || "";
  if (!ALLOWED.test(u)) return bad(400, "bad path");

  // 边缘缓存：同一张卡只回源一次（图片本身在源站也是 immutable 的）
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  const keyUrl = new URL("/api/card-img?u=" + encodeURIComponent(u), request.url).toString();
  const cacheKey = new Request(keyUrl, { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let upstream;
  try {
    upstream = await fetch(UPSTREAM + u, {
      cf: { cacheEverything: true, cacheTtl: 86400 },
      headers: { accept: "image/png,image/*;q=0.8" },
    });
  } catch (e) {
    return bad(502, "upstream unreachable");
  }
  if (!upstream.ok) return bad(502, "upstream " + upstream.status);

  const res = new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": /\.jpe?g$/i.test(u) ? "image/jpeg" : "image/png",
      "access-control-allow-origin": "*",
      // 卡图不会变，可长缓存；CF 边缘按 cf-cache-status 命中
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
  if (cache && context.waitUntil) context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
