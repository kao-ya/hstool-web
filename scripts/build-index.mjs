// 生成服务端查询索引 data/cards-lite.json
// 计数口径与前端 js/app.js 的 isCollectible / 名称名次 / 附属卡规则逐条对齐。
// 行格式（数组，比对象省约 60% 体积）：见 FIELDS
//
// 用法（仓库根目录）：node scripts/build-index.mjs
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");

const raw = JSON.parse(fs.readFileSync(path.join(DATA, "hearthstone_cards_zhCN.json"), "utf8"));
const list = Array.isArray(raw) ? raw : raw.cards;
const meta = JSON.parse(fs.readFileSync(path.join(DATA, "cards-meta.json"), "utf8"));

const COLLECTIBLE_TYPES = new Set(["MINION", "SPELL", "HERO", "WEAPON", "LOCATION"]);
const isCollectibleRaw = (c) => {
  if (!COLLECTIBLE_TYPES.has(c.type || "")) return false;
  const s = c.set || "";
  if (s === "VANILLA") return false;
  if (s === "CORE") return true;
  return !!c.collectible;
};

// 名称名次：与前端一致（Intl.Collator("zh-Hans-CN") 排序后的下标）
const collator = new Intl.Collator("zh-Hans-CN");
const names = [...new Set(list.map((c) => c.name || ""))].sort(collator.compare);
const rank = new Map(names.map((n, i) => [n, i]));

const byId = new Map();
for (const c of list) if (c.id) byId.set(c.id, c);

const SPECIAL_ATTACHED = {
  TOY_330: ["TOY_330t92", "TOY_330t93", "TOY_330t94", "TOY_330t95", "TOY_330t96", "TOY_330t97", "TOY_330t98", "TOY_330t99"],
};

// 奇闻卡：id 前缀 <base>t<纯数字> 的卡是它的专属附属
const CURIO_RE = /<b>\s*奇闻/;
const idList = [...byId.keys()];
function curioAttached(baseId) {
  const prefix = baseId + "t";
  const hits = [];
  for (const cid of idList) {
    if (!cid.startsWith(prefix)) continue;
    const suffix = cid.slice(prefix.length);
    if (suffix === "" || /^\d+$/.test(suffix)) hits.push(byId.get(cid).dbfId || 0);
  }
  return hits.filter(Boolean).sort((a, b) => a - b);
}

const rows = list.map((c) => {
  const races = Array.isArray(c.races) ? c.races : (Array.isArray(c.race) ? c.race : []);
  const ent = Array.isArray(c.entourage) ? c.entourage : [];
  const attachedIds = [];
  const pushId = (id) => { const t = byId.get(id); if (t && t.dbfId) attachedIds.push(t.dbfId); };
  for (const id of ent) if (byId.has(id) && /^[A-Z0-9_]+$/i.test(id)) pushId(id);
  for (const id of (SPECIAL_ATTACHED[c.id] || [])) pushId(id);
  if (c.id && CURIO_RE.test(c.text || "")) for (const d of curioAttached(c.id)) attachedIds.push(d);
  return [
    c.dbfId || 0,
    c.id || "",
    c.name || "",
    c.cost === undefined ? null : c.cost,
    c.attack === undefined ? null : c.attack,
    c.health === undefined ? null : c.health,
    c.durability === undefined ? null : c.durability,
    c.armor === undefined ? null : c.armor,
    c.cardClass || "NEUTRAL",
    c.type || "",
    c.rarity || "",
    c.set || "",
    races,
    c.spellSchool || "",
    c.text || "",
    (c.mechanics || []).slice(0, 8),
    isCollectibleRaw(c) ? 1 : 0,
    c.elite ? 1 : 0,
    c.runeCost || null,
    c.artist || "",
    c.flavor || "",
    rank.get(c.name || "") ?? 0,
    [...new Set(attachedIds)],
  ];
});

const FIELDS = ["dbfId", "id", "name", "cost", "attack", "health", "durability", "armor", "cardClass", "type", "rarity", "set", "races", "spellSchool", "text", "mechanics", "collectible", "elite", "runeCost", "artist", "flavor", "nameRank", "attached"];
const json = JSON.stringify({ v: 1, fields: FIELDS, total: rows.length, meta, rows });

fs.writeFileSync(path.join(DATA, "cards-lite.json"), json, "utf8");
fs.writeFileSync(path.join(DATA, "meta.json"), JSON.stringify(meta), "utf8");

console.log("cards-lite.json", (json.length / 1048576).toFixed(2), "MB / 行数", rows.length);
console.log("可收藏", rows.filter((r) => r[16]).length, "英雄", rows.filter((r) => r[9] === "HERO").length,
  "带附属卡", rows.filter((r) => r[22].length).length);

// ---- 首屏静态包 data/first.json --------------------------------------------
// 与 /api/boot 同形：meta + 第一页 200 张 + HERO_LIST 的 11 张英雄卡。
// 前端首屏直接取它，不经过边缘函数（省掉 4 个往返，还能被浏览器缓存 1 小时）。
const { pathToFileURL } = await import("url");
const { createDb } = await import(pathToFileURL(path.join(ROOT, "functions", "_lib", "cards-db.js")).href);
const db = createDb(JSON.parse(json), meta);

const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
const heroAt = appJs.indexOf("const HERO_LIST");
const heroDbf = [...appJs.slice(heroAt, heroAt + 2000).matchAll(/dbfId:\s*(\d+)/g)].map((m) => Number(m[1])).slice(0, 11);

const boot = db.boot(200);
const heroes = db.lookup(heroDbf);
const firstJson = JSON.stringify({
  ok: true,
  result: { meta: boot.meta, cards: boot.cards, total: boot.total, heroes, page_ms: boot.page_ms, built_at: new Date().toISOString() },
});
fs.writeFileSync(path.join(DATA, "first.json"), firstJson, "utf8");
console.log("first.json", (firstJson.length / 1024).toFixed(1), "KB / 首屏", boot.cards.length, "张 / 英雄", heroes.length, "张");
