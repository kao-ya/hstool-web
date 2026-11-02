// GET /api/wiki?u=<encoded url>  —— 仅用于给「关键词提示」抓取权威中文说明
// 只允许白名单主机，避免变成通用代理；结果在边缘缓存 1 小时。
const ALLOWED_HOSTS = [
  "hearthstone.wiki.gg",
  "hearthstone.fandom.com",
  "hs.fandom.com",
  "wiki.biligame.com",
  "hs.gamekee.com",
];

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=600",
    }, extra || {}),
  });
}

export async function onRequestGet(context) {
  const req = context.request;
  const url = new URL(req.url);
  const raw = url.searchParams.get("u");
  if (!raw) return json({ error: "missing u" }, 400);

  let target;
  try { target = new URL(raw); } catch (_) { return json({ error: "bad u" }, 400); }
  if (target.protocol !== "https:") return json({ error: "https only" }, 400);
  if (!ALLOWED_HOSTS.includes(target.hostname)) return json({ error: "host not allowed" }, 403);

  let resp;
  try {
    resp = await fetch(target.toString(), {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
      },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
  } catch (e) {
    return json({ error: "upstream fetch failed: " + String(e && e.message || e) }, 502);
  }
  if (!resp.ok) return json({ error: "upstream " + resp.status }, 502);

  const text = await resp.text();
  return new Response(JSON.stringify({ ok: true, status: resp.status, len: text.length, body: text }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=600",
      "access-control-allow-origin": "*",
    },
  });
}
