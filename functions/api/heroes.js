// 由 _audit/gen_functions.mjs 生成，别手改
import { createDb } from "../_lib/cards-db.js";

// 索引放在静态资源里（data/cards-lite.json）：不进 Worker 包，避免打包体积超限。
// 每个 isolate 只加载一次；边缘缓存 1 天，冷启动一次回源。
let dbPromise = null;
function getDb(request) {
  if (!dbPromise) {
    dbPromise = (async () => {
      const base = new URL(request.url);
      const idxUrl = new URL("/data/cards-lite.json", base.origin).href;
      const metaUrl = new URL("/data/meta.json", base.origin).href;
      const init = { cf: { cacheEverything: true, cacheTtl: 86400 } };
      const [a, b] = await Promise.all([fetch(idxUrl, init), fetch(metaUrl, init)]);
      if (!a.ok) throw new Error("index " + a.status);
      const lite = await a.json();
      const meta = b.ok ? await b.json() : {};
      return createDb(lite, meta);
    })();
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=60, stale-while-revalidate=600",
};

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS, ...extra } });

const bad = (msg, status = 400) =>
  json({ ok: false, error: msg }, status, { "cache-control": "no-store" });

async function readJson(request) {
  try {
    const t = await request.text();
    return t ? JSON.parse(t) : {};
  } catch (e) {
    return {};
  }
}

function queryOf(request) {
  return new URL(request.url).searchParams;
}

export const onRequestGet = async ({ request }) => {
  const db = await getDb(request);
  return json({ ok: true, result: { heroes: db.heroes() } });
};
export const onRequestPost = onRequestGet;
