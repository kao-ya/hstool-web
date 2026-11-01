// ============================================================
// 纯前端数据层（替代原 Python 后端的 /api/*）
// ------------------------------------------------------------
// 数据来源：**官方原始 JSON**（hearthstone_cards_zhCN.json，约 10.4 MB / 36022 张）
//   直接 fetch 原始数组，不做任何裁剪 —— 保证搜索/筛选能命中全部卡牌，
//   包括衍生 token（树苗、变形形态、图腾、法术衍生物等）。
//   代价：首屏需下载 10.4MB（gzip 后约 2-3MB），比裁剪版慢，但卡全。
//
// 另有 cards-meta.json（约 165KB）提供原始 JSON 里没有的东西：
//   系列中文名 / 系列分组 / 中文映射表 / 图床前缀
//   —— 这些是静态常量，不随卡牌数据变化，单独放一个小文件便于缓存复用。
// ============================================================

const CARDS_URL = "data/hearthstone_cards_zhCN.json";
const CARDS_META_URL = "data/cards-meta.json";

// 全局卡库（加载后填充）
const DB = {
  ready: false,
  error: null,
  loadSeconds: 0,
  cards: [],          // 原始记录数组（已解码枚举）
  byDbf: new Map(),   // dbfId -> card
  byId: new Map(),    // cardId -> card
  byName: new Map(),  // 卡名 -> card（首个）
  collectibleCount: 0,
  maps: {},           // class/rarity/type/set/race/spellSchool 中文映射
  imageBase: {},
  sets: [],
};

// ------------------------------------------------------------
// 卡组代码常量（与后端 hstool.py 保持一致）
// ------------------------------------------------------------
const HEADER_MAGIC = 0;
const TRAILER_MAGIC = 0;
const DEFAULT_VERSION = 1;
const FORMAT_NAMES = { 1: "狂野", 2: "标准" };
const OFFICIAL_FORMAT_NAMES = { 1: "狂野模式", 2: "标准模式" };
const OFFICIAL_TITLE = "由HsTool生成";

// Base64 <-> 字节数组
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ------------------------------------------------------------
// Varint 读写
// ------------------------------------------------------------
function makeByteReader(bytes) {
  let pos = 0;
  return {
    readByte() {
      if (pos >= bytes.length) throw new Error("Varint 读取越界");
      return bytes[pos++];
    },
    eof() { return pos >= bytes.length; },
  };
}
function readVarint(r) {
  let result = 0, shift = 0;
  for (;;) {
    const byte = r.readByte();
    result += (byte & 0x7f) * Math.pow(2, shift);
    if (!(byte & 0x80)) return result;
    shift += 7;
  }
}
function readVarintList(r) {
  const n = readVarint(r);
  const out = [];
  for (let i = 0; i < n; i++) out.push(readVarint(r));
  return out;
}
function writeVarint(out, value) {
  if (value < 0) throw new Error("Varint 不支持负数");
  let v = value;
  for (;;) {
    const byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) out.push(byte | 0x80);
    else { out.push(byte); return; }
  }
}

// ------------------------------------------------------------
// 卡组代码解码
// ------------------------------------------------------------
function decodeDeckstring(deckStr) {
  const s = (deckStr || "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Error("卡组代码含有非法字符");
  let raw;
  try {
    raw = b64ToBytes(s);
  } catch (e) {
    throw new Error("无法解码 Base64：" + e.message);
  }
  const r = makeByteReader(raw);

  const header = readVarint(r);
  if (header !== HEADER_MAGIC) throw new Error("无效卡组串：头部应为 0，实际为 " + header);

  const version = readVarint(r);
  const fmt = readVarint(r);
  const heroDbf = readVarintList(r);

  const singles = readVarintList(r).map(id => [id, 1]);
  const doubles = readVarintList(r).map(id => [id, 2]);

  // 乐队（sideboard）段：跳过「3张及以上」卡块，再读 0x01 标记 + 数量 + (卡, 归属) 对
  const sideboard = [];
  try {
    const nBlock = readVarint(r);
    for (let i = 0; i < nBlock; i++) { readVarint(r); readVarint(r); }
    const marker = readVarint(r);
    if (marker === 1) {
      for (;;) {
        const cnt = readVarint(r);
        if (!cnt) break;
        for (let i = 0; i < cnt; i++) sideboard.push([readVarint(r), readVarint(r)]);
      }
    }
  } catch (e) { /* 无乐队段，正常 */ }

  return { version, format: fmt, hero_dbf: heroDbf, cards: singles.concat(doubles), sideboard };
}

// ------------------------------------------------------------
// 卡组代码编码
// ------------------------------------------------------------
function encodeDeckstring(heroes, cards, fmt, version, sideboard) {
  if (version === undefined || version === null) version = DEFAULT_VERSION;
  if (fmt === undefined || fmt === null) fmt = 1;
  const bad = cards.filter(([, cnt]) => cnt !== 1 && cnt !== 2);
  if (bad.length) throw new Error("卡牌数量只支持 1 或 2：" + JSON.stringify(bad));

  const out = [];
  writeVarint(out, HEADER_MAGIC);
  writeVarint(out, version);
  writeVarint(out, fmt);

  writeVarint(out, heroes.length);
  heroes.forEach(h => writeVarint(out, h));

  const singles = cards.filter(([, c]) => c === 1).map(([id]) => id).sort((a, b) => a - b);
  const doubles = cards.filter(([, c]) => c === 2).map(([id]) => id).sort((a, b) => a - b);

  writeVarint(out, singles.length);
  singles.forEach(id => writeVarint(out, id));
  writeVarint(out, doubles.length);
  doubles.forEach(id => writeVarint(out, id));

  writeVarint(out, 0);   // 「3张及以上」卡块：空

  if (sideboard && sideboard.length) {
    writeVarint(out, 1);
    writeVarint(out, sideboard.length);
    sideboard.forEach(([c, o]) => { writeVarint(out, c); writeVarint(out, o); });
    writeVarint(out, 0); // 乐队段终止标记（缺了游戏不认）
  }
  writeVarint(out, TRAILER_MAGIC);

  return bytesToB64(new Uint8Array(out));
}

// ------------------------------------------------------------
// 文本解析：官方格式 / 卡名列表
// ------------------------------------------------------------
const DECK_CODE_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DBF_IN_TEXT_RE = /DBF\s*[:#]?\s*(\d+)/i;
const CARD_LINE_RE = /^(.+?)(?:\s*[x×*]\s*(\d+)|\s+(\d{1,2}))?\s*$/;

function parseOfficialDeck(text) {
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (DECK_CODE_RE.test(line)) return line;
  }
  return null;
}

function extractDbfId(text) {
  const m = String(text || "").match(DBF_IN_TEXT_RE);
  if (m) return parseInt(m[1], 10);
  const t = String(text || "").trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return null;
}

function lookupToken(token) {
  const t = String(token || "").trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    return DB.byDbf.has(n) ? n : null;
  }
  const dbf = extractDbfId(t);
  if (dbf !== null) return DB.byDbf.has(dbf) ? dbf : null;
  // 按卡名查（去掉 "(DBF xxx)" 尾巴）
  const name = t.replace(/\(DBF\s*\d+\)/i, "").trim();
  const c = DB.byName.get(name);
  return c ? c.dbfId : null;
}

function parseHeroes(raw) {
  const lines = String(raw || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const result = [], unknown = [];
  for (const line of lines) {
    const dbf = lookupToken(line);
    if (dbf === null) unknown.push(line);
    else result.push(dbf);
  }
  if (unknown.length) throw new Error("无法识别的英雄：\n  " + unknown.join("\n  "));
  return result;
}

function splitCardLine(line) {
  const m = CARD_LINE_RE.exec(line);
  if (!m) return [line || null, line ? 1 : 0];
  const count = parseInt(m[2] || m[3] || 1, 10);
  return [m[1].trim(), count];
}

function parseCards(raw) {
  const lines = String(raw || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const entries = [], unknown = [];
  for (const line of lines) {
    const [name, count] = splitCardLine(line);
    if (name === null) { unknown.push(line); continue; }
    const dbf = lookupToken(name);
    if (dbf === null) { unknown.push(line); continue; }
    entries.push([dbf, count]);
  }
  if (unknown.length) throw new Error("无法识别的卡牌：\n  " + unknown.join("\n  "));
  return entries;
}

// ------------------------------------------------------------
// 显示辅助
// ------------------------------------------------------------
function cardByDbf(dbf) { return DB.byDbf.get(Number(dbf)); }

function displayDbf(dbf) {
  const c = cardByDbf(dbf);
  return c ? (c.name + "(DBF " + dbf + ")") : ("未知卡牌(DBF " + dbf + ")");
}

function decodeFromContent(content) {
  const stripped = String(content || "").trim();
  if (!stripped.includes("\n") && DECK_CODE_RE.test(stripped)) return decodeDeckstring(stripped);
  const code = parseOfficialDeck(content);
  if (!code) {
    const compact = stripped.replace(/\s+/g, "");
    if (DECK_CODE_RE.test(compact)) return decodeDeckstring(compact);
    throw new Error("输入里没有找到有效的卡组代码。");
  }
  return decodeDeckstring(code);
}

function formatDecoded(info) {
  const fmtName = FORMAT_NAMES[info.format] || ("未知(" + info.format + ")");
  const heroNames = info.hero_dbf.map(h => displayDbf(h));
  const total = info.cards.reduce((s, [, c]) => s + c, 0);
  const lines = [
    "版本     : " + info.version,
    "模式     : " + fmtName,
    "英雄     : " + (heroNames.length ? heroNames.join(", ") : "（无）"),
    "卡牌总数 : " + total,
    "",
    "卡牌列表：",
  ];
  info.cards.forEach(([dbf, count]) => {
    lines.push("  · " + displayDbf(dbf) + " × " + count);
  });
  const sb = info.sideboard || [];
  if (sb.length) {
    lines.push("");
    lines.push("乐队卡牌 : " + sb.length + " 张（不计入卡组总数）");
    sb.forEach(([cd, od]) => {
      lines.push("  ※ " + displayDbf(cd) + " 〔归属：" + displayDbf(od) + "〕");
    });
  }
  return lines.join("\n");
}

function formatOfficialDeck(heroes, cards, fmt, code, title) {
  let classKey = null;
  for (const h of heroes) {
    const c = cardByDbf(h);
    if (c && c.cardClass && c.cardClass !== "NEUTRAL") { classKey = c.cardClass; break; }
  }
  const classCn = classKey ? (DB.maps.class[classKey] || "未知") : "未知";
  const fmtText = OFFICIAL_FORMAT_NAMES[fmt] || ("未知模式(" + fmt + ")");
  const lines = [
    "### " + (title || OFFICIAL_TITLE),
    "# 职业：" + classCn,
    "# 模式：" + fmtText,
    "#",
  ];
  const sorted = cards.slice().sort((a, b) => {
    const ca = cardByDbf(a[0]), cb = cardByDbf(b[0]);
    const va = (ca && ca.cost != null) ? ca.cost : 99;
    const vb = (cb && cb.cost != null) ? cb.cost : 99;
    if (va !== vb) return va - vb;
    return displayDbf(a[0]).localeCompare(displayDbf(b[0]));
  });
  sorted.forEach(([dbf, count]) => {
    const c = cardByDbf(dbf);
    const cost = (c && c.cost != null) ? String(c.cost) : "?";
    lines.push("# " + count + "x (" + cost + ") " + displayDbf(dbf));
  });
  lines.push("# ");
  if (code) lines.push(code);
  lines.push("# ");
  lines.push('# 想要使用这副套牌，请先复制到剪贴板，然后在游戏中点击"新套牌"进行粘贴。');
  return lines.join("\n");
}

// ------------------------------------------------------------
// 卡牌搜索（对应后端 CardDatabase.search_cards）
// ------------------------------------------------------------
function asValueSet(value) {
  if (value === undefined || value === null) return new Set();
  if (Array.isArray(value)) {
    return new Set(value.filter(v => v !== undefined && v !== null && String(v) !== "").map(String));
  }
  if (String(value) === "") return new Set();
  return new Set([String(value)]);
}

function searchCards(query, filters, offset, limit, sort) {
  query = (query || "").trim().toLowerCase();
  const queryIsDbf = /^\d+$/.test(query);
  filters = filters || {};
  offset = offset || 0;
  if (limit === undefined || limit === null) limit = 200;

  const collectibleFilter = asValueSet(filters.collectible);
  const cardClassFilter = asValueSet(filters.cardClass);
  const typeFilter = asValueSet(filters.type);
  const rarityFilter = asValueSet(filters.rarity);
  const setFilter = asValueSet(filters.set);
  const costFilter = asValueSet(filters.cost);
  const raceFilter = asValueSet(filters.race);
  const schoolFilter = asValueSet(filters.spellSchool);
  const hasCostFilter = costFilter.size > 0 || (
    filters.cost !== undefined && filters.cost !== null && String(filters.cost) !== ""
  );

  const all = [];
  for (const card of DB.cards) {
    const isCol = isCollectible(card);
    if (query) {
      const inName = card.name.toLowerCase().includes(query);
      const inText = (card.text || "").toLowerCase().includes(query);
      const inId = (card.id || "").toLowerCase().includes(query);
      if (!inName && !inText && !inId) {
        if (!(queryIsDbf && String(card.dbfId).startsWith(query))) continue;
      }
    }
    if (collectibleFilter.size) {
      const yes = collectibleFilter.has("yes"), no = collectibleFilter.has("no");
      if (yes && !no) { if (!isCol) continue; }
      else if (no && !yes) { if (isCol) continue; }
      // yes + no 同时勾选 = 不限
    }
    if (cardClassFilter.size && !cardClassFilter.has(card.cardClass || "")) continue;
    if (typeFilter.size && !typeFilter.has(card.type || "")) continue;
    if (rarityFilter.size && !rarityFilter.has(card.rarity || "")) continue;
    if (setFilter.size && !setFilter.has(card.set || "")) continue;
    if (raceFilter.size) {
      const races = card.races || [];
      if (!races.some(r => raceFilter.has(r))) continue;
    }
    if (schoolFilter.size) {
      const sc = card.spellSchool || "";
      if (!schoolFilter.has(sc)) continue;
    }
    if (hasCostFilter) {
      const cc = card.cost;
      let matched = false;
      for (const cf of costFilter) {
        if (cf === "10plus") {
          if (cc != null && cc >= 10) { matched = true; break; }
        } else if (cc === parseInt(cf, 10)) { matched = true; break; }
      }
      if (!matched) continue;
    }
    all.push(card);
  }

  sortCardList(all, sort || "default");

  const total = all.length;
  return { cards: all.slice(offset, offset + limit), total, offset, shown: Math.min(limit, Math.max(0, total - offset)) };
}

// ------------------------------------------------------------
// 卡牌详情（对应后端 /api/cards/detail）
// ------------------------------------------------------------
function cardDetail(dbfId) {
  const c = cardByDbf(dbfId);
  if (!c) throw new Error("未找到该卡牌");
  const id = c.id || "";
  return Object.assign({}, c, {
    class_cn: DB.maps.class[c.cardClass] || c.cardClass || "",
    type_cn: DB.maps.type[c.type] || c.type || "",
    rarity_cn: DB.maps.rarity[c.rarity] || c.rarity || "",
    set_cn: DB.maps.set[c.set] || c.set || "",
    race_cn: (c.races || []).map(r => DB.maps.race[r] || r).join(" "),
    spellSchool_cn: DB.maps.spellSchool[c.spellSchool] || c.spellSchool || "",
    image_256: id ? (DB.imageBase["256"] + id + ".png") : "",
    image_512: id ? (DB.imageBase["512"] + id + ".png") : "",
    image_orig: id ? (DB.imageBase["orig"] + id + ".png") : "",
    entourage: c.entourage || [],
    attached_dbf: c.attached_dbf || [],
  });
}

// ------------------------------------------------------------
// api() —— 保持原调用签名不变，内部改为本地同步计算。
// 原前端 15 处 api(...) 调用无需改动即可工作。
// ------------------------------------------------------------
async function api(path, data) {
  data = data || {};
  switch (path) {
    case "/api/status":
      return {
        ready: DB.ready,
        count: DB.byDbf.size,
        card_count: DB.cards.length,
        collectible_count: DB.collectibleCount,
        hero_count: DB.cards.filter(c => c.type === "HERO").length,
        error: DB.error,
        load_seconds: Math.round(DB.loadSeconds * 100) / 100,
      };
    case "/api/sets":
      return { sets: DB.sets };
    case "/api/heroes":
      return { heroes: DB.cards.filter(c => c.type === "HERO") };
    case "/api/decode": {
      const content = (data.content || "").trim();
      if (!content) throw new Error("请先粘贴卡组代码或官方格式文本。");
      const info = decodeFromContent(content);
      return {
        text: formatDecoded(info),
        heroes_lines: info.hero_dbf.map(h => displayDbf(h)).join("\n"),
        cards_lines: info.cards.map(([cid, cnt]) => displayDbf(cid) + " × " + cnt).join("\n"),
        sideboard_pairs: info.sideboard || [],
        format: info.format,
      };
    }
    case "/api/encode": {
      const heroes = parseHeroes(data.heroes || "");
      const cards = parseCards(data.cards || "");
      const fmt = parseInt(data.format || 1, 10);
      const sideboard = [];
      for (const pair of (data.sideboard || [])) {
        const c = parseInt(pair[0], 10), o = parseInt(pair[1], 10);
        if (c > 0 && o > 0) sideboard.push([c, o]);
      }
      return { text: encodeDeckstring(heroes, cards, fmt, undefined, sideboard.length ? sideboard : null) };
    }
    case "/api/export": {
      const heroes = parseHeroes(data.heroes || "");
      const cards = parseCards(data.cards || "");
      const fmt = parseInt(data.format || 1, 10);
      const code = encodeDeckstring(heroes, cards, fmt);
      return { text: formatOfficialDeck(heroes, cards, fmt, code) };
    }
    case "/api/cards/search":
      return searchCards(data.query || "", data.filters || {},
                         parseInt(data.offset || 0, 10),
                         parseInt(data.limit || 200, 10),
                         data.sort || "default");
    case "/api/cards/detail":
      if (data.dbfId === undefined || data.dbfId === null) throw new Error("缺少 dbfId 参数");
      return cardDetail(parseInt(data.dbfId, 10));
    default:
      throw new Error("未知路径：" + path);
  }
}

// 把解码/编码抛出的内部异常翻译成用户看得懂的一句话（B7）
// 只覆盖「卡组码不完整」「粘的不是码」这两类高频原因，其余原样返回，
// 免得把没见过的新错误藏起来。
function friendlyError(e) {
  const raw = String((e && e.message) || e || "");
  if (/base64|Base64|padding|atob/i.test(raw)) {
    return "这串卡组码不完整：末尾的字符缺失了，请回游戏里重新完整复制一次";
  }
  if (/Varint|越界|超出|out of range|eof|EOF/i.test(raw)) {
    return "这串卡组码不完整：复制时少了开头或结尾的字符，请回游戏里重新完整复制一次";
  }
  if (/头部|魔数|不是卡组|无法识别|invalid/i.test(raw)) {
    return "这串不是卡组码：卡组码是一长串字母数字（通常以 AAE 开头），请检查是不是粘错了内容";
  }
  return raw;
}

// ------------------------------------------------------------
// 卡库加载（替代原后端启动时的 pickle/json 读取）
// ------------------------------------------------------------
// 归一化一张卡：原始 JSON 的字段是「有则给、无则缺」，
// 这里补成前端各处的统一预期（空串/空数组/布尔），
// 避免 `undefined !== ""` 这类隐形比较差异。
// 可通过开包 / 合成获得的卡牌类型。
// 数据源里 collectible=true 只出现在这五种（随从 4749 / 法术 2304 / 英雄 810 /
// 武器 245 / 地标 62）。附魔、英雄技能、战棋对象、佣兵技能等类型天生不可收藏，
// 即便系列是 CORE 也不该被放行 —— 实测旧规则会把 CORE 里的 24 张附魔误判为可收藏。
const COLLECTIBLE_TYPES = new Set(["MINION", "SPELL", "HERO", "WEAPON", "LOCATION"]);

// 「可收藏」裸判定（不依赖 normalizeCard，供其调用）。
// 顺序：① 类型门 → ② 系列白/黑名单 → ③ 回落数据源字段。
function isCollectibleRaw(c) {
  if (!COLLECTIBLE_TYPES.has(c.type || "")) return false;
  const s = c.set || "";
  if (s === "VANILLA") return false;   // 经典是版本环境标记，当前环境下不可收藏
  if (s === "CORE") return true;       // 核心数据源漏标，强制放行（仅限上面五种类型）
  return !!c.collectible;
}

function normalizeCard(c) {
  const o = Object.assign({}, c);
  o.id = c.id || "";
  o.name = c.name || "";
  o.set = c.set || "";
  o.type = c.type || "";
  o.rarity = c.rarity || "";
  o.cardClass = c.cardClass || "NEUTRAL";
  o.spellSchool = c.spellSchool || "";
  o.text = c.text || "";
  // 可收藏判定走统一入口：不能只看数据源字段。
  // 原始 JSON 里 VANILLA（经典环境标记）的卡 collectible 为 true 但当前环境不可收藏，
  // CORE（核心）则反过来——游戏内能用但数据源漏标。
  o.collectible = isCollectibleRaw(o);
  o.mechanics = c.mechanics || [];
  o.entourage = c.entourage || [];
  // 完整种族列表：race（主种族）与 races（多种族卡的完整列表）取并集。
  // 两者对 248 张卡不一致，必须合并，否则多种族卡会被漏判。
  const races = [];
  for (const r of (c.races || [])) if (r && races.indexOf(r) < 0) races.push(r);
  const r1 = c.race;
  for (const r of (Array.isArray(r1) ? r1 : [r1])) {
    if (r && races.indexOf(r) < 0) races.push(r);
  }
  o.races = races;
  o.race = c.race || "";
  // 原始 JSON 没有 attached_dbf（奇闻附属），改为按 id 前缀在建立索引后补齐。
  o.attached_dbf = [];
  return o;
}

async function loadCardDatabase() {
  const t0 = performance.now();
  // 用 no-cache（不是 no-store）：每次加载都向服务器确认一次，
  // 文件没变时服务器回 304，几乎不花流量；文件变了才重新下载。
  // 原来写的是 force-cache —— 那会让浏览器一直用本地旧副本，卡库更新后
  // 用户界面上的卡牌总数永远停在旧数字（必须手动清缓存才会变），
  // 所以这里绝不能图省事写 force-cache。
  const [cardsResp, metaResp] = await Promise.all([
    fetch(CARDS_URL, { cache: "no-cache" }),
    fetch(CARDS_META_URL, { cache: "no-cache" }),
  ]);
  if (!cardsResp.ok) throw new Error("加载 " + CARDS_URL + " 失败（HTTP " + cardsResp.status + "）");
  if (!metaResp.ok) throw new Error("加载 " + CARDS_META_URL + " 失败（HTTP " + metaResp.status + "）");

  const rawCards = await cardsResp.json();
  const meta = await metaResp.json();

  DB.maps = meta.maps || {};
  DB.imageBase = meta.imageBase || {};
  DB.sets = meta.sets || [];

  // 原始 JSON 是数组；兼容一下万一被包成 {cards:[...]} 的情况
  const list = Array.isArray(rawCards) ? rawCards : (rawCards.cards || []);

  DB.cards = [];
  DB.byDbf.clear();
  DB.byId.clear();
  DB.byName.clear();
  DB.collectibleCount = 0;

  for (const rc of list) {
    if (!rc || rc.dbfId === undefined || rc.dbfId === null || !rc.name) continue;
    const c = normalizeCard(rc);
    DB.cards.push(c);
    DB.byDbf.set(c.dbfId, c);
    if (c.id) DB.byId.set(c.id, c);
    if (!DB.byName.has(c.name)) DB.byName.set(c.name, c);
    if (c.collectible) DB.collectibleCount++;
  }

  // ---- 补 attached_dbf（奇闻卡附属）：id 前缀 <base>t<后缀为空或纯数字> ----
  // 原始 JSON 不带这个字段，但详情弹窗的「附属卡」面板要用；
  // 判定依据与后端一致：text 里有「奇闻」标记的卡才算奇闻卡。
  const CURIO_RE = /<b>\s*奇闻/;
  const curioBases = [];
  for (const c of DB.cards) {
    if (c.text && CURIO_RE.test(c.text)) curioBases.push(c);
  }
  if (curioBases.length) {
    for (const base of curioBases) {
      if (!base.id) continue;
      const prefix = base.id + "t";
      const hits = [];
      for (const [cid, c] of DB.byId) {
        if (!cid.startsWith(prefix)) continue;
        const suffix = cid.slice(prefix.length);
        if (suffix === "" || /^\d+$/.test(suffix)) hits.push(c.dbfId);
      }
      hits.sort((x, y) => x - y);
      base.attached_dbf = hits;
    }
  }

  DB.loadSeconds = (performance.now() - t0) / 1000;
  DB.ready = true;
  DB.error = null;

  // 自检：可收藏数、奇闻数，便于排查数据问题
  DB.curioCount = curioBases.length;
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), 1800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); document.body.removeChild(ta);
    toast("已复制到剪贴板");
  }
}

function setOutput(el, text) {
  if (text) { el.textContent = text; el.classList.remove("empty"); }
  else { el.textContent = "结果将显示在这里"; el.classList.add("empty"); }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ============================================================
// 内联 SVG 图标（替代 emoji，跟随 currentColor 自动适配明暗主题）
// ============================================================
const ICON_MOON   = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const ICON_SUN    = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const ICON_SHIELD = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/></svg>';
const ICON_CARD   = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 13h6M7 16h4"/></svg>';
const ICON_PLUS   = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

// ============================================================
// 职业列表
// ============================================================
const CLASS_LIST = [
  ["DEMONHUNTER", "恶魔猎手"],
  ["DEATHKNIGHT", "死亡骑士"],
  ["DRUID", "德鲁伊"],
  ["HUNTER", "猎人"],
  ["MAGE", "法师"],
  ["PALADIN", "圣骑士"],
  ["PRIEST", "牧师"],
  ["ROGUE", "潜行者"],
  ["SHAMAN", "萨满祭司"],
  ["WARLOCK", "术士"],
  ["WARRIOR", "战士"],
  ["NEUTRAL", "中立"],
];

// ============================================================
// 11个职业英雄
// ============================================================
const HERO_LIST = [
  { dbfId: 7,     cardId: "HERO_01", name: "加尔鲁什", cardClass: "WARRIOR" },
  { dbfId: 1066,  cardId: "HERO_02", name: "萨尔",     cardClass: "SHAMAN" },
  { dbfId: 930,   cardId: "HERO_03", name: "瓦莉拉",   cardClass: "ROGUE" },
  { dbfId: 671,   cardId: "HERO_04", name: "乌瑟尔",   cardClass: "PALADIN" },
  { dbfId: 31,    cardId: "HERO_05", name: "雷克萨",   cardClass: "HUNTER" },
  { dbfId: 274,   cardId: "HERO_06", name: "玛法里奥", cardClass: "DRUID" },
  { dbfId: 893,   cardId: "HERO_07", name: "古尔丹",   cardClass: "WARLOCK" },
  { dbfId: 813,   cardId: "HERO_09", name: "安度因",   cardClass: "PRIEST" },
  { dbfId: 637,   cardId: "HERO_08", name: "吉安娜",   cardClass: "MAGE" },
  { dbfId: 56550, cardId: "HERO_10", name: "伊利丹",   cardClass: "DEMONHUNTER" },
  { dbfId: 78065, cardId: "HERO_11", name: "阿尔萨斯", cardClass: "DEATHKNIGHT" },
];

// ============================================================
// 奥术之尘合成费用
// ============================================================
const DUST_COST = {
  "COMMON": 40,
  "RARE": 100,
  "EPIC": 400,
  "LEGENDARY": 1600,
  "FREE": 0,
};
// 金色卡牌合成费用（官方价目：金卡 = 普通卡的 10/8/4/2 倍，不是统一倍数）
const DUST_COST_GOLD = {
  "COMMON": 400,
  "RARE": 800,
  "EPIC": 1600,
  "LEGENDARY": 3200,
  "FREE": 0,
};
// 系列级的「可收藏」覆盖规则已收敛到 isCollectibleRaw（见文件前半段的
// COLLECTIBLE_TYPES 注释）：① 类型门 → ② VANILLA 排除 / CORE 放行 → ③ 数据源字段。
// 原先这里还有 NON_COLLECTIBLE_SETS / COLLECTIBLE_SETS 两张表，与 isCollectibleRaw
// 各写一遍，正是「CORE 附魔被误判可收藏」的来源，已合并删除。
// 统一的「可收藏」判定：与 normalizeCard 用的 isCollectibleRaw 是同一套规则，
// 这里只是多一层空值保护，避免两处逻辑各写一遍后走样。
function isCollectible(card) {
  if (!card) return false;
  return isCollectibleRaw(card);
}
// ============================================================
// 奇闻卡附属卡排除名单
// ============================================================
const EXCLUDED_ATTACHED_NAMES = new Set([
  // 布洛克斯加：只带第一道，第二、三、四道不带
  "第二道阿古斯传送门", "第三道阿古斯传送门", "最后一道阿古斯传送门",
  // 塔兰吉：三张恩泽不带
  "威力恩泽", "长命恩泽", "速度恩泽",
]);

// ============================================================
// 卡组张数上限（特殊卡改变上限）
// ============================================================
// 规则表：一张「容量规则卡」可对应多个 card id / dbfId，命中即把整套牌的上限改成 size。
//   · 威兹班 / 泽尔是「单卡套牌」（整副只有它自己）
//   · 雷纳索尔在数据里有两个 dbfId（原版 + 核心重制版），两个都要认
//   · 同一套牌里出现两种不同 size 即为冲突，提示用户先移除
const DECK_SIZE_RULES = [
  { ids: ["BOT_914", "DAL_800", "TOY_700"], dbfIds: [50477, 56047, 104819], size: 1,  name: "威兹班或泽尔" },
  { ids: ["JAIL_430"],                      dbfIds: [126055],              size: 20, name: "裂魂者阿扎莉娜" },
  { ids: ["REV_018"],                       dbfIds: [79767, 111689],       size: 40, name: "雷纳索尔王子" },
  { ids: ["TIME_005"],                      dbfIds: [119432],              size: 40, name: "时空大盗拉法姆" },
];

// dbfId → 规则，用于 O(1) 命中
const DECK_SIZE_BY_DBF = new Map();
DECK_SIZE_RULES.forEach(r => r.dbfIds.forEach(d => DECK_SIZE_BY_DBF.set(d, r)));

// 卡牌命中的容量规则（没命中返回 null）。传 card 对象或 dbfId 都行。
// 核心系列卡（CORE_ 前缀）按本体 id 认，否则会漏掉重制版。
function deckSizeRuleOf(cardOrId) {
  let card = cardOrId;
  if (typeof card === "number") {
    const direct = DECK_SIZE_BY_DBF.get(card);
    if (direct) return direct;
    const entry = deckState.cards.get(card);
    card = (entry && entry.card) || cardCache.get(card);
    if (!card) return null;
  }
  if (!card || typeof card !== "object") return null;
  if (typeof card.dbfId === "number") {
    const hit = DECK_SIZE_BY_DBF.get(card.dbfId);
    if (hit) return hit;
  }
  const id = String(card.id || "").replace(/^CORE_/, "");
  if (!id) return null;
  for (const r of DECK_SIZE_RULES) {
    if (r.ids.indexOf(id) >= 0) return r;
  }
  return null;
}

// 卡组内命中的全部规则（去重）
function deckSizeRulesInDeck() {
  const out = [];
  deckState.cards.forEach(e => {
    const r = deckSizeRuleOf(e.card);
    if (r && out.indexOf(r) < 0) out.push(r);
  });
  return out;
}

// 当前上限：多张规则卡并存时取最严格（最小）的那个；没有规则卡 = 30 张
function getDeckLimit() {
  const sizes = deckSizeRulesInDeck().map(r => r.size);
  return sizes.length ? Math.min.apply(null, sizes) : 30;
}

// 加入某张卡之前的上限冲突校验，返回提示文案（空串 = 放行）
// 覆盖三种情况：单卡套牌独占、单卡套牌卡加入已有卡组、两种不同张数规则并存
function deckSizeConflictMessage(card) {
  const self = deckSizeRuleOf(card);
  const rules = deckSizeRulesInDeck();
  // 卡组里除了这张卡本身，还有没有别的卡
  const hasOtherCards = Array.from(deckState.cards.values())
    .some(e => !card || e.card.dbfId !== card.dbfId);

  const single = rules.find(r => r.size === 1);
  if (single && hasOtherCards && self !== single) {
    return "「" + single.name + "」是单卡套牌，不能再加入其他卡牌";
  }
  if (!self) return "";
  if (self.size === 1 && hasOtherCards) {
    return "「" + self.name + "」需单独组成单卡套牌，请先移除其他卡牌";
  }
  const conflict = rules.find(r => r !== self && r.size !== self.size);
  if (conflict) {
    return "「" + self.name + "」要求 " + self.size + " 张构筑，与「" +
      conflict.name + "」的 " + conflict.size + " 张要求冲突，请先移除该牌";
  }
  return "";
}

// 计入上限的总张数（奇闻卡附属 token 同样占用卡位）
function getDeckTotalForLimit() {
  let total = 0;
  deckState.cards.forEach(e => {
    total += e.count;
  });
  return total;
}

// ============================================================
// 乐队（sideboard）：归属卡的备选卡 / 定制模块
// ============================================================
const BAND_MAX_SIZE = 3;

// 归属卡配置表：统一管理每张「乐队/定制」归属卡的表现与配额，新增归属卡只需在此追加一行
//   label      = 归属条文案
//   max        = 乐队上限     kind = "zilliax" 时启用「2 功能模块 + 1 外观模块」的分类配额
//   accept     = 该归属卡自身的准入门槛（返回 true 才可加入）
//   acceptHint = 不满足 accept 时的提示语
const BAND_OWNER_CONFIG = {
  90749:  { label: "乐队",     max: 3 },                    // 乐队经理精英牛头人酋长
  102983: { label: "定制",     max: 3, kind: "zilliax" },   // 奇利亚斯豪华版3000型
  // 指挥官碧阿崔克丝 —— 官方卡面：「构筑套牌时，选择一张法力值消耗为（2）的随从牌」
  126621: { label: "血色战队", max: 1,
            accept: (c) => c.type === "MINION" && c.cost === 2,
            acceptHint: "只能携带 2 费随从牌" },
  // 下水道之王 —— 官方卡面：「构筑套牌时，选择三张私藏的野兽牌」
  125998: { label: "私藏野兽", max: 3,
            accept: (c) => hasRace(c, "BEAST"),
            acceptHint: "只能携带野兽牌" },
};
const BAND_OWNER_DBFS = Object.keys(BAND_OWNER_CONFIG).map(Number);
// 各归属卡的乐队上限（由配置表派生）
const BAND_MAX_BY_OWNER = Object.fromEntries(
  Object.entries(BAND_OWNER_CONFIG).map(([k, v]) => [Number(k), v.max])
);

function getBandOwnerConfig(ownerDbfId) {
  return BAND_OWNER_CONFIG[ownerDbfId] || null;
}
function getBandMaxSize(ownerDbfId) {
  const cfg = getBandOwnerConfig(ownerDbfId);
  return cfg ? cfg.max : BAND_MAX_SIZE;
}
function getBandLabel(ownerDbfId) {
  const cfg = getBandOwnerConfig(ownerDbfId);
  return cfg ? cfg.label : "乐队";
}

// 判断卡牌是否属于某一种族。
// 种族分散在数据源的两个字段里，必须取**并集**才不漏判：
//   races —— 完整列表（**只有多种族卡才有**，如「重生的翼手龙」= ["UNDEAD","BEAST"]）
//   race  —— 主种族，单字符串（如 "UNDEAD"）
// 只看 race 会漏掉多种族卡的副种族 —— 这正是「重生的翼手龙」
// （race="UNDEAD"、races=["UNDEAD","BEAST"]）进不了「下水道之王」的原因。
// 另外「全部种族」(ALL，如融合怪一类) 视为包含所有种族，故同样命中。
function hasRace(card, raceKey) {
  if (!card) return false;
  const list = [];
  const push = (v) => {
    (Array.isArray(v) ? v : [v]).forEach(x => {
      if (x && !list.includes(x)) list.push(x);
    });
  };
  push(card.races);
  push(card.race);
  if (!list.length) return false;
  return list.includes(raceKey) || list.includes("ALL");
}

// 归属卡自身的准入门槛（由配置表的 accept 定义）
function checkBandOwnerAccept(card, ownerDbfId) {
  const cfg = getBandOwnerConfig(ownerDbfId);
  if (!cfg || !cfg.accept) return { ok: true };
  if (cfg.accept(card)) return { ok: true };
  return { ok: false, reason: "「" + cfg.label + "」" + (cfg.acceptHint || "不接受该卡牌") };
}

// 奇利亚斯（102983）定制：功能模块（XX模块，TOY_330t92~t99，最多2个）+ 外观模块（奇利亚斯豪华版3000型，TOY_330t5~t12，最多1个）
const ZILLIAX_MAX_MODULE = 2;   // 功能模块上限
const ZILLIAX_MAX_COSMETIC = 1; // 外观模块上限
function isZilliaxOwner(ownerDbfId) {
  return ownerDbfId === 102983;
}
// 奇利亚斯的显示费用 = 已装配功能模块费用之和（未装配为 0）
function zilliaxDisplayCost(card) {
  const band = deckState.bands.get(card.dbfId);
  let sum = 0;
  if (band) band.forEach(bc => {
    if (zilliaxModuleKind(bc) === "functional" && typeof bc.cost === "number") sum += bc.cost;
  });
  return sum;
}

// 卡组行 / 法力曲线统一使用的「显示费用」
// 奇利亚斯本体没有固定费用，实际法力值 = 已装配功能模块费用之和（未装配 = 0）；
// 其余卡取卡面费用，无费用的 token / 英雄牌按 0 算，避免曲线出现 NaN 格。
function deckDisplayCost(card) {
  if (!card) return 0;
  if (isZilliaxOwner(card.dbfId)) return zilliaxDisplayCost(card);
  const c = card.cost;
  return (typeof c === "number" && isFinite(c) && c > 0) ? c : 0;
}

// 奇利亚斯乐队卡分类：functional=功能模块 / cosmetic=外观模块
function zilliaxModuleKind(card) {
  const name = card.name || "";
  if (/模块$/.test(name)) return "functional";
  if (name === "奇利亚斯豪华版3000型") return "cosmetic";
  return null;
}
function canBeZilliaxModule(card) {
  if (!card || card.type !== "MINION") return false;
  return zilliaxModuleKind(card) !== null;
}

function isBandOwnerCard(card) {
  return !!card && BAND_OWNER_DBFS.includes(card.dbfId);
}

// 乐队卡准入校验：奇闻卡 / 上限卡（王子、阿扎莉娜、拉法姆）/ 带「对战开始时」效果的卡 均不可
function canBeBandCard(card) {
  if (!card) return { ok: false, reason: "无效卡牌" };
  // 奇闻卡：带附属卡（attached_dbf 判定与组卡器奇闻逻辑一致）
  if (card.attached_dbf && card.attached_dbf.length > 0) {
    return { ok: false, reason: "奇闻卡不能加入乐队" };
  }
  // 卡组上限卡
  if (deckSizeRuleOf(card)) {
    return { ok: false, reason: "「" + card.name + "」不能加入乐队" };
  }
  // 对战开始时效果：只拦「对战开始时：」这类效果触发；
  // 「有对战开始时不在牌库中的牌」等引用描述不拦
  if (card.text && /对战开始时\s*[:：]/.test(card.text)) {
    return { ok: false, reason: "带有「对战开始时」效果的卡不能加入乐队" };
  }
  return { ok: true };
}

// 切换乐队挑选模式：为某个归属卡挑选乐队卡
function toggleBandMode(ownerDbfId) {
  const prevTarget = deckState.bandTarget;
  const wasActive = prevTarget === ownerDbfId;
  deckState.bandTarget = wasActive ? null : ownerDbfId;
  updateBandModeHint();
  renderDeckCards();
  refreshAllCardBadges();
  if (deckState.bandTarget) {
    toast(getBandLabel(ownerDbfId) +
      " 模式：在卡牌预览页点「+」加入（最多 " +
      getBandMaxSize(ownerDbfId) + " 张），再点归属条结束");
  }
  // 奇利亚斯定制模式：预览页只显示模块卡，退出时恢复搜索框原内容
  if (!wasActive && isZilliaxOwner(ownerDbfId)) {
    bandModeSavedQuery = document.getElementById("cardSearch").value;
    document.getElementById("cardSearch").value = "TOY_330t";
    if (previewInitialized) doCardSearch(1);
  } else if (isZilliaxOwner(prevTarget) && bandModeSavedQuery !== null) {
    // 从奇利亚斯模式切走（含直接点牛头人归属条）：同样恢复搜索框
    document.getElementById("cardSearch").value = bandModeSavedQuery;
    bandModeSavedQuery = null;
    if (previewInitialized) doCardSearch(1);
  }
}

// 乐队模式提示条 + 网格高亮
function updateBandModeHint() {
  const el = document.getElementById("bandModeHint");
  if (el) {
    if (deckState.bandTarget && deckState.cards.has(deckState.bandTarget)) {
      const owner = deckState.cards.get(deckState.bandTarget).card;
      const band = deckState.bands.get(deckState.bandTarget);
      const ownerDbf = deckState.bandTarget;
      // 若该归属卡有准入门槛（如「血色战队」只要 2 费随从），在提示条里一并说明，
      // 免得用户反复试错才知道哪些卡能放
      const ownerCfg = getBandOwnerConfig(ownerDbf);
      const limitHint = (ownerCfg && ownerCfg.acceptHint) ? "（" + ownerCfg.acceptHint + "）" : "";
      el.innerHTML = "正在为「" + escapeHtml(owner.name) +
        "」挑选" + getBandLabel(ownerDbf) + "（" +
        (band ? band.size : 0) + "/" + getBandMaxSize(ownerDbf) + "）" + limitHint +
        "，点左侧卡牌「+」加入";
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
  }
  const grid = document.getElementById("cardGrid");
  if (grid) grid.classList.toggle("band-picking", !!deckState.bandTarget);
}

// 某张卡在「主卡组 + 所有乐队」中的**总份数**。
// 乐队（sideboard）里的卡同样占卡位，所以「单卡份数上限」必须跨这两处合并计算。
// 否则会出现「牛内 1 张 + 牛外 2 张」这类越限情况
// （原先上限只校验主卡组，乐队侧完全没有校验）。
function countCardCopies(dbfId) {
  let n = 0;
  const entry = deckState.cards.get(dbfId);
  if (entry) n += entry.count;
  deckState.bands.forEach(band => {
    if (band.has(dbfId)) n += 1;      // 每个乐队最多持有 1 张（band 以 dbfId 为 key）
  });
  return n;
}

// 单卡份数上限：传说 1 张，其余 2 张。
// 该上限跨「主卡组 + 所有乐队」合并生效（配合 countCardCopies 使用）。
function maxCopiesOf(card) {
  return (card && card.rarity === "LEGENDARY") ? 1 : 2;
}

// 超限提示文案（传说与非传说分开措辞）
function overLimitMessage(card, maxCount) {
  return (card && card.rarity === "LEGENDARY")
    ? "「" + card.name + "」为传说卡，卡组与乐队合计仅可携带 1 张"
    : "「" + card.name + "」在卡组与乐队中共可携带 " + maxCount + " 张";
}

// 加入乐队
function addCardToBand(card, ownerDbfId) {
  if (!card) return;
  if (!deckState.cards.has(ownerDbfId)) { toast("乐队归属卡不在卡组中"); return; }
  if (isBandOwnerCard(card)) { toast("乐队卡不能作为归属卡"); return; }
  const bandCheck = canBeBandCard(card);
  if (!bandCheck.ok) { toast(bandCheck.reason); return; }
  // 归属卡自身的准入门槛（如「血色战队」只要 2 费随从、「私藏野兽」只要野兽）
  const ownerCheck = checkBandOwnerAccept(card, ownerDbfId);
  if (!ownerCheck.ok) {
    toast(ownerCheck.reason + "，「" + card.name + "」不可加入");
    return;
  }
  // 单卡份数上限跨「主卡组 + 所有乐队」合并计算：传说 1 张、其余 2 张。
  // 主卡组里已有、或已在其它归属卡的乐队里时，占满名额即不能再放进乐队。
  // 注意：本检查放在「创建 band map」之前 —— 否则被拦下时会在 deckState.bands 里
  // 留下一个空 Map（虽无害，但会污染状态）。
  const bandMaxCopies = maxCopiesOf(card);
  if (countCardCopies(card.dbfId) >= bandMaxCopies) {
    toast(overLimitMessage(card, bandMaxCopies));
    return;
  }
  const maxSize = getBandMaxSize(ownerDbfId);
  let band = deckState.bands.get(ownerDbfId);
  if (!band) { band = new Map(); deckState.bands.set(ownerDbfId, band); }
  if (band.has(card.dbfId)) { toast("乐队中已有「" + card.name + "」"); return; }
  // 奇利亚斯专属：2 个功能模块 + 1 个外观，分类配额校验
  if (isZilliaxOwner(ownerDbfId)) {
    if (!canBeZilliaxModule(card)) { toast("奇利亚斯只能装配模块或外观（随从）"); return; }
    const kind = zilliaxModuleKind(card);
    let funcCount = 0, cosCount = 0;
    band.forEach(bc => {
      if (zilliaxModuleKind(bc) === "functional") funcCount++;
      else cosCount++;
    });
    if (kind === "functional" && funcCount >= ZILLIAX_MAX_MODULE) {
      toast("功能模块最多 " + ZILLIAX_MAX_MODULE + " 个"); return;
    }
    if (kind === "cosmetic" && cosCount >= ZILLIAX_MAX_COSMETIC) {
      toast("外观模块最多 " + ZILLIAX_MAX_COSMETIC + " 个"); return;
    }
  }
  if (band.size >= maxSize) { toast("乐队最多 " + maxSize + " 张卡"); return; }
  band.set(card.dbfId, card);
  updateDeckBadge();          // 乐队卡同样消耗粉尘，加入后必须立即刷新粉尘数
  updateBandModeHint();
  renderDeckCards();
  toast("已加入乐队：" + card.name);
}

// 从乐队移除
function removeCardFromBand(cardDbfId, ownerDbfId) {
  const band = deckState.bands.get(ownerDbfId);
  if (!band) return;
  band.delete(cardDbfId);
  if (band.size === 0) deckState.bands.delete(ownerDbfId);
  updateDeckBadge();          // 移除后同步刷新粉尘数
  updateBandModeHint();
  renderDeckCards();
}

// ============================================================
// 全局状态
// ============================================================
const cardCache = new Map();
const deckState = {
  hero: null,
  format: 1,
  cards: new Map(),
  bands: new Map(),      // 乐队（sideboard）：归属dbfId -> Map(卡dbfId -> 卡对象)
  bandTarget: null,      // 乐队挑选模式：正在为哪个归属卡选乐队卡
  deckName: "HsTool生成"
};

// ============================================================
// 全局设置（持久化于 localStorage: hstool-settings）
// ============================================================
const SETTINGS_KEY = "hstool-settings";
// 默认值集中在此，新增设置项只需改这里 + 面板 HTML
// 面板分「设置 / 关于」两页；「设置」内按 功能 / 布局 / 控件 分三组。
// 约定：凡「XX透明」开关，一律 ON = 该元素透出背景；默认全部关闭。
const DEFAULT_SETTINGS = {
  // —— 功能 ——
  hoverPreview:       true,   // 悬停预览（OFF = 组卡器列表不弹卡图预览）
  cardHoverZoom:      true,   // 悬停放大卡牌（OFF = 卡牌库网格悬停不再放大）
  crystalColor:       true,   // 水晶颜色（OFF = 统一为基准蓝水晶）
  signatureArt:       false,  // 异画卡图（ON = 有异画的卡改用签名版卡面，需联网）
  // —— 布局 ——
  md3Style:           true,   // MD3 风格（OFF = 扁平化：小圆角 / 无阴影 / 无动效）
  compactMode:        false,  // 紧凑布局
  reduceMotion:       false,  // 减弱动效
  bgSolid:            false,  // 背景纯色（ON = 不显示背景图，改用纯色底）
  bgVisibility:       50,     // 背景可见度 0-100，50 = 中等提升
  // —— 控件 ——
  uiTransparent:      false,  // 卡牌面板透明（ON = 面板半透明；OFF = 实色底）
  searchTransparent:  false,  // 搜索栏透明（ON = 搜索与筛选区透出背景）
  previewTransparent: false,  // 预览图背景透明（ON = 卡图加载期间不铺占位底板）
  cardTransparent:    false,  // 卡牌背景透明（ON = 卡面只留描边，透出背景）
  noBorder:           false,  // 去边框去线条（ON = 隐藏静态描边与分隔线）
};
const settings = Object.assign({}, DEFAULT_SETTINGS);

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) || {};
    // 只接受当前已知的键：开关改过名，白名单能避免旧键名在 settings 里残留堆积
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (k in saved) settings[k] = saved[k];
    }
  } catch (_) { /* 数据损坏则退回默认值 */ }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}

// 各主题下 --bg-scrim 的基准 alpha（可见度 = 0 时的值）
const SCRIM_BASE = {
  light: { top: 0.78, bottom: 0.86, rgbTop: "247,241,228", rgbBottom: "247,241,228" },
  dark:  { top: 0.80, bottom: 0.88, rgbTop: "24,17,11",    rgbBottom: "20,14,9"    },
};

// 背景可见度：值越大遮罩越淡、背景越清晰。
// k = 1 - v*0.85 → v=50 时亮色 top ≈ 0.78*0.575 ≈ 0.45（即「中等提升」）
function applyBgVisibility(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  const isDark = document.body.classList.contains("dark-mode");
  const base = isDark ? SCRIM_BASE.dark : SCRIM_BASE.light;
  const k = 1 - v * 0.85;
  const aTop = +(base.top * k).toFixed(3);
  const aBot = +(base.bottom * k).toFixed(3);
  // 写到 body 内联样式：body::after 的变量解析自 body，
  // 必须落在 body 上才能压过 body.dark-mode 里的 --bg-scrim 定义
  document.body.style.setProperty(
    "--bg-scrim",
    "linear-gradient(rgba(" + base.rgbTop + "," + aTop + "), rgba(" + base.rgbBottom + "," + aBot + "))"
  );
}

// 把 settings 映射到 body class / CSS 变量
function applySettings() {
  const b = document.body;
  // 透明类开关（默认全关）：ON = 对应元素透出背景
  b.classList.toggle("no-bg",     settings.bgSolid);            // 见 CSS body.no-bg
  b.classList.toggle("opaque-ui", !settings.uiTransparent);
  b.classList.toggle("search-transparent", settings.searchTransparent);
  b.classList.toggle("card-transparent",   settings.cardTransparent);
  b.classList.toggle("preview-transparent", settings.previewTransparent);
  // 去边框去线条
  b.classList.toggle("no-border", settings.noBorder);
  // 风格类开关
  b.classList.toggle("flat-ui",   !settings.md3Style);
  b.classList.toggle("compact-mode", settings.compactMode);
  b.classList.toggle("force-reduce-motion", settings.reduceMotion);
  // 悬停放大卡牌：卡牌库网格里 hover 时把整张卡放大（见 CSS body.card-hover-zoom）
  b.classList.toggle("card-hover-zoom", settings.cardHoverZoom);
  // 关闭「水晶颜色」时，所有法力水晶统一回退到基准蓝色（见 CSS .crystal-mono）
  b.classList.toggle("crystal-mono", !settings.crystalColor);
  // 异画卡图：开启时按需拉索引（异步，不阻塞首屏）
  if (settings.signatureArt) loadSignatureIndex();
  applyBgVisibility(settings.bgVisibility);
  saveSettings();
}

// ============================================================
// 日夜模式
// ============================================================
const themeToggle = document.getElementById("themeToggle");

function applyTheme(isDark) {
  if (isDark) {
    document.body.classList.add("dark-mode");
    themeToggle.innerHTML = ICON_SUN;
    themeToggle.title = "切换到白天模式";
  } else {
    document.body.classList.remove("dark-mode");
    themeToggle.innerHTML = ICON_MOON;
    themeToggle.title = "切换到夜晚模式";
  }
  // 主题变化 → 遮罩基准色也变了，按当前可见度重算
  applyBgVisibility(settings.bgVisibility);
}

const savedTheme = localStorage.getItem("hstool-theme");
applyTheme(savedTheme ? savedTheme === "dark" : true); // 默认暗色（TopHSDeck 风格），可在右上角切换

themeToggle.addEventListener("click", () => {
  const isDark = !document.body.classList.contains("dark-mode");
  applyTheme(isDark);
  localStorage.setItem("hstool-theme", isDark ? "dark" : "light");
});

// ============================================================
// 设置面板
// ============================================================
const settingsModal = document.getElementById("settingsModal");
const settingsToggle = document.getElementById("settingsToggle");
const settingsClose = document.getElementById("settingsClose");
const bgVisibilityInput = document.getElementById("bgVisibility");
const bgVisibilityValue = document.getElementById("bgVisibilityValue");
const bgVisRow = document.getElementById("bgVisRow");

// ============================================================
// 弹窗打开时锁定背景滚动
// ------------------------------------------------------------
// 任何弹窗（设置 / 卡牌详情 / 英雄选择）打开期间，滚轮与触摸都不应再
// 滚动背后的页面；关闭后恢复。
// 用计数器兼容「弹窗叠弹窗」的层级场景：只有全部关闭才解锁。
// body 加 overflow:hidden 会让滚动条消失、页面左右抖动，
// 故同时补偿 padding-right（宽度 = 原滚动条宽度）。
// ============================================================
let scrollLockCount = 0;
function lockBodyScroll() {
  scrollLockCount++;
  if (scrollLockCount > 1) return;          // 已有弹窗在锁，只计数
  const sbw = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.overflow = "hidden";
  if (sbw > 0) document.body.style.paddingRight = sbw + "px";
  document.body.classList.add("scroll-locked");
}
function unlockBodyScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount > 0) return;          // 还有上层弹窗，保持锁定
  document.body.style.overflow = "";
  document.body.style.paddingRight = "";
  document.body.classList.remove("scroll-locked");
}

function openSettings() {
  syncSettingsUI();
  settingsModal.classList.add("show");
  lockBodyScroll();
  moveSettingsIndicator();          // 打开后校准分页指示条位置
}
function closeSettings() {
  settingsModal.classList.remove("show");
  unlockBodyScroll();
}

// ============================================================
// 设置面板分页（MD3 主标签）
// ============================================================
const settingsTabButtons = document.querySelectorAll(".settings-tab");
const settingsTabIndicator = document.getElementById("settingsTabIndicator");

// 指示条定位：用 offsetLeft / offsetWidth（布局值）而不是 getBoundingClientRect。
// 弹窗内容有 scale(0.96→1) 的开合动画，rect 会被缩放值污染，量出来是偏小的。
function moveSettingsIndicator() {
  const active = document.querySelector(".settings-tab.active");
  if (!active || !settingsTabIndicator) return;
  const inset = 14;                 // 左右各内缩一点，与导航栏指示条观感一致
  settingsTabIndicator.style.left = (active.offsetLeft + inset) + "px";
  settingsTabIndicator.style.width = Math.max(0, active.offsetWidth - inset * 2) + "px";
}

function switchSettingsTab(name) {
  if (!name) return;
  settingsTabButtons.forEach(btn => {
    const on = btn.dataset.stab === name;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".settings-pane").forEach(p => {
    p.classList.toggle("hidden", p.id !== "stab-" + name);
  });
  moveSettingsIndicator();
}

settingsTabButtons.forEach(btn => {
  btn.addEventListener("click", () => switchSettingsTab(btn.dataset.stab));
});
window.addEventListener("resize", moveSettingsIndicator);

// 把当前 settings 回填到控件
function syncSettingsUI() {
  document.querySelectorAll('input[data-setting][type="checkbox"]').forEach(inp => {
    inp.checked = !!settings[inp.dataset.setting];
  });
  bgVisibilityInput.value = settings.bgVisibility;
  bgVisibilityValue.textContent = settings.bgVisibility;
  updateBgVisDisabled();
}

// 「背景纯色」开启时背景图不显示，可见度无意义 → 禁用并置灰
function updateBgVisDisabled() {
  const disabled = settings.bgSolid;
  bgVisibilityInput.disabled = disabled;
  bgVisRow.style.opacity = disabled ? "0.5" : "1";
}

settingsToggle.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);

// 点击遮罩关闭（点内容区不关）
settingsModal.addEventListener("click", (e) => {
  if (e.target.id === "settingsModal") closeSettings();
});

// 所有开关：统一绑定
document.querySelectorAll('input[data-setting][type="checkbox"]').forEach(inp => {
  inp.addEventListener("change", () => {
    settings[inp.dataset.setting] = inp.checked;
    applySettings();
    updateBgVisDisabled();
    // 关掉「悬停预览」时，若预览正显示着，立刻收起，不用等鼠标移走
    if (!settings.hoverPreview) hideCardHoverPreview();
    // 「异画卡图」：换图源后要重画一次，已渲染的 <img> 不会自己换
    if (inp.dataset.setting === "signatureArt") {
      if (settings.signatureArt) loadSignatureIndex().then(rerenderCardArt);
      else rerenderCardArt();
    }
  });
});

// 滑块：input 实时预览，change 落库
bgVisibilityInput.addEventListener("input", () => {
  settings.bgVisibility = parseInt(bgVisibilityInput.value, 10) || 0;
  bgVisibilityValue.textContent = settings.bgVisibility;
  applyBgVisibility(settings.bgVisibility);
});
bgVisibilityInput.addEventListener("change", saveSettings);

loadSettings();
applySettings();
syncSettingsUI();

// ============================================================
// 导航 Tab 切换
// ============================================================
const navTabs = document.getElementById("navTabs");
const tabIndicator = document.getElementById("tabIndicator");
const tabButtons = document.querySelectorAll(".nav-tab");

function moveIndicatorTo(btn) {
  const containerRect = navTabs.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  const left = btnRect.left - containerRect.left + 12;
  const width = btnRect.width - 24;
  tabIndicator.style.left = left + "px";
  tabIndicator.style.width = width + "px";
}

function initIndicator() {
  const active = document.querySelector(".nav-tab.active");
  if (active) {
    tabIndicator.style.transition = "none";
    moveIndicatorTo(active);
    requestAnimationFrame(() => {
      tabIndicator.style.transition =
        "left 0.35s cubic-bezier(0.4, 0.0, 0.2, 1), width 0.35s cubic-bezier(0.4, 0.0, 0.2, 1)";
    });
  }
}

function switchTab(tabName) {
  tabButtons.forEach(b => {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });
  const active = document.querySelector('.nav-tab[data-tab="' + tabName + '"]');
  if (active) moveIndicatorTo(active);

  document.getElementById("tab-preview").classList.toggle("hidden", tabName !== "preview");
  document.getElementById("tab-encode").classList.toggle("hidden", tabName !== "encode");
  document.getElementById("tab-decode").classList.toggle("hidden", tabName !== "decode");
  document.getElementById("tab-finder").classList.toggle("hidden", tabName !== "finder");

  if (tabName === "finder") {
    initFinder();
  }

  if (tabName === "preview") {
    if (!previewInitialized) {
      initPreview();
    }
    renderDeckHeroCard();
  }
  hideCardHoverPreview();
}

tabButtons.forEach(btn => {
  if (!btn.dataset.tab) return;
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

window.addEventListener("resize", () => {
  const active = document.querySelector(".nav-tab.active");
  if (active) moveIndicatorTo(active);
});

document.querySelectorAll('input[name="format"]').forEach(inp => {
  inp.addEventListener("change", () => {
    document.querySelectorAll(".radio").forEach(r => r.classList.remove("checked"));
    inp.closest(".radio").classList.add("checked");
  });
});

// ============================================================
// 加载卡牌数据 + 主动初始化（纯前端：直接读同目录 JSON）
// ============================================================
function loadSets() {
  // 纯前端版：系列分组随 cards-meta.json 一起加载，已在 DB.sets 里
  setGroupsCache = DB.sets || [];
  if (openDimKey === "set") {
    const dim = getFilterDims().find(d => d.key === "set");
    const menu = document.querySelector('.filter-dd-menu[data-dim="set"]');
    if (dim && menu) buildDimMenu(dim, menu);
  }
}

(async function initStatus() {
  const subEl = document.getElementById("loadingSub");
  const dot = document.getElementById("statusDot");
  const txt = document.getElementById("statusText");
  const t0 = Date.now();
  const MIN_SHOW = 400;

  const timer = setInterval(() => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    if (sec < 2) {
      subEl.textContent = "正在加载卡牌数据…";
    } else if (sec < 8) {
      subEl.textContent = "正在载入卡牌数据库，请稍候…";
    } else {
      subEl.textContent = "已等待 " + sec + " 秒，数据较大，请耐心等待…";
    }
  }, 400);

  try {
    await loadCardDatabase();
  } catch (e) {
    clearInterval(timer);
    subEl.textContent = "卡牌数据加载失败：" + (e.message || e) +
      "（请确认 data/hearthstone_cards_zhCN.json 与 data/cards-meta.json 存在且可访问）";
    subEl.style.color = "#ef4444";
    dot.className = "status-dot err";
    txt.textContent = "加载失败";
    return;
  }

  clearInterval(timer);
  dot.className = "status-dot ok";
  txt.textContent = DB.cards.length + " 张";

  const elapsed = Date.now() - t0;
  if (elapsed < MIN_SHOW) {
    await new Promise(res => setTimeout(res, MIN_SHOW - elapsed));
  }
  hideLoadingOverlay();

  initIndicator();
  loadSets();

  const activeTab = document.querySelector(".nav-tab.active");
  if (activeTab && activeTab.dataset.tab === "preview" && !previewInitialized) {
    initPreview();
  }
  renderDeckHeroCard();
})();

// ============================================================
// 解码页
// ============================================================
const decodeInput = document.getElementById("decodeInput");
const decodeOutput = document.getElementById("decodeOutput");

document.getElementById("btnDecode").addEventListener("click", async () => {
  const content = decodeInput.value.trim();
  if (!content) return toast("请先粘贴内容");
  try {
    const r = await api("/api/decode", { content });
    setOutput(decodeOutput, r.text);
  } catch (e) { toast("解码失败：" + friendlyError(e)); }
});

document.getElementById("btnDecodeClear").addEventListener("click", () => {
  decodeInput.value = "";
  setOutput(decodeOutput, "");
});

document.getElementById("btnDecodeCopy").addEventListener("click", () => {
  const t = decodeOutput.textContent.trim();
  if (t && !decodeOutput.classList.contains("empty")) copyText(t);
});

document.getElementById("btnDecodeExample").addEventListener("click", () => {
  decodeInput.value =
`### 由HsTool生成
# 职业：牧师
# 模式：狂野模式
#
# 2x (1) 异教水晶工匠
# 2x (1) 心灵咒术师
# 2x (1) 欢快的同伴
# 2x (1) 真言术：盾
# 2x (1) 神圣惩击
# 2x (2) 受伤的托维尔人
# 2x (2) 暗影升腾者
# 1x (2) 疯狂的炼金师
# 2x (3) 神圣新星
# 1x (4) 暗言术：毁
# 2x (4) 虚空碎片
# 2x (5) 安瑟祭司
# 1x (6) 佳莉娅·米奈希尔
# 2x (6) 光沐元素
# 2x (6) 通窍
# 1x (7) 娜塔莉·塞林
# 2x (9) 黑曜石雕像
# 
AAEBAZ/HAgTwnwTxnwSdoASo3wcNhJ8EhZ8Evp8EntQEmKQF9OsFguwFjeYG0q8H068HjvEHlPEHuPYHAAA=
# 
# 想要使用这副套牌，请先复制到剪贴板，然后在游戏中点击"新套牌"进行粘贴。`;
});

document.getElementById("btnDecodeToEncode").addEventListener("click", async () => {
  const content = decodeInput.value.trim();
  if (!content) return toast("请先粘贴内容");
  try {
    const r = await api("/api/decode", { content });
    document.getElementById("heroInput").value = r.heroes_lines;
    document.getElementById("cardsInput").value = r.cards_lines;
    const val = String(r.format || 1);
    document.querySelectorAll('input[name="format"]').forEach(inp => {
      inp.checked = (inp.value === val);
      inp.closest(".radio").classList.toggle("checked", inp.checked);
    });
    switchTab("encode");
    toast("已转到编码页");
  } catch (e) { toast("失败：" + friendlyError(e)); }
});

document.getElementById("btnDecodeToPreview").addEventListener("click", async () => {
  const outputText = decodeOutput.textContent.trim();
  if (!outputText || decodeOutput.classList.contains("empty")) {
    return toast("请先解码，输出内容为空");
  }
  try {
    const parsed = parseDecodeOutput(outputText);
    if (!parsed.cards_lines) {
      return toast("输出内容里没有卡牌");
    }
    await importToDeckBuilder(parsed.heroes_lines, parsed.cards_lines, parsed.format,
                              parsed.sideboard_pairs);
    switchTab("preview");
    toast("已导入到组卡器");
  } catch (e) { toast("导入失败：" + friendlyError(e)); }
});

function parseDecodeOutput(text) {
  const lines = text.split("\n");
  let heroes_lines = "";
  let cards_lines_arr = [];
  let sideboard_pairs = [];
  let format = 1;

  for (const line of lines) {
    // 乐队行：※ 名称(DBF xxx) 〔归属：名称(DBF yyy)〕
    const sbMatch = line.match(/^\s*※\s*(.+?)\s*〔归属：(.+?)〕\s*$/);
    if (sbMatch) {
      const cDbf = extractDbfId(sbMatch[1]);
      const oDbf = extractDbfId(sbMatch[2]);
      if (cDbf && oDbf) sideboard_pairs.push([cDbf, oDbf]);
      continue;
    }
    const heroMatch = line.match(/^英雄\s*[:：]\s*(.+)/);
    if (heroMatch && heroMatch[1].trim() && heroMatch[1].trim() !== "（无）") {
      heroes_lines = heroMatch[1].trim();
      continue;
    }
    const fmtMatch = line.match(/^模式\s*[:：]\s*(狂野|标准)/);
    if (fmtMatch) {
      format = fmtMatch[1] === "狂野" ? 1 : 2;
      continue;
    }
    const cardMatch = line.match(/^\s*[·•]\s*(.+?)\s*[×x*]\s*(\d+)\s*$/);
    if (cardMatch) {
      cards_lines_arr.push(cardMatch[1].trim() + " × " + cardMatch[2]);
    }
  }

  return {
    heroes_lines,
    cards_lines: cards_lines_arr.join("\n"),
    sideboard_pairs,
    format,
  };
}

// ============================================================
// 编码页
// ============================================================
const heroInput = document.getElementById("heroInput");
const cardsInput = document.getElementById("cardsInput");
const encodeOutput = document.getElementById("encodeOutput");

function getFormat() {
  const checked = document.querySelector('input[name="format"]:checked');
  return parseInt(checked.value);
}

document.getElementById("btnEncode").addEventListener("click", async () => {
  try {
    const r = await api("/api/encode", {
      heroes: heroInput.value,
      cards: cardsInput.value,
      format: getFormat(),
    });
    setOutput(encodeOutput, r.text);
  } catch (e) { toast("失败：" + friendlyError(e)); }
});

document.getElementById("btnExport").addEventListener("click", async () => {
  try {
    const r = await api("/api/export", {
      heroes: heroInput.value,
      cards: cardsInput.value,
      format: getFormat(),
    });
    setOutput(encodeOutput, r.text);
    copyText(r.text);
  } catch (e) { toast("失败：" + friendlyError(e)); }
});

document.getElementById("btnEncodeClear").addEventListener("click", () => {
  heroInput.value = "";
  cardsInput.value = "";
  setOutput(encodeOutput, "");
});

document.getElementById("btnEncodeCopy").addEventListener("click", () => {
  const t = encodeOutput.textContent.trim();
  if (t && !encodeOutput.classList.contains("empty")) copyText(t);
});

document.getElementById("btnEncodeExample").addEventListener("click", async () => {
  // 和解码页「填入示例」同一套牌：直接解码内置示例代码，
  // 用后端返回的 heroes_lines/cards_lines 回填（带 DBF ID，格式与解码输出完全一致）
  const exampleCode =
"AAEBAZ/HAgTwnwTxnwSdoASo3wcNhJ8EhZ8Evp8EntQEmKQF9OsFguwFjeYG0q8H068HjvEHlPEHuPYHAAA=";
  try {
    const r = await api("/api/decode", { content: exampleCode });
    heroInput.value = r.heroes_lines;
    cardsInput.value = r.cards_lines;
    const val = String(r.format || 1);
    document.querySelectorAll('input[name="format"]').forEach(inp => {
      inp.checked = (inp.value === val);
      inp.closest(".radio").classList.toggle("checked", inp.checked);
    });
    toast("已填入示例（与解码页同一套牌）");
  } catch (e) {
    toast("示例加载失败：" + e.message);
  }
});

document.getElementById("btnEncodeToPreview").addEventListener("click", async () => {
  const outputText = encodeOutput.textContent.trim();
  if (!outputText || encodeOutput.classList.contains("empty")) {
    return toast("请先生成代码或导出格式，输出内容为空");
  }
  try {
    const r = await api("/api/decode", { content: outputText });
    await importToDeckBuilder(r.heroes_lines, r.cards_lines, r.format);
    switchTab("preview");
    toast("已导入到组卡器");
  } catch (e) {
    toast("导入失败：" + friendlyError(e));
  }
});

// ============================================================
// 从后端获取卡牌详情
// ============================================================
async function fetchCardInfo(dbfId) {
  if (cardCache.has(dbfId)) return cardCache.get(dbfId);
  try {
    const c = await api("/api/cards/detail", { dbfId });
    cardCache.set(c.dbfId, c);
    return c;
  } catch (e) {
    return null;
  }
}

// ============================================================
// 导入到组卡器
// ============================================================
async function importToDeckBuilder(heroesText, cardsText, format, sideboardPairs) {
  deckState.cards.clear();
  deckState.bands.clear();
  deckState.bandTarget = null;
  // 一并清空旧英雄：否则导入无英雄行（或英雄解析失败）的卡组时会沿用上一个英雄，
  // 导致侧边栏立绘/职业与导出文本的「# 职业：」行都显示错误。
  deckState.hero = null;
  const heroInputEl = document.getElementById("deckHeroInput");
  if (heroInputEl) heroInputEl.value = "";

  let newHero = null;

  if (heroesText) {
    const lines = heroesText.split("\n").map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      const dbfId = extractDbfId(line);
      if (!dbfId) continue;

      const foundHero = HERO_LIST.find(h => h.dbfId === dbfId);
      if (foundHero) {
        newHero = foundHero;
        break;
      }

      const cached = cardCache.get(dbfId);
      if (cached) {
        newHero = {
          dbfId: dbfId,
          cardId: cached.id,
          name: cached.name,
          cardClass: cached.cardClass,
        };
        break;
      }

      const c = await fetchCardInfo(dbfId);
      if (c) {
        newHero = {
          dbfId: dbfId,
          cardId: c.id,
          name: c.name,
          cardClass: c.cardClass,
        };
        break;
      }
    }
  }

  if (newHero) {
    deckState.hero = newHero;
    document.getElementById("deckHeroInput").value =
      newHero.name + " (DBF " + newHero.dbfId + ")";
  }

  if (format) {
    deckState.format = parseInt(format);
    document.getElementById("deckFormatSelect").value = String(deckState.format);
  hsSyncDeckFormat();   // 自绘下拉跟着回填（原生 select 已隐藏）
  }

  if (cardsText) {
    const lines = cardsText.split("\n").map(s => s.trim()).filter(Boolean);
    const tasks = [];

    for (const line of lines) {
      // 与后端 CARD_LINE_PATTERN 对齐：支持 x2 / × 2 / * 2 / 空格 2（空格+数字分支不能少，
      // 否则「寒冰箭 2」会被整行当作卡名 → 取不到 DBF ID → 静默丢卡）
      const m = line.match(/^(.+?)(?:\s*[x×*]\s*(\d+)|\s+(\d{1,2}))?$/);
      if (!m) continue;
      let cardName = m[1].trim();
      let count = m[2] ? parseInt(m[2]) : (m[3] ? parseInt(m[3]) : 1);

      const dbfId = extractDbfId(cardName);
      if (dbfId) {
        tasks.push(
          fetchCardInfo(dbfId).then(card => ({ card, count }))
        );
      }
    }

    const results = await Promise.all(tasks);
    for (const { card, count } of results) {
      if (card) {
        const maxCount = maxCopiesOf(card);
        const prev = deckState.cards.get(card.dbfId);
        // 同一张卡出现多行时累加数量，而不是直接覆盖
        const total = (prev ? prev.count : 0) + count;
        deckState.cards.set(card.dbfId, {
          card,
          count: Math.min(total, maxCount)
        });
      }
    }
  }

  // 导入乐队（sideboard）：归属卡必须在卡组中，否则跳过；
  // deckstring 里每个复制是一对，先聚合成数量再去重（旧版乐队每卡只存 1 张）
  if (Array.isArray(sideboardPairs)) {
    const bandCounts = new Map();
    for (const pair of sideboardPairs) {
      const cardDbf = Array.isArray(pair) ? pair[0] : 0;
      const ownerDbf = Array.isArray(pair) ? pair[1] : 0;
      if (!cardDbf || !ownerDbf) continue;
      if (!deckState.cards.has(ownerDbf)) continue;
      const key = ownerDbf + ":" + cardDbf;
      bandCounts.set(key, (bandCounts.get(key) || 0) + 1);
    }
    for (const [key] of bandCounts) {
      const ownerDbf = parseInt(key.split(":")[0], 10);
      const cardDbf = parseInt(key.split(":")[1], 10);
      let info = cardCache.get(cardDbf);
      if (!info) info = await fetchCardInfo(cardDbf);
      if (!info) continue;
      if (!canBeBandCard(info).ok) continue;  // 非法乐队卡跳过
      // 归属卡自身的准入门槛（如「血色战队」只要 2 费随从、「私藏野兽」只要野兽）
      if (!checkBandOwnerAccept(info, ownerDbf).ok) continue;
      // 奇利亚斯导入配额：2 功能 + 1 外观，超出跳过
      if (isZilliaxOwner(ownerDbf)) {
        if (!canBeZilliaxModule(info)) continue;
        const kind = zilliaxModuleKind(info);
        const curBand = deckState.bands.get(ownerDbf);
        let funcCount = 0, cosCount = 0;
        if (curBand) curBand.forEach(bc => {
          if (zilliaxModuleKind(bc) === "functional") funcCount++;
          else cosCount++;
        });
        if (kind === "functional" && funcCount >= ZILLIAX_MAX_MODULE) continue;
        if (kind === "cosmetic" && cosCount >= ZILLIAX_MAX_COSMETIC) continue;
      }
      // 份数上限跨「主卡组 + 所有乐队」合并：占满名额则跳过（与 UI 侧规则一致，
      // 传说 1 张、其余 2 张）。放在创建 band map 之前，避免被跳过时留下空 Map。
      if (countCardCopies(cardDbf) >= maxCopiesOf(info)) continue;
      if (!deckState.bands.has(ownerDbf)) deckState.bands.set(ownerDbf, new Map());
      // 上限截断：超过该归属卡的乐队上限则跳过（如碧阿崔克丝上限为 1）
      if (deckState.bands.get(ownerDbf).size >= getBandMaxSize(ownerDbf)) continue;
      deckState.bands.get(ownerDbf).set(cardDbf, info);  // 旧版结构：直接存卡对象
    }
  }

  // 导入后校验总张数上限
  const deckLimit = getDeckLimit();
  const deckTotal = getDeckTotalForLimit();
  if (deckTotal > deckLimit) {
    toast("导入的卡组为 " + deckTotal + " 张，超过当前上限（" + deckLimit + " 张）");
  }

  updateDeckBadge();
  refreshAllCardBadges();
  renderDeckCards();
  renderDeckHeroCard();
}

function extractDbfId(text) {
  const m = text.match(/DBF\s*[:#]?\s*(\d+)/i);
  if (m) return parseInt(m[1]);
  if (/^\d+$/.test(text.trim())) return parseInt(text.trim());
  return null;
}

// ============================================================
// 组卡器页
// ============================================================
let previewInitialized = false;
let searchTimer = null;
let bandModeSavedQuery = null;  // 奇利亚斯定制模式下暂存的搜索框内容

const PAGE_SIZE = 200;
const searchState = {
  query: "",
  filters: {},
  page: 1,
  total: 0,
  totalPages: 0,
  requestId: 0,
  sort: "default",
};

function initPreview() {
  if (previewInitialized) return;
  previewInitialized = true;

  document.getElementById("cardSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doCardSearch(1), 300);
  });

  initFilterTags();
  buildSortDropdown();
  initDeckDropZone();
  bindDeckHoverPreview();
  bindGridHoverZoom();
  hsBuildDeckFormatDropdown();

  doCardSearch(1);
}

// 卡组列表作为拖放目标：卡牌从预览页拖入即添加（乐队/定制模式下自动进乐队）
function initDeckDropZone() {
  const list = document.getElementById("deckCardsList");
  if (!list || list.dataset.dropInit) return;
  list.dataset.dropInit = "1";

  list.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer.types || [])].includes("application/x-hstool-card")) return;
    e.preventDefault();                 // 必须阻止默认才能触发 drop
    e.dataTransfer.dropEffect = "copy";
    list.classList.add("drag-over");
  });
  list.addEventListener("dragleave", (e) => {
    if (e.target === list) list.classList.remove("drag-over");
  });
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    list.classList.remove("drag-over");
    const dbfId = parseInt(e.dataTransfer.getData("application/x-hstool-card")
                        || e.dataTransfer.getData("text/plain"));
    if (!dbfId) return;
    const card = cardCache.get(dbfId);
    if (!card) return;
    addCardToDeck(card);   // 乐队/定制模式下自动分流到 addCardToBand
  });
}

// ============================================================
// 筛选标签引擎
// ------------------------------------------------------------
// 每个筛选维度只能取一个值（与后端 filters 的语义一致），
// 因此同维度再次选择会「替换」旧标签，而不是叠加。
// ============================================================
// 筛选引擎（每个维度一个下拉框，支持同维度多选取值）
// 数据结构：activeFilters = Map<dimKey, Map<value, {dimKey, value, label}>>
// 交互：点某维度的下拉框 → 面板里多选 → 每个已选值生成一枚标签；
//       再点已选项 = 取消；菜单底部有「清除该项」；全局有「清除全部」。
// ============================================================
const activeFilters = new Map();   // dimKey -> Map<value, {dimKey, value, label}>
let openDimKey = null;             // 当前展开的下拉维度（同一时刻只开一个）
let setGroupsCache = [];           // /api/sets 返回的分组，供系列菜单用

// 各筛选维度的定义（顺序即下拉框顺序）
function getFilterDims() {
  return [
    {
      key: "cardClass", label: "职业",
      options: CLASS_LIST.map(([v, l]) => [v, l]),
    },
    {
      key: "type", label: "类型",
      options: [
        ["MINION", "随从"], ["SPELL", "法术"], ["WEAPON", "武器"],
        ["HERO", "英雄"], ["HERO_POWER", "英雄技能"], ["LOCATION", "地标"],
        ["ENCHANTMENT", "附魔"], ["GAME_MODE_BUTTON", "按钮"],
        ["MOVE_MINION_HOVER_TARGET", "拖动"],
        ["BATTLEGROUND_SPELL", "战棋法术"], ["BATTLEGROUND_TRINKET", "饰品"],
        ["BATTLEGROUND_QUEST_REWARD", "战棋任务奖励"],
        ["BATTLEGROUND_HERO_BUDDY", "战棋伙伴"], ["BATTLEGROUND_ANOMALY", "战棋畸变"],
      ],
    },
    {
      key: "rarity", label: "稀有度",
      options: [
        ["FREE", "免费"], ["COMMON", "普通"], ["RARE", "稀有"],
        ["EPIC", "史诗"], ["LEGENDARY", "传说"],
      ],
    },
    {
      key: "race", label: "随从种族",
      // 只列标准随从种族（数据源里 ORC/TROLL 等是战棋英雄标记，不属于随从种族）
      options: [
        ["ALL", "全部种族"], ["BEAST", "野兽"], ["UNDEAD", "亡灵"],
        ["ELEMENTAL", "元素"], ["MECHANICAL", "机械"], ["DRAGON", "龙"],
        ["DEMON", "恶魔"], ["PIRATE", "海盗"], ["MURLOC", "鱼人"],
        ["DRAENEI", "德莱尼"], ["NAGA", "纳迦"], ["TOTEM", "图腾"],
        ["QUILBOAR", "野猪人"],
      ],
    },
    {
      key: "spellSchool", label: "法术派系",
      options: [
        ["SHADOW", "暗影"], ["NATURE", "自然"], ["HOLY", "神圣"],
        ["FIRE", "火焰"], ["ARCANE", "奥术"], ["FROST", "冰霜"],
        ["FEL", "邪能"],
      ],
    },
    {
      key: "set", label: "系列",
      // 系列数量多，按 /api/sets 的分组展示
      groups: () => setGroupsCache,
    },
    {
      key: "cost", label: "费用",
      options: [
        ...[...Array(10).keys()].map(i => [String(i), i + " 费"]),
        ["10plus", "10+ 费"],
      ],
    },
    {
      key: "collectible", label: "收藏状态",
      options: [
        ["yes", "可收藏"],
        ["no", "不可收藏"],
      ],
    },
  ];
}

// 取某维度的标签文案
function filterLabelOf(dimKey, value) {
  const dim = getFilterDims().find(d => d.key === dimKey);
  if (!dim) return value;
  if (dim.groups) {
    for (const g of dim.groups()) {
      const hit = (g.items || []).find(([v]) => v === value);
      if (hit) return hit[1];
    }
    return value;
  }
  const hit = (dim.options || []).find(([v]) => v === value);
  return hit ? hit[1] : value;
}

// 该维度已选的取值集合
function getDimSelection(dimKey) {
  let m = activeFilters.get(dimKey);
  if (!m) { m = new Map(); activeFilters.set(dimKey, m); }
  return m;
}

// 是否还有任何筛选
function hasAnyFilter() {
  for (const m of activeFilters.values()) if (m.size) return true;
  return false;
}

// ============ 标签渲染 ============
function renderFilterTags() {
  const list = document.getElementById("filterTagsList");
  const clearBtn = document.getElementById("filterClearBtn");
  if (!list) return;
  list.innerHTML = "";

  getFilterDims().forEach(dim => {
    const sel = activeFilters.get(dim.key);
    if (!sel || !sel.size) return;
    sel.forEach((f, value) => {
      const tag = document.createElement("span");
      tag.className = "filter-tag";
      tag.dataset.dim = dim.key;
      tag.dataset.value = value;

      const label = document.createElement("span");
      label.className = "tag-label";
      label.textContent = f.label;
      tag.appendChild(label);

      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "tag-remove";
      rm.textContent = "×";
      rm.title = "移除该筛选";
      rm.setAttribute("aria-label", "移除筛选：" + f.label);
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFilter(dim.key, value);
      });
      tag.appendChild(rm);

      list.appendChild(tag);
    });
  });

  // 同步每个下拉框按钮上的数量徽标
  getFilterDims().forEach(dim => {
    const btn = document.querySelector('.filter-dd-btn[data-dim="' + dim.key + '"]');
    if (!btn) return;
    const sel = activeFilters.get(dim.key);
    const n = sel ? sel.size : 0;
    let badge = btn.querySelector(".dd-count");
    if (n > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "dd-count";
        btn.insertBefore(badge, btn.querySelector(".dd-caret"));
      }
      badge.textContent = String(n);
    } else if (badge) {
      badge.remove();
    }
  });

  // 有标签时才显示「清除全部」
  if (clearBtn) clearBtn.style.display = hasAnyFilter() ? "" : "none";
}

// ============ 增 / 删 / 清空 ============
function addFilter(dimKey, value) {
  if (value === "" || value == null) return;
  const sel = getDimSelection(dimKey);
  sel.set(value, { dimKey, value, label: filterLabelOf(dimKey, value) });
  renderFilterTags();
  doCardSearch(1);
}

function removeFilter(dimKey, value) {
  const sel = activeFilters.get(dimKey);
  if (!sel || !sel.has(value)) return;
  sel.delete(value);
  if (!sel.size) activeFilters.delete(dimKey);
  renderFilterTags();
  doCardSearch(1);
}

// 切换某个取值（已选则取消，未选则选中）
function toggleFilter(dimKey, value) {
  const sel = activeFilters.get(dimKey);
  if (sel && sel.has(value)) removeFilter(dimKey, value);
  else addFilter(dimKey, value);
}

// 清除单个维度的全部取值
function clearDimFilters(dimKey) {
  const sel = activeFilters.get(dimKey);
  if (!sel || !sel.size) return;
  activeFilters.delete(dimKey);
  renderFilterTags();
  doCardSearch(1);
}

function clearAllFilters() {
  if (!hasAnyFilter()) return;
  activeFilters.clear();
  renderFilterTags();
  closeFilterMenu();
  doCardSearch(1);
}

// 供外部（如切换乐队模式）读取/重置
function getFilterValue(dimKey) {
  const sel = activeFilters.get(dimKey);
  if (!sel || !sel.size) return "";
  return sel.keys().next().value;
}

// ============ 下拉面板 ============
// 构建某个维度的面板内容
function buildDimMenu(dim, menu) {
  // 重建前记住滚动位置，避免连续多选时（尤其系列 58 项）列表跳回顶部
  const keepScroll = menu.scrollTop;
  menu.innerHTML = "";

  // 系列：已有分组小节标题，不再额外输出维度名（避免「系列」重复出现）
  const cur = activeFilters.get(dim.key);
  const emit = (val, text, nested) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item" + (nested ? " menu-item-nested" : "");
    btn.setAttribute("role", "menuitemcheckbox");
    const isCur = !!(cur && cur.has(val));
    btn.innerHTML = '<span>' + escapeHtml(text) + '</span>'
                  + (isCur ? '<span class="menu-item-check">✓</span>' : '');
    btn.setAttribute("aria-checked", isCur ? "true" : "false");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFilter(dim.key, val);
      // 面板保持打开方便连续多选：整块重建，勾选态与「清除该项」显隐一并刷新
      buildDimMenu(dim, menu);
    });
    menu.appendChild(btn);
  };

  if (dim.groups) {
    dim.groups().forEach(g => {
      const sub = document.createElement("div");
      sub.className = "menu-subgroup-title";
      sub.textContent = g.group;
      menu.appendChild(sub);
      (g.items || []).forEach(([v, l]) => emit(v, l, true));
    });
  } else {
    (dim.options || []).forEach(([v, l]) => emit(v, l));
  }

  const clearOne = document.createElement("button");
  clearOne.type = "button";
  clearOne.className = "menu-clear";
  clearOne.textContent = "清除该项";
  clearOne.hidden = !(cur && cur.size);
  clearOne.addEventListener("click", (e) => {
    e.stopPropagation();
    clearDimFilters(dim.key);
    buildDimMenu(dim, menu);           // 重建以刷新「清除该项」的显隐
  });
  menu.appendChild(clearOne);

  menu.scrollTop = keepScroll;         // 还原滚动位置
}

// 初始化：为每个维度生成一个下拉框按钮 + 面板
function initFilterTags() {
  const wrap = document.getElementById("filterDropdowns");
  const clearBtn = document.getElementById("filterClearBtn");
  if (!wrap || wrap.dataset.init) return;
  wrap.dataset.init = "1";
  wrap.innerHTML = "";
  // 「清除全部」按钮原本就在这个容器里，稍后统一放到所有下拉框之后

  getFilterDims().forEach(dim => {
    const dd = document.createElement("div");
    dd.className = "filter-dd";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-dd-btn";
    btn.dataset.dim = dim.key;
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = '<span class="dd-label">' + escapeHtml(dim.label) + '</span>'
                  + '<span class="dd-caret">▼</span>';

    const menu = document.createElement("div");
    menu.className = "filter-dd-menu";
    menu.setAttribute("role", "menu");
    menu.dataset.dim = dim.key;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openDimKey === dim.key) closeFilterMenu();
      else openFilterMenu(dim.key);
    });

    dd.appendChild(btn);
    dd.appendChild(menu);
    wrap.appendChild(dd);
  });

  if (clearBtn) {
    wrap.appendChild(clearBtn);       // 放到所有下拉框之后
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      clearAllFilters();
    });
  }

  // 点别处 / Esc 关闭
  document.addEventListener("click", () => { if (openDimKey) closeFilterMenu(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openDimKey) closeFilterMenu();
  });

  renderFilterTags();
}

function openFilterMenu(dimKey) {
  closeFilterMenu();
  const dim = getFilterDims().find(d => d.key === dimKey);
  if (!dim) return;
  const btn = document.querySelector('.filter-dd-btn[data-dim="' + dimKey + '"]');
  const menu = document.querySelector('.filter-dd-menu[data-dim="' + dimKey + '"]');
  if (!btn || !menu) return;
  buildDimMenu(dim, menu);
  menu.classList.add("show");
  btn.setAttribute("aria-expanded", "true");
  openDimKey = dimKey;
}

function closeFilterMenu() {
  if (!openDimKey) return;
  const btn = document.querySelector('.filter-dd-btn[data-dim="' + openDimKey + '"]');
  const menu = document.querySelector('.filter-dd-menu[data-dim="' + openDimKey + '"]');
  if (menu) menu.classList.remove("show");
  if (btn) btn.setAttribute("aria-expanded", "false");
  openDimKey = null;
}

function collectFilters() {
  const f = {};
  // 奇利亚斯定制模式：强制只搜随从（排除 TOY_330t94e 这类附魔牌）
  if (deckState.bandTarget && isZilliaxOwner(deckState.bandTarget)) {
    f.type = "MINION";
  }
  // 同维度多选 → 传数组（后端按「或」处理）；单选取值也传数组，保持格式统一
  activeFilters.forEach((sel, key) => {
    if (!sel.size) return;
    // 奇利亚斯已强制 type=MINION，跳过用户对 type 的选择，避免互相覆盖
    if (key === "type" && f.type === "MINION") return;
    f[key] = Array.from(sel.keys());
  });
  return f;
}

async function doCardSearch(page) {
  searchState.query = document.getElementById("cardSearch").value.trim();
  searchState.filters = collectFilters();
  if (page) searchState.page = page;

  const myReqId = ++searchState.requestId;
  const grid = document.getElementById("cardGrid");
  const countEl = document.getElementById("cardCount");
  const paginationEl = document.getElementById("pagination");

  grid.innerHTML = '<div class="empty-state"><span class="loading-spinner"></span>加载中…</div>';
  paginationEl.style.display = "none";
  countEl.textContent = "搜索中…";

  try {
    const offset = (searchState.page - 1) * PAGE_SIZE;
    const r = await api("/api/cards/search", {
      query: searchState.query,
      filters: searchState.filters,
      sort: searchState.sort,
      offset: offset,
      limit: PAGE_SIZE,
    });

    if (myReqId !== searchState.requestId) return;
    r.cards.forEach(c => cardCache.set(c.dbfId, c));

    searchState.total = r.total;
    searchState.totalPages = Math.ceil(r.total / PAGE_SIZE) || 1;

    if (r.total === 0) {
      grid.innerHTML = '<div class="empty-state">没有找到匹配的卡牌</div>';
      countEl.textContent = "共 0 张卡牌";
      return;
    }

    countEl.textContent = "共 " + r.total + " 张卡牌 · 第 " + searchState.page + " / " + searchState.totalPages + " 页";

    // 用上次缓存的卡片尺寸算「这批要立即加载多少张」；搜索/筛选/翻页统一走这里。
    cardImgEagerCount = computeEagerCount();
    grid.innerHTML = "";
    // 渲染前重置观察器：上一批的 img 可能还挂在 observer 上，不清理会累积。
    resetCardImgObserver();
    const fragment = document.createDocumentFragment();
    r.cards.forEach((card, idx) => fragment.appendChild(createCardElement(card, idx)));
    grid.appendChild(fragment);
    // 节点就位后记下真实尺寸，供下次渲染复用；再一次性启动 observer。
    measureCardItemSize();
    if (typeof IntersectionObserver !== "undefined") getCardImgObserver();

    renderPagination(paginationEl);
    paginationEl.style.display = "flex";
    grid.scrollTop = 0;
  } catch (e) {
    if (myReqId !== searchState.requestId) return;
    grid.innerHTML = '<div class="empty-state">搜索失败：' + escapeHtml(e.message) + '</div>';
  }
}

function renderPagination(container) {
  container.innerHTML = "";
  const total = searchState.totalPages;
  const current = searchState.page;

  function makeBtn(label, page, opts) {
    opts = opts || {};
    const btn = document.createElement("button");
    btn.innerHTML = label;
    if (opts.disabled) btn.disabled = true;
    if (opts.active) btn.classList.add("active");
    btn.addEventListener("click", () => {
      if (!opts.disabled && !opts.active) doCardSearch(page);
    });
    return btn;
  }

  container.appendChild(makeBtn("«", 1, { disabled: current === 1 }));
  container.appendChild(makeBtn("‹", current - 1, { disabled: current === 1 }));

  const pages = new Set([1, total]);
  for (let i = current - 2; i <= current + 2; i++) {
    if (i >= 1 && i <= total) pages.add(i);
  }
  const sorted = Array.from(pages).sort((a, b) => a - b);

  let last = 0;
  sorted.forEach(p => {
    if (p - last > 1) {
      const ell = document.createElement("span");
      ell.className = "ellipsis";
      ell.textContent = "…";
      container.appendChild(ell);
    }
    container.appendChild(makeBtn(String(p), p, { active: p === current }));
    last = p;
  });

  container.appendChild(makeBtn("›", current + 1, { disabled: current === total }));
  container.appendChild(makeBtn("»", total, { disabled: current === total }));

  const info = document.createElement("span");
  info.className = "page-info";
  info.textContent = current + " / " + total;
  container.appendChild(info);
}

// 每页前若干张立即加载（保证首屏无白图）。具体张数在渲染时按容器实际容量动态计算，
// 不再用固定值——否则窗口越宽/越矮，实际一屏能放的卡数差很多，固定 28 会一边浪费一边白屏。
const EAGER_IMG_COUNT = 28;  // 兜底值：拿不到容器尺寸时用这个

// ------------------------------------------------------------
// 卡图 URL 与「天然无图」的类型
// ------------------------------------------------------------
// 实测（每种类型抽样约 40 张，探测 zhCN 卡图是否 200）：
//   附魔 ENCHANTMENT              100% 无图（全库 6668 张）
//   拖动 MOVE_MINION_HOVER_TARGET 100% 无图（      4 张）
//   按钮 GAME_MODE_BUTTON          90% 无图（     10 张）
//   对照：武器 WEAPON 0% 无图，随从/法术/英雄/地标仅 12%~20% 无图（多为战棋 token）
//
// 这三类都是游戏内部对象（本身不渲染卡面），任何语言都没有图。
// 所以直接按类型判定：命中就给本地占位卡背，**不做任何网络探测**。
// （也不再需要「记住探测失败的卡」这套缓存 —— 类型是静态的，比缓存更准、更早生效。）
const IMG_HOST = "https://art.hearthstonejson.com/v1/render/latest/";
const NO_CARD_IMG = "img/nocard.png";
const NO_ART_TYPES = new Set([
  "ENCHANTMENT",                 // 附魔
  "GAME_MODE_BUTTON",            // 按钮
  "MOVE_MINION_HOVER_TARGET",    // 拖动
]);

// 该卡的类型是否属于「天然无图」的那几类。既接受卡对象，也接受卡 id。
function isNoArtType(cardOrId) {
  let t = "";
  if (cardOrId && typeof cardOrId === "object") {
    t = cardOrId.type || "";
  } else if (cardOrId != null && typeof DB !== "undefined" && DB.byId) {
    const c = DB.byId.get(String(cardOrId));
    t = (c && c.type) || "";
  }
  return NO_ART_TYPES.has(t);
}

// ------------------------------------------------------------
// 异画（签名）卡图索引
// ------------------------------------------------------------
// 数据来自 data/cards-signatures.json（构卡脚本从 hearthstone.wiki.gg 抓的
// 「Premium3」图，460 张），结构：{ cards: { 卡牌id: { dbfId, url } } }
// 图片本身走同源代理 /api/hs-signature（wiki 有防盗链，直接热链会 403）
const SIGNATURE_INDEX_URL = "data/cards-signatures.json";
let signatureIndex = null;      // Map<cardId, {dbfId,url}>
let signatureLoading = null;

function loadSignatureIndex() {
  if (signatureIndex) return Promise.resolve(signatureIndex);
  if (signatureLoading) return signatureLoading;
  signatureLoading = fetch(SIGNATURE_INDEX_URL, { cache: "force-cache" })
    .then(r => (r.ok ? r.json() : null))
    .then(j => {
      if (!j || !j.cards) return null;
      const m = new Map();
      Object.keys(j.cards).forEach(k => m.set(k, j.cards[k]));
      signatureIndex = m;
      return m;
    })
    .catch(() => null)
    .then(m => { signatureLoading = null; return m; });
  return signatureLoading;
}

// 该卡有没有异画版（与设置无关，供 UI 判断是否显示入口）
function hasSignatureArt(cardOrId) {
  if (!signatureIndex) return false;
  const id = (cardOrId && typeof cardOrId === "object") ? cardOrId.id : String(cardOrId || "");
  return !!id && signatureIndex.has(id);
}

// 异画图 URL：只在设置开启且该卡有异画时返回，否则空串
// size 与普通卡图一致（256x / 512x），转成代理的 w 参数走已裁好的缩略图
function signatureImgUrl(cardOrId, size) {
  if (!settings.signatureArt || !signatureIndex) return "";
  const id = (cardOrId && typeof cardOrId === "object") ? cardOrId.id : String(cardOrId || "");
  if (!id || !signatureIndex.has(id)) return "";
  const w = size === "512x" ? 512 : (size === "1024x" ? 1024 : 256);
  return "api/hs-signature?card=" + encodeURIComponent(id) + "&w=" + w;
}

// 切换「异画卡图」后，已经渲染出来的 <img> 不会自己换源，需要重画一次
function rerenderCardArt() {
  try { renderDeckCards(); } catch (_) {}
  try { if (typeof doCardSearch === "function") doCardSearch(); } catch (_) {}
}

// 卡片主图 URL：天然无图的类型直接给本地占位卡背，零探测
function cardImgUrl(cardOrId, size) {
  const id = (cardOrId && typeof cardOrId === "object") ? cardOrId.id : String(cardOrId || "");
  if (!id || isNoArtType(cardOrId)) return NO_CARD_IMG;
  // 异画优先（设置开启 + 该卡有异画）
  const sig = signatureImgUrl(cardOrId, size);
  if (sig) return sig;
  return IMG_HOST + "zhCN/" + (size || "256x") + "/" + id + ".png";
}
function enCardImgUrl(cardId, size) {
  return IMG_HOST + "enUS/" + (size || "256x") + "/" + cardId + ".png";
}

// 长图专用卡图地址：走同源 Pages Function 代理。
// 原因：art.hearthstonejson.com 不返回 Access-Control-Allow-Origin，
// img.crossOrigin="anonymous" 会直接报错取不到图，不加又会让 canvas 被污染、
// toBlob() 抛 SecurityError，长图就导不出来。由 /api/card-img 代取即可两边都满足。
function posterImgUrl(card) {
  const id = (card && typeof card === "object") ? card.id : String(card || "");
  if (!id || isNoArtType(card)) return NO_CARD_IMG;
  return "/api/card-img?u=" + encodeURIComponent("render/latest/zhCN/256x/" + id + ".png");
}

// 统一的卡图 onerror 回退：zhCN → enUS → 本地占位图。
// 顶层函数声明（即挂在 window 上），详情弹窗的内联 onerror 属性也直接调用它。
function cardImgErr(img, cardId, size) {
  const id = String(cardId || img.dataset.cardId || "");
  // 异画图失败：先退回普通中文卡图。异画是可选增强，不能因为它把整张卡变成占位图。
  const cur = img.dataset.src || img.getAttribute("src") || "";
  if (cur.indexOf("hs-signature") >= 0) {
    const normal = IMG_HOST + "zhCN/" + (size || "256x") + "/" + id + ".png";
    if (img.dataset.src) img.dataset.src = normal;
    img.src = normal;
    return;
  }
  if (!img.dataset.triedEn) {
    img.dataset.triedEn = "1";
    const en = enCardImgUrl(id, size);
    // 懒加载还没真正取图时改 dataset.src，观察器稍后会读取它
    if (img.dataset.src) img.dataset.src = en; else img.src = en;
    return;
  }
  img.onerror = null;
  img.src = NO_CARD_IMG;
}

// ------------------------------------------------------------
// 卡图懒加载（IntersectionObserver 版）
// ------------------------------------------------------------
// 背景：一页 200 张卡，每张卡图约 138 KB，同域并发上限只有 6，
// 全量 eager 会把首屏拖到几十秒（单张 1s，排队后变 5s）。
//
// 为什么不用原生 loading="lazy"：
//   部分浏览器/WebView 在可滚动容器里对 loading="lazy" 支持有缺陷，
//   会出现「滚到了也不加载」的白图。IntersectionObserver 没有这个问题。
//
// 关键：图片实际滚动发生在 .card-grid（max-height:780px; overflow-y:auto）里，
//   而不是浏览器视口。所以 observer 的 root 必须**指向 .card-grid**，
//   否则视口比网格高得多，整个网格都算「可见」，懒加载形同虚设。
//
// 降级：不支持 IntersectionObserver 的环境（很老的 WebView）直接全部立即加载，
//       行为与改动前一致，不会出现白图。
const IMG_LAZY_MARGIN = "400px 0px";   // 容器上下各提前 400px（约 1 屏）开始加载
let cardImgObserver = null;
let cardImgObserverRoot = null;
// 当前这批卡里「立即加载」的张数。每次渲染前由 doCardSearch 调 computeEagerCount() 刷新，
// 保证搜索、筛选、翻页三条路径用的是同一套判定。
let cardImgEagerCount = EAGER_IMG_COUNT;

function getCardImgObserver() {
  const root = document.getElementById("cardGrid");   // 真正的滚动容器
  // 容器变了（例如页面重建）就重建 observer
  if (cardImgObserver && cardImgObserverRoot === root) return cardImgObserver;
  if (cardImgObserver) { cardImgObserver.disconnect(); cardImgObserver = null; }
  if (typeof IntersectionObserver === "undefined") return null;
  cardImgObserverRoot = root;
  cardImgObserver = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      if (img.dataset.src) {
        img.src = img.dataset.src;
        delete img.dataset.src;
      }
      obs.unobserve(img);          // 加载过一次就不再观察
    }
  }, { root: root || null, rootMargin: IMG_LAZY_MARGIN, threshold: 0.01 });
  return cardImgObserver;
}

// 渲染新一批卡之前调用：断开旧观察，避免上一批残留的 img 一直挂在 observer 上。
// （不这么做的话，反复切筛选会累积观察对象，且旧节点被 GC 前仍可能触发回调。）
function resetCardImgObserver() {
  if (cardImgObserver) {
    cardImgObserver.disconnect();
    cardImgObserver = null;
    cardImgObserverRoot = null;
  }
}

// 按容器真实尺寸算「首屏 + 预热区」能放多少张卡，作为 eager 数量。
// 与 observer 的 rootMargin 同一个语义：多算一屏做预热，保证还没滚就先备好图。
//
// 注意：doCardSearch 一进来就把网格清成「加载中…」，此时量不到 .card-item。
// 所以这里优先用上一次渲染缓存下来的尺寸（cardItemSize），量不到再现场量，
// 两者都没有才回落到 EAGER_IMG_COUNT。
let cardItemSize = null;   // {perRow, rowH}，每次渲染后从真实布局量出来

// 渲染完成后调用：直接从已布局的节点里数「第一行有几张」「行高多少」。
// 比用宽度/高度相除可靠——CSS grid 的 gap、卡片宽高比都会让除法算偏。
function measureCardItemSize() {
  const grid = document.getElementById("cardGrid");
  if (!grid) return;
  const items = grid.querySelectorAll(".card-item");
  if (!items.length) return;
  const top0 = items[0].getBoundingClientRect().top;
  let perRow = 0;
  for (const it of items) {
    if (Math.abs(it.getBoundingClientRect().top - top0) < 3) perRow++; else break;
  }
  const h = items[0].getBoundingClientRect().height;
  if (perRow > 0 && h > 0) cardItemSize = { perRow: perRow, rowH: h + 8 };
}

function computeEagerCount() {
  const grid = document.getElementById("cardGrid");
  if (!grid) return EAGER_IMG_COUNT;
  const rect = grid.getBoundingClientRect();
  if (!rect.width || !rect.height) return EAGER_IMG_COUNT;

  let perRow = 0, rowH = 0;
  if (cardItemSize) { perRow = cardItemSize.perRow; rowH = cardItemSize.rowH; }
  if (perRow <= 0 || rowH <= 0) return EAGER_IMG_COUNT;

  const rowsVisible = Math.ceil(rect.height / rowH);
  const rowsPreload = Math.ceil(400 / rowH);    // 与 IMG_LAZY_MARGIN 的 400px 对应
  const n = (rowsVisible + rowsPreload) * perRow;
  return Math.max(EAGER_IMG_COUNT, n);
}

// 把 img 设为懒加载：eager 为 true 时立即加载
function lazyLoadImg(img, eager) {
  const realSrc = img.dataset.src || img.src;
  img.dataset.src = realSrc;
  const obs = eager ? null : getCardImgObserver();
  if (!obs) {                        // eager 或环境不支持 -> 立即可靠地加载
    img.src = realSrc;
    delete img.dataset.src;
    return;
  }
  img.removeAttribute("src");        // 先不请求，等进入滚动容器视口
  obs.observe(img);
}

function createCardElement(card, index) {
  const div = document.createElement("div");
  div.className = "card-item";
  div.dataset.dbfId = card.dbfId;
  // 悬停放大用：浮层预览是拿 cardId（"CS2_029" 这种）去取图的，dbfId 取不到图
  div.dataset.hoverCardId = card.id;

  const img = document.createElement("img");
  img.decoding = "async";
  img.alt = card.name;
  img.dataset.cardId = card.id;
  img.src = cardImgUrl(card, "256x");
  // 首屏前 eagerCount 张立即加载（保证首屏无白图），其余交给 IntersectionObserver。
  // eagerCount 由 doCardSearch 按容器尺寸在每次渲染前算好，搜索与筛选走同一套逻辑。
  const eager = (index === undefined) || (index < cardImgEagerCount);
  img.fetchPriority = eager ? "high" : "low";
  img.onerror = function() { cardImgErr(this, this.dataset.cardId, "256x"); };
  lazyLoadImg(img, eager);

  const cost = document.createElement("div");
  cost.className = "card-cost";
  cost.textContent = (card.cost !== null && card.cost !== undefined) ? card.cost : "-";

  const name = document.createElement("div");
  name.className = "card-name";
  name.textContent = card.name;

  div.appendChild(img);
  div.appendChild(cost);
  div.appendChild(name);

  // 经典 / 怀旧整包视为不可收藏；核心整包视为可收藏（见 isCollectible）
  if (!isCollectible(card)) {
    const badge = document.createElement("div");
    badge.className = "card-noncollectible";
    badge.textContent = "不可收藏";
    div.appendChild(badge);
    div.style.opacity = "0.78";
  }

  const addBtn = document.createElement("div");
  addBtn.className = "card-add-btn";
  addBtn.textContent = "+";
  addBtn.title = "添加到卡组";
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    addCardToDeck(card);
  });
  div.appendChild(addBtn);

  refreshCardBadge(div, card.dbfId);

  // 拖拽进卡组列表：dragstart 携带 dbfId（存卡对象引用，drop 时直接加卡）
  div.draggable = true;
  div.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", String(card.dbfId));
    e.dataTransfer.setData("application/x-hstool-card", String(card.dbfId));
    e.dataTransfer.effectAllowed = "copy";
  });

  div.addEventListener("click", () => showCardDetail(card.dbfId));
  return div;
}

function refreshCardBadge(div, dbfId) {
  const old = div.querySelector(".card-in-deck");
  if (old) old.remove();
  const entry = deckState.cards.get(dbfId);
  if (entry && entry.count > 0) {
    const badge = document.createElement("div");
    badge.className = "card-in-deck";
    badge.textContent = "×" + entry.count;
    div.appendChild(badge);
  }
}

function refreshAllCardBadges() {
  document.querySelectorAll(".card-item[data-dbf-id]").forEach(div => {
    refreshCardBadge(div, parseInt(div.dataset.dbfId));
  });
}

// ============================================================
// 卡牌详情
// ============================================================
async function showCardDetail(dbfId) {
  const modal = document.getElementById("detailModal");
  const body = document.getElementById("detailModalBody");
  modal.classList.add("show");
  lockBodyScroll();
  body.innerHTML = '<div></div><div class="empty-state"><span class="loading-spinner"></span>加载中…</div>';

  try {
    const c = await api("/api/cards/detail", { dbfId });
    cardCache.set(c.dbfId, c);

    let imgHtml = "";
    if (c.image_512) {
      imgHtml = '<div class="detail-img-wrap"><img class="detail-img" src="' + cardImgUrl(c, "512x") + '" data-card-id="' + escapeHtml(c.id) + '" alt="' + escapeHtml(c.name) + '" onerror="cardImgErr(this, this.dataset.cardId, \'512x\')"></div>';
    }

    let infoHtml = "";
    infoHtml += '<div class="detail-name">' + escapeHtml(c.name) + '</div>';
    infoHtml += '<div class="detail-sub">' + escapeHtml(c.class_cn) + ' · ' + escapeHtml(c.type_cn) + ' · ' + escapeHtml(c.rarity_cn)
              + (isCollectible(c) ? ' · <span style="color:#5c8a5f">可收藏</span>' : ' · <span style="color:#a8977d">不可收藏</span>') + '</div>';

    infoHtml += '<div class="detail-stats">';
    if (c.cost != null) infoHtml += '<div class="detail-stat"><span class="label">法力</span><span class="value">' + c.cost + '</span></div>';
    if (c.attack != null) infoHtml += '<div class="detail-stat"><span class="label">攻击</span><span class="value">' + c.attack + '</span></div>';
    if (c.health != null) infoHtml += '<div class="detail-stat"><span class="label">生命</span><span class="value">' + c.health + '</span></div>';
    if (c.durability != null) infoHtml += '<div class="detail-stat"><span class="label">耐久</span><span class="value">' + c.durability + '</span></div>';
    infoHtml += '</div>';

    if (c.text) infoHtml += '<div class="detail-text">' + renderCardTextHtml(c.text) + '</div>';
    if (c.flavor) infoHtml += '<div class="detail-flavor">「' + escapeHtml(c.flavor) + '」</div>';

    infoHtml += '<div class="detail-meta">';
    infoHtml += '<span>DBF: ' + c.dbfId + '</span>';
    if (c.id) infoHtml += '<span>ID: ' + escapeHtml(c.id) + '</span>';
    if (c.set_cn) infoHtml += '<span>系列: ' + escapeHtml(c.set_cn) + '</span>';
    if (c.race_cn || c.race) infoHtml += '<span>种族: ' + escapeHtml(c.race_cn || c.race) + '</span>';
    if (c.spellSchool_cn || c.spellSchool) infoHtml += '<span>派系: ' + escapeHtml(c.spellSchool_cn || c.spellSchool) + '</span>';
    if (c.artist) infoHtml += '<span>画师: ' + escapeHtml(c.artist) + '</span>';
    infoHtml += '</div>';

    infoHtml += '<button class="btn btn-primary" style="width:100%;justify-content:center;" onclick="addCardToDeckByDbfId(' + c.dbfId + ');closeCardDetail();">' + ICON_PLUS + ' 添加到卡组</button>';

    // 附属卡容器：有附属卡才填充内容，否则整个块不显示（data-owner 用于异步防串台校验）
    infoHtml += '<div class="detail-attached" id="detailAttached" data-owner="' + c.dbfId + '" style="display:none;margin-top:14px;">' +
      '<div class="attached-title" id="detailAttachedTitle">附属卡牌</div>' +
      '<div class="attached-grid" id="detailAttachedGrid"></div>' +
    '</div>';

    body.innerHTML = '<div>' + imgHtml + '</div><div class="detail-info">' + infoHtml + '</div>';
    attachTiltEffect();

    // 异步加载附属卡（奇闻 token 等）：有则展示，没有则保持隐藏
    renderDetailAttached(c);
  } catch (e) {
    body.innerHTML = '<div></div><div class="empty-state">加载失败：' + escapeHtml(e.message) + '</div>';
  }
}

// 附属卡点击时计算结果缓存：dbfId -> [卡对象]
const attachedCardsCache = new Map();

// 特殊附属表：公开 JSON 里没有关联字段、但确实有组件/宝藏的卡（cardId -> 组件 cardId 数组）
const SPECIAL_ATTACHED = {
  // 奇利亚斯豪华版3000型：8 个自定义模块（公开数据无 entourage，硬编码）
  "TOY_330": ["TOY_330t92", "TOY_330t93", "TOY_330t94", "TOY_330t95",
              "TOY_330t96", "TOY_330t97", "TOY_330t98", "TOY_330t99"],
};

// 按 cardId（如 TOY_907t）查卡：先查本地缓存，再走后端搜索
async function fetchCardByCardId(cardId) {
  for (const c of cardCache.values()) {
    if (c.id === cardId) return c;
  }
  try {
    const r = await api("/api/cards/search", { query: cardId, filters: {}, offset: 0, limit: 5 });
    const hit = (r.cards || []).find(c => c.id === cardId);
    if (hit) { cardCache.set(hit.dbfId, hit); return hit; }
  } catch (e) {}
  return null;
}

// 点击详情时才计算附属卡：合并 attached_dbf（奇闻 token）与 entourage（奇利亚斯组件、尤朵拉宝藏等），按卡缓存
async function getAttachedCards(card) {
  if (attachedCardsCache.has(card.dbfId)) return attachedCardsCache.get(card.dbfId);
  const result = [];
  const seen = new Set();
  // 来源 1：attached_dbf（dbfId 数字数组）
  for (const dbf of (card.attached_dbf || [])) {
    if (seen.has(dbf)) continue;
    seen.add(dbf);
    const info = await fetchCardInfo(dbf);
    if (info) result.push(info);
  }
  // 来源 2：特殊附属表（奇利亚斯模块等公开 JSON 无关联字段的卡）
  for (const cid of (SPECIAL_ATTACHED[card.id] || [])) {
    const info = await fetchCardByCardId(cid);
    if (info && !seen.has(info.dbfId)) {
      seen.add(info.dbfId);
      result.push(info);
    }
  }
  // 来源 3：entourage（cardId 字符串数组，如尤朵拉的宝藏池）
  for (const cid of (card.entourage || [])) {
    const info = await fetchCardByCardId(cid);
    if (info && !seen.has(info.dbfId)) {
      seen.add(info.dbfId);
      result.push(info);
    }
  }
  // 来源 4：衍生 token——HearthstoneJSON 惯例 token 卡 id = 本体 id + "t..."（如 EX1_116 → EX1_116t）
  // 经典重印卡带 VAN_ 前缀而 token 仍是老 id，落空时去掉首段前缀再试一次
  if (card.id) {
    const prefixes = [card.id + "t"];
    const stripped = card.id.replace(/^[A-Z]+_/, "");   // VAN_EX1_116 → EX1_116
    if (stripped !== card.id) prefixes.push(stripped + "t");
    for (const prefix of prefixes) {
      try {
        const r = await api("/api/cards/search", { query: prefix, filters: {}, offset: 0, limit: 100 });
        for (const c of (r.cards || [])) {
          if (c.id && c.id.startsWith(prefix) && !seen.has(c.dbfId)) {
            seen.add(c.dbfId);
            result.push(c);
          }
        }
      } catch (e) {}
    }
  }
  attachedCardsCache.set(card.dbfId, result);
  return result;
}

// 卡牌详情：加载并展示附属卡，无附属卡则不显示该区域
async function renderDetailAttached(card) {
  const wrap = document.getElementById("detailAttached");
  const grid = document.getElementById("detailAttachedGrid");
  if (!wrap || !grid) return;

  let cards = await getAttachedCards(card);
  let title = "附属卡牌";
  // 没有衍生卡：如果当前卡本身是 token（id 以 t... 结尾），反查它属于哪张本体卡
  if ((!cards || cards.length === 0) && card.id) {
    const parentId = card.id.replace(/t\d*[a-z]?$/i, "");   // EX1_116t / TOY_330t94 / TOY_330t94e → 本体 id
    if (parentId && parentId !== card.id) {
      const parent = await fetchCardByCardId(parentId);
      if (parent) {
        cards = [parent];
        title = "属于";
      }
    }
  }
  if (!cards || cards.length === 0) return;
  // 异步期间用户已切换/关闭详情：容器必须还存在且仍属于当前这张卡
  const cur = document.getElementById("detailAttached");
  if (!cur || cur.dataset.owner !== String(card.dbfId)) return;
  const titleEl = document.getElementById("detailAttachedTitle");
  if (titleEl) titleEl.textContent = title;

  grid.innerHTML = "";
  cards.forEach(ac => {
    const item = document.createElement("div");
    item.className = "attached-item";
    item.title = ac.name + "（点击查看详情）";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = ac.name;
    img.dataset.cardId = ac.id;
    img.src = cardImgUrl(ac, "256x");
    // 中文图失败回退英文图，再失败用本地占位图（并把「无图」记入缓存）
    img.addEventListener("error", function() {
      cardImgErr(this, this.dataset.cardId, "256x");
    });

    const nm = document.createElement("div");
    nm.className = "attached-name";
    nm.textContent = ac.name;

    item.appendChild(img);
    item.appendChild(nm);
    item.addEventListener("click", () => showCardDetail(ac.dbfId));
    grid.appendChild(item);
  });
  wrap.style.display = "";
}

function closeCardDetail() {
  document.getElementById("detailModal").classList.remove("show");
  unlockBodyScroll();
}
// ============================================================
// 卡图鼠标跟随旋转
// ============================================================
function attachTiltEffect() {
  const img = document.querySelector(".detail-img-wrap .detail-img");
  if (!img) return;

  const maxTilt = 18;   // 最大旋转角度（度）

  const onMove = (e) => {
    // 跟随鼠标：先撤掉「放下」用的慢速过渡，恢复 0.08s，避免拖影
    img.classList.remove("settling");
    const rect = img.getBoundingClientRect();
    // 鼠标在图片内的相对坐标：-0.5 ~ 0.5
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;

    // 相吸效果：卡牌向鼠标方向倾斜（取负号）
    // px → 绕 Y 轴旋转，py → 绕 X 轴旋转
    const rotY = -px * maxTilt * 2;
    const rotX = py * maxTilt * 2;

    img.style.transform =
      "rotateY(" + rotY + "deg) rotateX(" + rotX + "deg) scale(1.06)";
  };

  const onLeave = () => {
    // 放下回正：切到 .settling 的慢速过渡（0.4s），落位更柔和
    img.classList.add("settling");
    img.style.transform = "";
  };

  // 回正动画结束后撤掉标记，恢复默认的快速过渡
  img.addEventListener("transitionend", () => img.classList.remove("settling"));

  img.addEventListener("mousemove", onMove);
  img.addEventListener("mouseleave", onLeave);
}

document.getElementById("detailModal").addEventListener("click", (e) => {
  if (e.target.id === "detailModal") closeCardDetail();
});

// ============================================================
// 组卡器
// ============================================================
async function addCardToDeck(card) {
  if (!card) return;
  // 乐队挑选模式：加入归属卡的乐队而不是卡组（所有加卡入口统一在此分流）
  if (deckState.bandTarget) {
    addCardToBand(card, deckState.bandTarget);
    return;
  }
  const dbfId = card.dbfId;
  const entry = deckState.cards.get(dbfId);
  const maxCount = maxCopiesOf(card);
  // 上限校验用「主卡组 + 乐队」的**合计**份数（牛内已占额同样受限）
  const totalCopies = countCardCopies(dbfId);
  // ⚠️ 但写回主卡组时必须用**主卡组自己的**份数，两者绝不可混用：
  // 曾误把合计份数当主卡组份数写回，导致「乐队已有 1 张 + 主卡组被写成 2 张」
  // 合计 3 张越限（传说因上限为 1、提前 return 才没暴露）。
  const deckCount = entry ? entry.count : 0;

  if (totalCopies >= maxCount) {
    toast(overLimitMessage(card, maxCount));
    return;
  }

  // 容量规则冲突校验：单卡套牌独占 / 不同张数规则并存
  const sizeConflict = deckSizeConflictMessage(card);
  if (sizeConflict) {
    toast(sizeConflict);
    return;
  }

  // 死亡骑士符文校验（对标官方组卡器：血/冰/邪合计上限 3 点）
  const runeConflict = runeConflictMessage(card);
  if (runeConflict) {
    toast(runeConflict);
    return;
  }

  // ========== 奇闻卡：先算出实际会新增的附属 token ==========
  // （排除名单里的 token 不占卡位；先取好信息，上限校验与实际加入一致）
  const attachedToAdd = [];
  for (const aDbf of (card.attached_dbf || [])) {
    if (deckState.cards.has(aDbf)) continue;       // 已经在卡组里就跳过
    let aCard = cardCache.get(aDbf);
    if (!aCard) aCard = await fetchCardInfo(aDbf); // 不在缓存则问后端要
    if (!aCard) continue;
    if (EXCLUDED_ATTACHED_NAMES.has(aCard.name)) continue;
    attachedToAdd.push({ dbfId: aDbf, card: aCard });
  }
  // ============================================================

  // 卡组总张数上限：按加入这张卡后的上限校验（这张卡自身可能就是规则卡）
  // 奇闻卡的附属 token 也占卡位，按实际会新增的 token 数预估
  const selfRule = deckSizeRuleOf(card);
  const limit = selfRule ? selfRule.size : getDeckLimit();
  if (getDeckTotalForLimit() + 1 + attachedToAdd.length > limit) {
    toast("卡组已达上限（" + limit + " 张），请先移除部分卡牌");
    return;
  }

  deckState.cards.set(dbfId, { card, count: deckCount + 1 });

  let attachedAdded = 0;
  for (const t of attachedToAdd) {
    deckState.cards.set(t.dbfId, { card: t.card, count: 1 });
    attachedAdded++;
  }

  updateDeckBadge();
  refreshAllCardBadges();
  renderDeckCards();

  let msg = "已添加：" + card.name + " ×" + (deckCount + 1);
  if (attachedAdded > 0) msg += "（附带 " + attachedAdded + " 张附属卡）";
  toast(msg);
}

function addCardToDeckByDbfId(dbfId) {
  const card = cardCache.get(dbfId);
  if (!card) return;
  // 乐队挑选模式：加入归属卡的乐队而不是卡组
  if (deckState.bandTarget) {
    addCardToBand(card, deckState.bandTarget);
    return;
  }
  addCardToDeck(card);
}

// ============================================================
// 移除卡牌（联动清理奇闻卡附属 token，避免孤儿卡）
// ============================================================
function removeCardAndAttached(dbfId) {
  const entry = deckState.cards.get(dbfId);
  if (!entry) return 0;
  deckState.cards.delete(dbfId);
  // 移除乐队归属卡时连带清空其乐队，退出对应的乐队挑选模式
  deckState.bands.delete(dbfId);
  if (deckState.bandTarget === dbfId) deckState.bandTarget = null;
  const attached = entry.card.attached_dbf || [];
  let removedAttached = 0;
  for (const aDbf of attached) {
    // 若卡组里还有其他本体卡附带这张 token，则保留
    let stillNeeded = false;
    deckState.cards.forEach(e => {
      if (!stillNeeded && (e.card.attached_dbf || []).includes(aDbf)) {
        stillNeeded = true;
      }
    });
    if (!stillNeeded && deckState.cards.has(aDbf)) {
      deckState.cards.delete(aDbf);
      removedAttached++;
    }
  }
  return removedAttached;
}

function decreaseCardInDeck(dbfId) {
  const entry = deckState.cards.get(dbfId);
  if (!entry) return;
  if (entry.count <= 1) {
    const removedAttached = removeCardAndAttached(dbfId);
    if (removedAttached > 0) {
      toast("已连同移除 " + removedAttached + " 张附属卡");
    }
  } else {
    entry.count -= 1;
  }
  updateDeckBadge();
  refreshAllCardBadges();
  renderDeckCards();
}

function increaseCardInDeck(dbfId) {
  const entry = deckState.cards.get(dbfId);
  if (!entry) return;
  const card = entry.card;
  const maxCount = maxCopiesOf(card);
  // 同上：份数上限跨「主卡组 + 乐队」合并判断
  if (countCardCopies(dbfId) >= maxCount) {
    toast(overLimitMessage(card, maxCount));
    return;
  }
  // 卡组总张数上限（特殊卡可提升至 40 张）
  const limit = getDeckLimit();
  if (getDeckTotalForLimit() >= limit) {
    toast("卡组已达上限（" + limit + " 张），请先移除部分卡牌");
    return;
  }
  entry.count += 1;
  updateDeckBadge();
  refreshAllCardBadges();
  renderDeckCards();
}

function removeCardFromDeck(dbfId) {
  const entry = deckState.cards.get(dbfId);
  if (!entry) return;
  const removedAttached = removeCardAndAttached(dbfId);
  updateDeckBadge();
  refreshAllCardBadges();
  renderDeckCards();
  toast(removedAttached > 0
    ? "已移除：" + entry.card.name + "（连带附属卡 " + removedAttached + " 张）"
    : "已移除：" + entry.card.name);
}

function clearDeck() {
  if (deckState.cards.size === 0) return;
  if (!confirm("确定清空当前卡组？")) return;
  deckState.cards.clear();
  deckState.bands.clear();
  deckState.bandTarget = null;
  updateDeckBadge();
  refreshAllCardBadges();
  renderDeckCards();
}

function updateDeckBadge() {
  let dust = 0;
  let goldDust = 0;
  const addDust = (c, n) => {
    dust += (DUST_COST[c.rarity] || 0) * n;
    goldDust += (DUST_COST_GOLD[c.rarity] || 0) * n;
  };
  deckState.cards.forEach(e => addDust(e.card, e.count));
  // 乐队（sideboard）卡牌同样计入粉尘：每张按 1 份算，与渲染时的 count: 1 保持一致
  deckState.bands.forEach(band => {
    band.forEach(bandCard => {
      // 兼容两种存法：直接存卡对象，或存 {card, count} 包装
      const c = bandCard.card || bandCard;
      addDust(c, bandCard.count || 1);
    });
  });
  const statsEl = document.getElementById("deckStatsNum");
  if (statsEl) statsEl.textContent = getDeckTotalForLimit();
  const limitEl = document.getElementById("deckLimitNum");
  if (limitEl) limitEl.textContent = getDeckLimit();
  const dustEl = document.getElementById("deckDustCost");
  if (dustEl) dustEl.textContent = dust.toLocaleString();
  const goldEl = document.getElementById("deckDustGoldCost");
  if (goldEl) goldEl.textContent = goldDust.toLocaleString();
  renderDeckRunes();
  renderManaCurve();
}

// ============================================================
// 法力曲线（0 / 1 / … / 6 / 7+ 共 8 格）
// ============================================================
const CURVE_BUCKETS = 8;   // 最后一格是 7+（7 费及以上全部并进去）

function renderManaCurve() {
  const box = document.getElementById("deckCurveBars");
  if (!box) return;

  const counts = new Array(CURVE_BUCKETS).fill(0);
  deckState.cards.forEach(e => {
    // 必须用「显示费用」而不是卡面费用：奇利亚斯本体卡面没有费用，
    // 它的实际法力值来自装配的功能模块，二者不一致会导致曲线和卡组行对不上。
    const cost = deckDisplayCost(e.card);
    const idx = Math.min(CURVE_BUCKETS - 1, Math.floor(cost));
    counts[idx] += e.count;
  });

  const max = counts.reduce((a, b) => Math.max(a, b), 0) || 1;
  let html = "";
  for (let i = 0; i < CURVE_BUCKETS; i++) {
    const n = counts[i];
    // 有卡的最低也给 8% 高度，否则 1 张的柱子矮到看不见
    const h = n ? Math.max(8, Math.round((n / max) * 100)) : 0;
    const label = (i === CURVE_BUCKETS - 1) ? "7+" : String(i);
    html +=
      '<div class="curve-col' + (n ? " has-cards" : "") + '" data-bucket="' + i + '" title="' + label + " 费：" + n + ' 张">' +
        '<div class="curve-count">' + (n || "") + "</div>" +
        '<div class="curve-track"><div class="curve-bar" style="height:' + h + '%"></div></div>' +
        '<div class="curve-label">' + label + "</div>" +
      "</div>";
  }
  box.innerHTML = html;

  const total = counts.reduce((a, b) => a + b, 0);
  const hintEl = document.getElementById("deckCurveHint");
  if (hintEl) hintEl.textContent = total ? total + " 张" : "";
}

function renderDeckHeroCard() {
  const card = document.getElementById("deckHeroCard");
  if (deckState.hero && deckState.hero.cardId) {
    const artUrl = heroIllustrationUrl(deckState.hero.cardId);
    const fallbackUrl = heroRenderUrl(deckState.hero.cardId, "zhCN");
    card.innerHTML =
      '<img src="' + artUrl + '" data-fallback="' + fallbackUrl + '" alt="' + escapeHtml(deckState.hero.name) + '" ' +
      'onerror="if(!this.dataset.triedFallback){this.dataset.triedFallback=1;this.src=this.dataset.fallback;}else{this.style.display=\'none\';}">' +
      '<div class="deck-name-label">' +
        '<span class="name">' + escapeHtml(deckState.deckName) + '</span>' +
        '<span class="hint">点击更换</span>' +
      '</div>';
  } else {
    card.innerHTML =
      '<div class="hero-placeholder">' +
        '<div class="big-icon">' + ICON_SHIELD + '</div>' +
        '<div>点击选择英雄</div>' +
      '</div>' +
      '<div class="deck-name-label">' +
        '<span class="name">' + escapeHtml(deckState.deckName) + '</span>' +
        '<span class="hint">点击选择</span>' +
      '</div>';
  }
}

// ============================================================
// 卡组列表行
// ============================================================
function createDeckRow(entry, isAttached, bandOwnerDbfId) {
  const { card, count } = entry;
  const isBand = (bandOwnerDbfId !== undefined && bandOwnerDbfId !== null);
  const isLegendary = card.rarity === "LEGENDARY";
  const isEpic = card.rarity === "EPIC";
  const maxCount = maxCopiesOf(card);

  const row = document.createElement("div");
  row.className = "deck-row" + (isAttached ? " attached" : "") + (isBand ? " band" : "");
  row.dataset.cardId = card.id;

  const bg = document.createElement("img");
  bg.className = "row-bg";
  bg.loading = "lazy";
  if (isNoArtType(card)) {
    // 天然无图的类型（附魔 / 按钮 / 拖动）：行背景直接隐藏。
    // 不换成占位卡背——卡背放大铺在 40px 行底会很难看，让行自身底色透出来更干净。
    bg.style.display = "none";
  } else {
    bg.src = cardImgUrl(card, "256x");
    bg.onerror = function() {
      // 中英文都缺：隐藏，让行自身底色透出来
      if (this.dataset.triedEn) { this.style.display = "none"; return; }
      this.dataset.triedEn = "1";
      this.src = enCardImgUrl(card.id, "256x");
    };
  }

  const badge = document.createElement("div");
  let badgeCls = "cost-badge";
  // 乐队/定制组件行（含传说）用法力绿水晶；卡组行按稀有度着色：灰(普通/免费) 蓝(稀有) 紫(史诗) 橙(传说)
  if (isBand) badgeCls += " attached-green";
  else if (isLegendary) badgeCls += " legendary";
  else if (isEpic) badgeCls += " epic";
  else if (card.rarity === "RARE") badgeCls += " rare";
  badge.className = badgeCls;
  let badgeCost = (card.cost !== null && card.cost !== undefined) ? card.cost : "-";
  if (!isBand && isZilliaxOwner(card.dbfId)) {
    // 奇利亚斯本体的法力值 = 其装配的功能模块费用之和（与法力曲线同一套算法）
    badgeCost = deckDisplayCost(card);
  }
  badge.textContent = badgeCost;

  const name = document.createElement("div");
  name.className = "name";
  name.innerHTML = escapeHtml(card.name) +
    (isLegendary ? '<span class="star">★</span>' : '');

  const cnt = document.createElement("div");
  cnt.className = "count" + (count === 1 ? " one" : "");
  cnt.textContent = "×" + count;

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const minusBtn = document.createElement("button");
  minusBtn.textContent = "−";
  minusBtn.title = isBand ? "从乐队移除" : "减少";

  const plusBtn = document.createElement("button");
  plusBtn.textContent = "+";
  plusBtn.title = "增加";

  const removeBtn = document.createElement("button");
  removeBtn.className = "remove";
  removeBtn.textContent = "×";
  removeBtn.title = isBand ? "从乐队移除" : "移除";

  if (isBand) {
    minusBtn.onclick = (e) => { e.stopPropagation(); removeCardFromBand(card.dbfId, bandOwnerDbfId); };
    plusBtn.style.display = "none";
    removeBtn.onclick = (e) => { e.stopPropagation(); removeCardFromBand(card.dbfId, bandOwnerDbfId); };
  } else {
    // 上限跨「主卡组 + 乐队」合并判断：牛内已占额时不再显示为可点（避免死按钮）
    const copies = countCardCopies(card.dbfId);
    plusBtn.disabled = copies >= maxCount;
    plusBtn.style.opacity = copies >= maxCount ? "0.4" : "1";
    minusBtn.onclick = (e) => { e.stopPropagation(); decreaseCardInDeck(card.dbfId); };
    plusBtn.onclick = (e) => { e.stopPropagation(); increaseCardInDeck(card.dbfId); };
    removeBtn.onclick = (e) => { e.stopPropagation(); removeCardFromDeck(card.dbfId); };
  }

  actions.appendChild(minusBtn);
  actions.appendChild(plusBtn);
  actions.appendChild(removeBtn);

  row.onclick = () => showCardDetail(card.dbfId);

  // 悬浮预览改由 deckCardsList 统一代理（见 bindDeckHoverPreview），
  // 避免逐行绑定 mouseenter/mouseleave 时，行与行之间的 leave→enter 竞态
  // 导致预览面板频繁闪烁（"鬼畜"）。
  row.dataset.hoverCardId = card.id;

  row.appendChild(bg);
  row.appendChild(badge);
  row.appendChild(name);
  row.appendChild(cnt);
  row.appendChild(actions);

  return row;
}

// 归属条：牛头人显示「乐队 x/3」，奇利亚斯显示「定制 x/3」，点击进入/退出挑选模式
function createBandBar(ownerCard, band) {
  const bar = document.createElement("div");
  const cur = band ? band.size : 0;
  const max = getBandMaxSize(ownerCard.dbfId);
  let cls = "deck-band-bar";
  if (deckState.bandTarget === ownerCard.dbfId) cls += " active";
  if (cur >= max) cls += " full";   // 满员：换绿色标识
  bar.className = cls;
  const label = getBandLabel(ownerCard.dbfId);
  bar.innerHTML = "<span>" + label + "</span><span>" + cur + "/" + getBandMaxSize(ownerCard.dbfId) + "</span>";
  bar.title = "点击为「" + ownerCard.name + "」挑选" + label;
  bar.onclick = (e) => { e.stopPropagation(); toggleBandMode(ownerCard.dbfId); };
  return bar;
}

function renderDeckCards() {
  hideCardHoverPreview();
  updateBandModeHint();
  const list = document.getElementById("deckCardsList");
  if (deckState.cards.size === 0) {
    list.innerHTML = '<div class="deck-empty"><span class="big-icon">' + ICON_CARD + '</span>从左侧卡牌预览页面<br>点击「+」添加到卡组</div>';
    return;
  }

  // 附属 token 归属到卡组内存在的父卡（父卡不在卡组的孤儿 token 按普通卡显示）
  const attachedByParent = new Map();
  deckState.cards.forEach(e => {
    (e.card.attached_dbf || []).forEach(a => {
      const t = deckState.cards.get(a);
      if (!t) return;
      if (!attachedByParent.has(e.card.dbfId)) attachedByParent.set(e.card.dbfId, []);
      attachedByParent.get(e.card.dbfId).push(t);
    });
  });
  const subordinateSet = new Set();
  attachedByParent.forEach(arr => arr.forEach(t => subordinateSet.add(t.card.dbfId)));

  const mainEntries = Array.from(deckState.cards.values())
    .filter(e => !subordinateSet.has(e.card.dbfId));
  // 排序用显示费用：奇利亚斯 = 功能模块费用之和，否则按模块费 0 会排到最前面
  const displayCost = e => isZilliaxOwner(e.card.dbfId) ? zilliaxDisplayCost(e.card) : (e.card.cost === undefined || e.card.cost === null ? 99 : e.card.cost);
  mainEntries.sort((a, b) => {
    const ca = displayCost(a);
    const cb = displayCost(b);
    if (ca !== cb) return ca - cb;
    return a.card.name.localeCompare(b.card.name);
  });

  // 每个父卡下的附属 token：按费用降序（无费用的排最后）
  const attachedSorted = new Map();
  attachedByParent.forEach((arr, parentId) => {
    attachedSorted.set(parentId, arr.slice().sort((a, b) => {
      const ca = a.card.cost === undefined || a.card.cost === null ? -1 : a.card.cost;
      const cb = b.card.cost === undefined || b.card.cost === null ? -1 : b.card.cost;
      if (ca !== cb) return cb - ca;
      return a.card.name.localeCompare(b.card.name);
    }));
  });

  list.innerHTML = "";
  const renderedAttached = new Set();  // 共享 token 只渲染一次
  mainEntries.forEach(entry => {
    list.appendChild(createDeckRow(entry, false));
    // 归属卡（牛头人/奇利亚斯）：行下方显示「乐队 x/3」或「定制 x/3」计数条，点击进入挑选模式
    if (isBandOwnerCard(entry.card)) {
      list.appendChild(createBandBar(entry.card, deckState.bands.get(entry.card.dbfId)));
    }
    // 奇闻附属卡
    const subs = attachedSorted.get(entry.card.dbfId);
    if (subs) {
      for (const t of subs) {
        if (renderedAttached.has(t.card.dbfId)) continue;
        renderedAttached.add(t.card.dbfId);
        list.appendChild(createDeckRow(t, true));
      }
    }
    // 乐队卡：显示在归属卡下方，按费用降序
    const band = deckState.bands.get(entry.card.dbfId);
    if (band) {
      Array.from(band.values()).sort((a, b) => {
        const ca = a.cost === undefined || a.cost === null ? -1 : a.cost;
        const cb = b.cost === undefined || b.cost === null ? -1 : b.cost;
        if (ca !== cb) return cb - ca;
        return a.name.localeCompare(b.name);
      }).forEach(bandCard => {
        list.appendChild(createDeckRow({ card: bandCard, count: 1 }, true, entry.card.dbfId));
      });
    }
  });
}

// ============================================================
// 全局悬浮预览
// ============================================================
const globalHoverPreview = document.getElementById("globalHoverPreview");
const globalHoverImg = document.getElementById("globalHoverImg");

function showCardHoverPreview(cardId, anchorEl, mode) {
  if (!cardId || !anchorEl) return;
  // 两种用途共用一个浮层：
  //   mode 缺省 / "side" —— 组卡器列表：浮层贴在行旁边，由「悬停预览」开关控制；
  //   mode "center"      —— 卡牌库网格：浮层直接盖在被悬停的卡上（视觉上就是这张卡变大了），
  //                         由「悬停放大卡牌」开关控制。
  const gate = mode === "center" ? settings.cardHoverZoom : settings.hoverPreview;
  if (!gate) return;

  const rect = anchorEl.getBoundingClientRect();
  const pw = 260;
  const gap = 14;

  // 浮层尺寸（与 CSS .global-hover-preview 一致：宽 260，高由 256/372 比例撑出约 378）
  const ph = 378;
  let left;
  let top;

  if (mode === "center") {
    // 网格一行 6~7 张，放在旁边会整片盖住邻居，所以居中盖住自己
    left = rect.left + rect.width / 2 - pw / 2;
    top = rect.top + rect.height / 2;
  } else {
    // 默认显示在行的左侧
    left = rect.left - pw - gap;
    top = rect.top + rect.height / 2;

    // 左侧空间不够 → 显示在右侧
    if (left < 8) {
      left = rect.right + gap;
    }
  }

  // 左右 / 上下边界修正（两种模式都要，居中模式下第一列、第一行会贴边）
  if (left < 8) left = 8;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top - ph / 2 < 8) top = ph / 2 + 8;
  if (top + ph / 2 > window.innerHeight - 8) {
    top = window.innerHeight - ph / 2 - 8;
  }

  globalHoverPreview.style.left = left + "px";
  globalHoverPreview.style.top = top + "px";
  globalHoverPreview.style.transform = "translateY(-50%)";

  // 只在"换了一张卡"时才替换图片源。
  // 原来的写法每次 mouseenter 都先 removeAttribute("src") 再设新 src，
  // 即使悬停的是同一张卡也会让图片瞬间清空重载（白闪）；
  // 配合上面 preview 的 display/opacity 切换，在列表里上下移动鼠标时就会"鬼畜"式闪烁。
  const nextSrc = cardImgUrl(cardId, "256x");
  if (globalHoverImg.dataset.cardId !== String(cardId)) {
    globalHoverImg.dataset.cardId = String(cardId);
    globalHoverImg.dataset.triedEn = "";
    // 三级回退与卡牌网格 / 详情弹窗统一（见 cardImgErr）
    globalHoverImg.onerror = function() {
      cardImgErr(this, this.dataset.cardId, "256x");
    };
    // 关键：先把旧位图丢掉，再挂新图。
    // 浏览器在「新图到达」之前会继续绘制上一张（实测确认），所以只改 src 的话，
    // 换卡瞬间预览会停留在上一张卡上，图床慢时最长可达数秒。
    // removeAttribute("src") 会立即丢弃旧位图；此时尺寸由 CSS 的 aspect-ratio 撑住
    // （见 .global-hover-preview img），不会塌陷跳动。
    globalHoverImg.removeAttribute("src");
    // 用 256x 缩略图，加载比 512x 快得多，预览窗宽 260px 刚好够用
    globalHoverImg.src = nextSrc;
  }

  // 保持常显：不反复 add/remove show 类，避免面板在逐行切换时闪烁
  if (globalHoverPreview.style.display !== "block") {
    globalHoverPreview.style.display = "block";
  }
  globalHoverPreview.classList.add("show");
}

function hideCardHoverPreview() {
  globalHoverPreview.classList.remove("show");
  // 延迟隐藏，等透明度过渡走完再彻底移出布局，避免与下一次显示互相打断造成闪烁
  clearTimeout(hideCardHoverPreview._t);
  hideCardHoverPreview._t = setTimeout(() => {
    if (!globalHoverPreview.classList.contains("show")) {
      globalHoverPreview.style.display = "";
    }
  }, 160);
}

// 卡组列表悬浮预览：在列表容器上做事件代理。
// 逐行绑定 mouseenter/mouseleave 时，鼠标从 A 行移到 B 行会先触发 A 的 leave、
// 紧接 B 的 enter，两个回调互相打断 → 面板 hide/show 抖动。
// 代理在容器层面统一处理，行间移动只会更新位置，不产生隐藏。
function bindDeckHoverPreview() {
  const list = document.getElementById("deckCardsList");
  if (!list || list.dataset.hoverBound === "1") return;
  list.dataset.hoverBound = "1";

  list.addEventListener("mouseover", (e) => {
    const row = e.target.closest(".deck-row[data-hover-card-id]");
    if (!row || !list.contains(row)) return;
    // 仍在同一行内移动 → 不重复处理
    if (row === list._hoverRow) return;
    list._hoverRow = row;
    showCardHoverPreview(row.dataset.hoverCardId, row);
  });

  list.addEventListener("mouseleave", () => {
    list._hoverRow = null;
    hideCardHoverPreview();
  });
}

// 卡牌库网格的悬停放大：同样用容器级事件代理。
// 放大后的卡是复用 globalHoverPreview 浮层（CSS 里 pointer-events:none），
// 所以它盖住原卡也不会打断 hover，鼠标从浮层上划过仍然是同一张卡的 hover。
function bindGridHoverZoom() {
  const grid = document.getElementById("cardGrid");
  if (!grid || grid.dataset.zoomBound === "1") return;
  grid.dataset.zoomBound = "1";

  grid.addEventListener("mouseover", (e) => {
    if (!settings.cardHoverZoom) return;
    const item = e.target.closest(".card-item[data-hover-card-id]");
    if (!item || !grid.contains(item)) return;
    // 同一张卡内移动（移到名字 / 角标上）不重复处理
    if (item === grid._zoomItem) return;
    grid._zoomItem = item;
    showCardHoverPreview(item.dataset.hoverCardId, item, "center");
  });

  grid.addEventListener("mouseleave", () => {
    grid._zoomItem = null;
    hideCardHoverPreview();
  });
}

// ============================================================
// 导出按钮：卡组导出到解码页
// ============================================================
// 从剪贴板导入卡组代码到组卡器
async function importDeckFromClipboard() {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    toast("读取剪贴板失败：" + (e.message || e) + "（浏览器可能未授权）");
    return;
  }
  text = (text || "").trim();
  if (!text) { toast("剪贴板为空"); return; }

  try {
    const r = await api("/api/decode", { content: text });
    if (!r.cards_lines) {
      toast("剪贴板内容中没有识别到卡组代码");
      return;
    }
    await importToDeckBuilder(r.heroes_lines, r.cards_lines, r.format,
                              r.sideboard_pairs || []);
    toast("已从剪贴板导入卡组");
  } catch (e) {
    toast("导入失败：" + friendlyError(e));
  }
}

async function exportDeckToDecode() {
  deckState.format = parseInt(document.getElementById("deckFormatSelect").value);

  if (deckState.cards.size === 0) { toast("卡组为空"); return; }

  const entries = Array.from(deckState.cards.values());
  entries.sort((a, b) => {
    const ca = a.card.cost === undefined || a.card.cost === null ? 99 : a.card.cost;
    const cb = b.card.cost === undefined || b.card.cost === null ? 99 : b.card.cost;
    if (ca !== cb) return ca - cb;
    return a.card.name.localeCompare(b.card.name);
  });

  const classKey = deckState.hero ? deckState.hero.cardClass : "NEUTRAL";
  const classCn = (CLASS_LIST.find(x => x[0] === classKey) || [])[1] || classKey;
  const fmtText = deckState.format === 1 ? "狂野模式" : "标准模式";

  const lines = [
    "### 由HsTool生成",
    "# 职业：" + classCn,
    "# 模式：" + fmtText,
    "#",
  ];

  entries.forEach(({ card, count }) => {
    lines.push(
      "# " + count + "x (" + (card.cost === undefined || card.cost === null ? 0 : card.cost) + ") " +
      card.name + "(DBF " + card.dbfId + ")"
    );
  });

  lines.push("# ");

  let code = "";
  try {
    const heroLine = deckState.hero && deckState.hero.dbfId
      ? String(deckState.hero.dbfId)
      : "";
    // 带 DBF ID 编码，避免同名卡编码错误
    const cardLines = entries.map(({ card, count }) =>
      card.name + "(DBF " + card.dbfId + ") × " + count
    ).join("\n");
    // 乐队（sideboard）：[[卡牌dbfId, 归属dbfId], ...]
    const sideboardPairs = [];
    deckState.bands.forEach((band, ownerDbf) => {
      band.forEach((bandCard, cardDbf) => sideboardPairs.push([cardDbf, ownerDbf]));
    });
    const r = await api("/api/encode", {
      heroes: heroLine,
      cards: cardLines,
      format: deckState.format,
      sideboard: sideboardPairs.length ? sideboardPairs : undefined,
    });
    code = r.text || "";
  } catch (e) {
    toast("卡组代码生成失败：" + friendlyError(e));
    return;
  }
  if (code) lines.push(code);

  lines.push("# ");
  lines.push('# 想要使用这副套牌，请先复制到剪贴板，然后在游戏中点击"新套牌"进行粘贴。');

  const text = lines.join("\n");

  // 就地复制导出，不切换页面
  await copyText(text);
  toast("官方导出文本已复制到剪贴板，可直接粘贴到游戏");
}

// ============================================================
// 英雄选择器
// ============================================================
function openHeroSelector() {
  document.getElementById("heroSelectorModal").classList.add("show");
  lockBodyScroll();
  renderHeroGrid();
}

function closeHeroSelector() {
  document.getElementById("heroSelectorModal").classList.remove("show");
  unlockBodyScroll();
}

// 英雄图走 art.hearthstonejson.com：
//   v1/512x/{cardId}.jpg         → 512×512 方形原画（插画，无卡框）← 英雄选择器/卡组头图用这个
//   v1/render/latest/zhCN/…png   → 带卡框的整张卡牌渲染（取不到插画时兜底）
const HERO_ART_BASE = "https://art.hearthstonejson.com/v1/";
function heroIllustrationUrl(cardId) {
  return cardId ? HERO_ART_BASE + "512x/" + cardId + ".jpg" : "";
}
function heroRenderUrl(cardId, loc) {
  return cardId ? HERO_ART_BASE + "render/latest/" + (loc || "zhCN") + "/512x/" + cardId + ".png" : "";
}

function renderHeroGrid() {
  const grid = document.getElementById("heroGrid");
  grid.innerHTML = "";

  HERO_LIST.forEach(h => {
    const div = document.createElement("div");
    div.className = "hero-item";
    const imgUrl = heroIllustrationUrl(h.cardId);
    const fallbackUrl = heroRenderUrl(h.cardId, "zhCN");
    const enUrl = heroRenderUrl(h.cardId, "enUS");
    const clsName = (CLASS_LIST.find(x => x[0] === h.cardClass) || [])[1] || h.cardClass;

    div.innerHTML =
      '<div class="hero-img-wrap">' +
        '<img loading="lazy" src="' + imgUrl + '" data-fallback="' + fallbackUrl + '" data-en="' + enUrl + '" alt="' + escapeHtml(h.name) + '" ' +
        'onerror="if(!this.dataset.triedFallback){this.dataset.triedFallback=1;this.src=this.dataset.fallback;}else if(!this.dataset.triedEn){this.dataset.triedEn=1;this.src=this.dataset.en;}else{this.style.display=\'none\';}">' +
      '</div>' +
      '<div class="hero-class">' + escapeHtml(clsName) + '</div>' +
      '<div class="hero-name">' + escapeHtml(h.name) + '</div>';

    div.addEventListener("click", () => selectHero(h));
    grid.appendChild(div);
  });
}

function selectHero(hero) {
  deckState.hero = hero;
  document.getElementById("deckHeroInput").value = hero.name + " (DBF " + hero.dbfId + ")";
  closeHeroSelector();
  renderDeckHeroCard();
  toast("已选择英雄：" + hero.name);
}

// ============================================================
// 模态框关闭
// ============================================================
document.getElementById("heroSelectorModal").addEventListener("click", (e) => {
  if (e.target.id === "heroSelectorModal") closeHeroSelector();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    // 设置面板层级最高，优先关闭
    if (settingsModal.classList.contains("show")) {
      closeSettings();
    } else if (document.getElementById("heroSelectorModal").classList.contains("show")) {
      closeHeroSelector();
    } else if (document.getElementById("detailModal").classList.contains("show")) {
      closeCardDetail();
    }
  }
});

renderDeckHeroCard();


// ============================================================
// 全局加载遮罩
// ============================================================
function showLoadingOverlay(subText) {
  const el = document.getElementById("loadingOverlay");
  const sub = document.getElementById("loadingSub");
  if (subText) sub.textContent = subText;
  el.style.display = "";
  el.classList.remove("done");
}

function hideLoadingOverlay() {
  const el = document.getElementById("loadingOverlay");
  el.classList.add("done");
  setTimeout(() => { el.style.display = "none"; }, 400);
}


// ============================================================
// 推荐页：对接 hstopdecks.com 公开接口
//   GET /api/v1/find?dust=&class=&time=&complexity=&intent=&limit=
//   GET /api/v1/meta
// 对方接口目前的状态（实测）：参数校验分支正常，真正取数时成功分支
// 常常一个字节都不回（HTTP 空回复），而且没开 CORS。
// 所以这里统一做三件事：9 秒超时、失败给可读原因、原始 JSON 折叠兜底。
// 字段名不硬编码：靠大小写/下划线无关的模糊匹配 + 兜底展开，对方改字段名也不会白屏。
// ============================================================
const FINDER_ORIGIN = "https://hstopdecks.com";
const FINDER_PROXY_KEY = "hstool.finderProxy";
const FINDER_TIMEOUT = 9000;
const FINDER_NAME_KEYS = ["name", "title", "archetype", "deckname", "decktitle", "label"];
const FINDER_CODE_KEYS = ["deckcode", "deckstring", "deckstrings", "deckcodebase64",
                          "code", "code_string", "codestring"];
let finderInited = false;
let finderProxy = "";
let finderDeckCodes = [];

function finderProxyWrap(url) {
  if (!finderProxy) return url;
  if (finderProxy.indexOf("{url}") >= 0) {
    return finderProxy.split("{url}").join(encodeURIComponent(url));
  }
  return finderProxy + encodeURIComponent(url);
}

function finderGetJson(pathAndQuery) {
  const url = FINDER_ORIGIN + pathAndQuery;
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, FINDER_TIMEOUT);
  const t0 = Date.now();
  return fetch(finderProxyWrap(url), {
    signal: ctrl.signal,
    cache: "no-store",
    headers: { "Accept": "application/json" }
  }).then(res => res.text().then(text => {
    clearTimeout(timer);
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    return { ok: !!data, status: res.status, ms: Date.now() - t0, url: url, text: text, data: data, err: "" };
  })).catch(e => {
    clearTimeout(timer);
    let msg;
    if (e && e.name === "AbortError") {
      msg = "等了 " + Math.round(FINDER_TIMEOUT / 1000) + " 秒没有任何响应，已放弃";
    } else {
      msg = "浏览器没能完成这次请求：" + ((e && e.message) || e);
    }
    return { ok: false, status: 0, ms: Date.now() - t0, url: url, text: "", data: null, err: msg };
  });
}

function finderWhyFailed(r) {
  if (r.err) {
    return escapeHtml(r.err) +
      '<br><br><b>为什么必然是这句：</b>浏览器读不到对方的响应头，就只能报 Failed to fetch。' +
      "对方现在有两道拦截（2026-11-01 实测）：" +
      '<br>① <b>跨域被按 Origin 拦掉</b>——带 <code>Origin: ' + escapeHtml(location.origin) +
      "</code> 请求，对方直接回 <code>403 {\"error\":\"origin host mismatch … ≠ hstopdecks.com\"}</code>，而且响应里没有 " +
      "<code>Access-Control-Allow-Origin</code>，浏览器因此判定失败，连状态码都不给你看；" +
      '<br>② <b>取数链路自己断流</b>——换成从服务器端直连（不带 Origin、用对方自己的 Origin 都试过），' +
      "连接会在返回任何字节之前被关闭；连它自家页面都在 <b>64 KB</b> 处截断（应回 362 KB 只收到 64.6 KB）。" +
      '<br><br>所以「代理设置」只能绕开 ①，绕不开 ②：<b>现在就算代理通了，也拿不到数据。</b>' +
      "等对方把取数链修好、并在响应里加上 CORS 头，这里会自动出结果，无需改代码。";
  }
  if (!r.text || !r.text.length) {
    return "对方返回了 HTTP " + r.status + "，但<b>响应体是 0 字节</b>。" +
      "<br>这正是该站 /api/v1/* 当前的已知故障：参数校验分支正常，真正取数时直接断流。" +
      "这不是本工具的问题，等对方修好后这里会自动恢复。";
  }
  if (!r.data) {
    return "对方返回的不是 JSON（HTTP " + r.status + "）。开头是：<br>" +
      escapeHtml(r.text.slice(0, 180));
  }
  return "对方返回了 JSON，但没从中认出卡组结构（已原样展开在下面）。";
}

/* ---------- 字段无关的取值工具 ---------- */
function finderNormKey(k) {
  return String(k).toLowerCase().replace(/[\s_\-]/g, "");
}

function finderPick(obj, names) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const keys = Object.keys(obj);
  for (let i = 0; i < names.length; i++) {
    const want = finderNormKey(names[i]);
    for (let j = 0; j < keys.length; j++) {
      if (finderNormKey(keys[j]) !== want) continue;
      const v = obj[keys[j]];
      if (v === null || v === undefined || v === "" || typeof v === "object") continue;
      return v;
    }
  }
  return undefined;
}

function finderNum(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
    return isFinite(n) ? n : null;
  }
  return null;
}

function finderPercent(v) {
  const n = finderNum(v);
  if (n === null) return "";
  const p = (n > 0 && n <= 1) ? n * 100 : n;
  return (Math.round(p * 10) / 10) + "%";
}

function finderDustText(v) {
  const n = finderNum(v);
  if (n === null) return "";
  return Math.round(n).toLocaleString("zh-CN") + " 尘";
}

// 卡组代码可能是标准 base64（含 +/=）也可能是 base64url（含 -_），
// 还常被外层字段包着换行/空格，所以先抹掉所有空白再判断。
function finderCleanCode(v) {
  if (typeof v !== "string") return "";
  const s = v.replace(/\s+/g, "");
  if (s.length < 20) return "";
  if (!/^[A-Za-z0-9+/_\-]+={0,2}$/.test(s)) return "";
  if (s.indexOf("=") < 0 && s.length < 44) return "";
  return s;
}

function finderLooksLikeCode(v) {
  return finderCleanCode(v) !== "";
}

function finderWalk(node, depth, out) {
  if (!node || typeof node !== "object" || depth > 7) return;
  if (Array.isArray(node)) {
    const n = Math.min(node.length, 120);
    for (let i = 0; i < n; i++) finderWalk(node[i], depth + 1, out);
    return;
  }
  out.push(node);
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const v = node[keys[i]];
    if (v && typeof v === "object") finderWalk(v, depth + 1, out);
  }
}

function finderExtractDecks(data) {
  const objs = [];
  finderWalk(data, 0, objs);
  const out = [];
  const seen = {};
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    const name = finderPick(o, FINDER_NAME_KEYS);
    const codeRaw = finderPick(o, FINDER_CODE_KEYS);
    const code = finderCleanCode(codeRaw);
    const wr = finderPick(o, ["winrate", "winratepercent", "wins", "winratio"]);
    const cls = finderPick(o, ["class", "classname", "playerclass", "heroclass", "hero"]);
    const dust = finderPick(o, ["dust", "dustcost", "dustrequired", "craftcost", "dustvalue"]);
    if (!name) continue;
    // 只有名字、其它字段一个都没有的对象当噪声丢掉
    if (!code && wr === undefined && cls === undefined && dust === undefined) continue;
    const key = String(name) + "|" + code;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push({ raw: o, name: name ? String(name) : "(对方未命名)", code: code, winrate: wr });
  }
  return out;
}

/* ---------- 渲染 ---------- */
function finderChip(label, val, ok) {
  if (val === undefined || val === null || val === "") return "";
  return '<span class="finder-chip' + (ok ? " ok" : "") + '">' +
    escapeHtml(String(label)) + " " + escapeHtml(String(val)) + "</span>";
}

function finderRawBlock(data) {
  if (data === null || data === undefined) return "";
  let txt;
  try { txt = JSON.stringify(data, null, 2); } catch (e) { txt = String(data); }
  const cut = txt.length > 20000;
  if (cut) txt = txt.slice(0, 20000) + "\n…（已截断）";
  return '<details class="finder-raw"><summary>原始 JSON（' + txt.length + " 字符）</summary><pre>" +
    escapeHtml(txt) + "</pre></details>";
}

function finderSrcLine(r) {
  return '<div class="finder-src">来源 ' + escapeHtml(r.url) +
    "　HTTP " + r.status + "　" + r.ms + " ms" +
    (finderProxy ? "　（经代理）" : "") + "</div>";
}

function finderDeckCard(d, idx) {
  const o = d.raw;
  const cls = finderPick(o, ["class", "classname", "playerclass", "heroclass", "hero"]);
  const dust = finderDustText(finderPick(o, ["dust", "dustcost", "dustrequired", "craftcost", "dustvalue"]));
  const tier = finderPick(o, ["tier", "tierlabel", "tiername", "grade", "rank"]);
  const sample = finderPick(o, ["samplesize", "samples", "games", "matches", "sample", "n"]);
  const wr = finderPercent(d.winrate);

  let html = '<div class="finder-deck">';
  html += '<div class="finder-deck-head">';
  html += '<span class="finder-deck-name">' + escapeHtml(d.name) + "</span>";
  html += finderChip("职业", cls);
  html += finderChip("梯度", tier);
  html += finderChip("粉尘", dust);
  html += finderChip("胜率", wr, true);
  html += finderChip("样本", sample);
  html += "</div>";

  if (d.code) {
    html += '<div class="finder-code"><code>' + escapeHtml(d.code) + "</code>";
    html += '<button class="btn btn-ghost" data-finder-action="copy" data-idx="' + idx + '">复制</button>';
    html += '<button class="btn btn-success" data-finder-action="import" data-idx="' + idx + '">导入组卡器</button>';
    html += "</div>";
  } else {
    html += '<div class="finder-src">这套对方没给卡组代码，只能看下面的原始字段。</div>';
  }
  html += "</div>";
  return html;
}

function finderRenderDecks(list, box, r) {
  finderDeckCodes = [];
  let html = finderSrcLine(r);
  for (let i = 0; i < list.length; i++) {
    finderDeckCodes.push(list[i].code || "");
    html += finderDeckCard(list[i], i);
  }
  html += finderRawBlock(r.data);
  box.innerHTML = html;
}

function finderValueText(v) {
  if (v === null || v === undefined) return '<span style="color:var(--muted-light)">—</span>';
  if (typeof v === "object") {
    try { return escapeHtml(JSON.stringify(v)); } catch (e) { return "…"; }
  }
  return escapeHtml(String(v));
}

function finderTable(rows) {
  const cols = [];
  const probe = Math.min(rows.length, 5);
  for (let i = 0; i < probe; i++) {
    const ks = Object.keys(rows[i]);
    for (let j = 0; j < ks.length; j++) {
      if (cols.indexOf(ks[j]) < 0 && cols.length < 8) cols.push(ks[j]);
    }
  }
  let html = '<table class="finder-tbl"><thead><tr>';
  for (let i = 0; i < cols.length; i++) html += "<th>" + escapeHtml(cols[i]) + "</th>";
  html += "</tr></thead><tbody>";
  const n = Math.min(rows.length, 60);
  for (let i = 0; i < n; i++) {
    html += "<tr>";
    for (let j = 0; j < cols.length; j++) html += "<td>" + finderValueText(rows[i][cols[j]]) + "</td>";
    html += "</tr>";
  }
  html += "</tbody></table>";
  if (rows.length > n) {
    html += '<div class="finder-src">只显示前 ' + n + " 行，共 " + rows.length + " 行</div>";
  }
  return html;
}

function finderAutoBody(data) {
  if (data === null || data === undefined) {
    return '<div class="empty-state">对方返回了空内容</div>';
  }
  if (Array.isArray(data)) {
    if (!data.length) return '<div class="empty-state">空数组</div>';
    const objs = data.filter(x => x && typeof x === "object" && !Array.isArray(x));
    if (objs.length === data.length) return finderTable(objs);
    let html = '<dl class="finder-kv">';
    const n = Math.min(data.length, 60);
    for (let i = 0; i < n; i++) {
      html += "<dt>#" + (i + 1) + "</dt><dd>" + finderValueText(data[i]) + "</dd>";
    }
    html += "</dl>";
    return html;
  }
  if (typeof data === "object") {
    const keys = Object.keys(data);
    let html = "";
    const flat = keys.filter(k => !data[k] || typeof data[k] !== "object");
    if (flat.length) {
      html += '<dl class="finder-kv">';
      for (let i = 0; i < flat.length; i++) {
        html += "<dt>" + escapeHtml(flat[i]) + "</dt><dd>" + finderValueText(data[flat[i]]) + "</dd>";
      }
      html += "</dl>";
    }
    const nested = keys.filter(k => data[k] && typeof data[k] === "object");
    for (let i = 0; i < nested.length; i++) {
      const v = data[nested[i]];
      html += '<div class="finder-sub"><div class="finder-sub-title">' + escapeHtml(nested[i]) +
        "</div>" + finderAutoBody(v) + "</div>";
    }
    return html || '<div class="empty-state">对象是空的</div>';
  }
  return '<dl class="finder-kv"><dt>值</dt><dd>' + finderValueText(data) + "</dd></dl>";
}

function finderRenderAuto(data, box, r) {
  box.innerHTML = finderSrcLine(r) + finderAutoBody(data) + finderRawBlock(data);
}

function finderErrorBox(r) {
  return '<div class="finder-err">' + finderWhyFailed(r) + "</div>" +
    '<div class="actions" style="margin-top:0;">' +
    '<a class="btn btn-ghost" href="' + escapeHtml(r.url) + '" rel="noopener">在新窗口打开该接口</a>' +
    "</div>" + finderSrcLine(r);
}

/* ---------- 交互 ---------- */
async function finderRunFind() {
  const box = document.getElementById("finderResult");
  const st = document.getElementById("finderStatus");
  const params = new URLSearchParams();
  params.set("dust", document.getElementById("findDust").value);
  const pairs = [
    ["class", "findClass"],
    ["time", "findTime"],
    ["complexity", "findComplexity"],
    ["intent", "findIntent"],
    ["limit", "findLimit"]
  ];
  for (let i = 0; i < pairs.length; i++) {
    const v = document.getElementById(pairs[i][1]).value;
    if (v && v !== "any") params.set(pairs[i][0], v);
  }
  const path = "/api/v1/find?" + params.toString();
  st.textContent = "查询中…";
  box.innerHTML = '<div class="empty-state">正在请求 ' + escapeHtml(path) + " …</div>";
  const r = await finderGetJson(path);
  if (!r.data) {
    st.textContent = "失败（" + r.ms + " ms）";
    box.innerHTML = finderErrorBox(r);
    return;
  }
  const decks = finderExtractDecks(r.data);
  if (decks.length) {
    st.textContent = "回来 " + decks.length + " 套 · " + r.ms + " ms";
    finderRenderDecks(decks, box, r);
  } else {
    st.textContent = "回来了，但没认出卡组结构 · " + r.ms + " ms";
    finderRenderAuto(r.data, box, r);
  }
}

async function finderRunMeta() {
  const box = document.getElementById("finderMeta");
  const st = document.getElementById("finderMetaStatus");
  st.textContent = "获取中…";
  box.innerHTML = '<div class="empty-state">正在请求 /api/v1/meta …</div>';
  const r = await finderGetJson("/api/v1/meta");
  if (!r.data) {
    st.textContent = "失败（" + r.ms + " ms）";
    box.innerHTML = finderErrorBox(r);
    return;
  }
  st.textContent = "已获取 · " + r.ms + " ms";
  const decks = finderExtractDecks(r.data);
  if (decks.length) finderRenderDecks(decks, box, r);
  else finderRenderAuto(r.data, box, r);
}

async function finderImportToDeck(code) {
  try {
    toast("正在解码卡组代码…");
    const r = await api("/api/decode", { content: code });
    await importToDeckBuilder(r.heroes_lines, r.cards_lines, r.format, r.sideboard_pairs);
    switchTab("preview");
    toast("已导入到组卡器");
  } catch (e) {
    toast("导入失败：" + friendlyError(e));
  }
}

function finderLoadProxy() {
  try {
    finderProxy = localStorage.getItem(FINDER_PROXY_KEY) || "";
  } catch (e) {
    finderProxy = "";
  }
  const inp = document.getElementById("finderProxy");
  if (inp) inp.value = finderProxy;
}

function initFinder() {
  if (finderInited) return;
  finderInited = true;
  finderLoadProxy();

  const btnFind = document.getElementById("btnFind");
  const btnMeta = document.getElementById("btnFindMeta");
  const btnProxy = document.getElementById("btnFinderProxy");
  const proxyRow = document.getElementById("finderProxyRow");
  const btnProxySave = document.getElementById("btnFinderProxySave");
  const box = document.getElementById("finderResult");

  if (btnFind) btnFind.addEventListener("click", finderRunFind);
  if (btnMeta) btnMeta.addEventListener("click", finderRunMeta);

  if (btnProxy && proxyRow) {
    btnProxy.addEventListener("click", () => {
      proxyRow.style.display = proxyRow.style.display === "none" ? "" : "none";
    });
  }
  if (btnProxySave) {
    btnProxySave.addEventListener("click", () => {
      const inp = document.getElementById("finderProxy");
      const v = (inp && inp.value ? inp.value : "").trim();
      finderProxy = v;
      try {
        if (v) localStorage.setItem(FINDER_PROXY_KEY, v);
        else localStorage.removeItem(FINDER_PROXY_KEY);
      } catch (e) { /* 隐私模式下写不了，忽略 */ }
      toast(v ? "代理已保存" : "代理已清空");
    });
  }

  if (box) {
    box.addEventListener("click", ev => {
      const btn = ev.target.closest ? ev.target.closest("[data-finder-action]") : null;
      if (!btn) return;
      const idx = parseInt(btn.getAttribute("data-idx"), 10);
      const code = finderDeckCodes[idx] || "";
      if (!code) return;
      const act = btn.getAttribute("data-finder-action");
      if (act === "copy") copyText(code);
      else if (act === "import") finderImportToDeck(code);
    });
  }

  initHsLibrary();
  hsEnhanceSelects();
}

/* ============================================================
 * 外部卡组库：经本站 Pages Function（/api/hs-decks）同源取数
 * 对方 API 断流 + 无 CORS 头，浏览器直连必然失败；
 * 这里改由服务端抓卡组详情页，再以同源 JSON 返回。
 * ============================================================ */
var HS_PROXY = "/api/hs-decks";
var HS_TIMEOUT = 25000;
var hsIndexList = [];
var hsInited = false;
var hsClassValue = "";
var HS_CLASSES = ["死亡骑士", "恶魔猎手", "德鲁伊", "猎人", "法师", "圣骑士", "牧师", "潜行者", "萨满祭司", "术士", "战士"];

async function hsGet(qs) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, HS_TIMEOUT);
  var res;
  try {
    res = await fetch(HS_PROXY + qs, { signal: ctrl.signal, headers: { accept: "application/json" } });
  } catch (e) {
    throw new Error("连不上本站后端（" + friendlyError(e) + "）");
  } finally {
    clearTimeout(timer);
  }
  var txt = await res.text();
  var data = null;
  try { data = JSON.parse(txt); } catch (e) { data = null; }
  if (!data) {
    if (res.status === 404) {
      throw new Error("本站没有后端：/api/hs-decks 返回 404。本地静态预览没有 Functions，部署到 Cloudflare Pages 后才有。");
    }
    throw new Error("后端返回的不是 JSON（HTTP " + res.status + "）");
  }
  if (data.ok === false) throw new Error(data.hint || data.error || ("HTTP " + res.status));
  return data;
}

function hsChipsRow(d) {
  var html = "";
  html += finderChip("职业", d.cls);
  html += finderChip("模式", d.format);
  html += finderChip("梯度", d.tier);
  html += finderChip("胜率", d.winrate === null || d.winrate === undefined ? "" : d.winrate + "%", true);
  html += finderChip("样本", d.games ? d.games + " 局" : "");
  html += finderChip("粉尘", d.dust ? d.dust : "");
  return html;
}

function hsRenderList() {
  var box = document.getElementById("hsList");
  var st = document.getElementById("hsStatus");
  if (!box) return;
  var qInput = document.getElementById("hsSearch");
  var cls = hsClassValue;
  var q = qInput ? qInput.value.trim().toLowerCase() : "";

  var list = hsIndexList;
  if (cls) list = list.filter(function (d) { return d.cls === cls; });
  if (q) list = list.filter(function (d) { return d.name.toLowerCase().indexOf(q) >= 0; });

  if (st) {
    st.textContent = "共 " + hsIndexList.length + " 套，当前筛出 " + list.length + " 套";
  }
  if (!list.length) {
    box.innerHTML = '<div class="empty-state">没有符合条件的卡组</div>';
    return;
  }

  var html = '<div class="finder-src">数据来自本站在服务端抓取的对方卡组页（不是对方的 API）</div>';
  var n = Math.min(list.length, 120);
  for (var i = 0; i < n; i++) {
    var d = list[i];
    html += '<div class="finder-deck">';
    html += '<div class="finder-deck-head">';
    html += '<span class="finder-deck-name">' + escapeHtml(d.name) + "</span>";
    html += hsChipsRow(d);
    html += '<button class="btn btn-success" data-hs-import="' + escapeHtml(d.slug) + '">导入组卡器</button>';
    html += "</div></div>";
  }
  if (list.length > n) {
    html += '<div class="finder-src">只列前 ' + n + " 套（共 " + list.length + " 套），用上面的筛选缩小范围</div>";
  }
  box.innerHTML = html;
}

async function hsLoadIndex() {
  var box = document.getElementById("hsList");
  var st = document.getElementById("hsStatus");
  if (st) st.textContent = "正在取数…";
  if (box) box.innerHTML = '<div class="empty-state">正在让后端去抓对方卡组列表，通常 5–10 秒…</div>';
  try {
    var data = await hsGet("?mode=index&limit=800");
    hsIndexList = data.decks || [];
    if (!hsIndexList.length) {
      if (box) box.innerHTML = '<div class="empty-state">后端拿到页面但没解析出卡组</div>';
      if (st) st.textContent = "0 套";
      return;
    }
    hsRenderList();
    toast("已加载 " + hsIndexList.length + " 套卡组");
  } catch (e) {
    if (st) st.textContent = "取数失败";
    if (box) box.innerHTML = '<div class="empty-state">' + escapeHtml(friendlyError(e)) + "</div>";
    toast("取数失败：" + friendlyError(e));
  }
}

async function hsImportDeck(slug, btn) {
  var old = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "抓取中…"; }
  try {
    var data = await hsGet("?mode=deck&slug=" + encodeURIComponent(slug));
    var deck = data.deck || {};
    if (!deck.code) throw new Error("这套的详情页里没有卡组代码");
    await finderImportToDeck(deck.code);
  } catch (e) {
    toast("导入失败：" + friendlyError(e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

/* 自绘下拉框：复刻卡牌库筛选器那套 .filter-dd 组件（按钮 + 面板 + 勾选 + 清除），单选 */
function hsCreateDropdown(opts) {
  var options = opts.options || [];
  var state = { value: opts.value === undefined ? (options.length ? options[0][0] : "") : opts.value };

  var dd = document.createElement("div");
  dd.className = "filter-dd" + (opts.className ? " " + opts.className : "");
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "filter-dd-btn";
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");
  if (opts.label) btn.setAttribute("title", opts.label);
  btn.innerHTML = '<span class="dd-label"></span><span class="dd-caret">▼</span>';
  var menu = document.createElement("div");
  menu.className = "filter-dd-menu";
  menu.setAttribute("role", "menu");

  function textOf(v) {
    for (var i = 0; i < options.length; i++) if (options[i][0] === v) return options[i][1];
    return options.length ? options[0][1] : "";
  }

  function paintBtn() {
    var lb = btn.querySelector(".dd-label");
    if (lb) lb.textContent = textOf(state.value);
    var base = options.length ? options[0][0] : "";
    btn.classList.toggle("has-value", state.value !== base);
  }

  function paintMenu() {
    var html = "";
    if (opts.label) html += '<div class="menu-group-title">' + escapeHtml(opts.label) + "</div>";
    for (var i = 0; i < options.length; i++) {
      var v = options[i][0], t = options[i][1], on = v === state.value;
      html += '<button type="button" class="menu-item" role="menuitemradio" aria-checked="' + (on ? "true" : "false") +
        '" data-dd-value="' + escapeHtml(String(v)) + '"><span>' + escapeHtml(t) + "</span>" +
        (on ? '<span class="menu-item-check">✓</span>' : "") + "</button>";
    }
    if (opts.clearLabel) {
      var base = options.length ? options[0][0] : "";
      html += '<button type="button" class="menu-clear" data-dd-clear="1"' + (state.value !== base ? "" : " hidden") + ">" + escapeHtml(opts.clearLabel) + "</button>";
    }
    menu.innerHTML = html;
  }

  function close() {
    menu.classList.remove("show");
    btn.setAttribute("aria-expanded", "false");
  }

  function pick(v) {
    if (v === state.value) return close();
    state.value = v;
    paintBtn();
    close();
    if (opts.onPick) opts.onPick(v);
  }

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (menu.classList.contains("show")) return close();
    paintMenu();
    menu.classList.add("show");
    btn.setAttribute("aria-expanded", "true");
  });

  menu.addEventListener("click", function (e) {
    e.stopPropagation();
    var t = e.target;
    var item = t && t.closest ? t.closest("[data-dd-value]") : null;
    if (item) return pick(item.getAttribute("data-dd-value"));
    var clr = t && t.closest ? t.closest("[data-dd-clear]") : null;
    if (clr) pick(options.length ? options[0][0] : "");
  });

  document.addEventListener("click", close);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });

  dd.appendChild(btn);
  dd.appendChild(menu);
  if (opts.mount) opts.mount.appendChild(dd);
  paintBtn();
  paintMenu();
  dd.hsSync = function (v) { state.value = v; paintBtn(); paintMenu(); };
  return dd;
}

/* 外部卡组库：职业筛选下拉（自绘） */
function hsBuildClassDropdown() {
  var wrap = document.getElementById("hsDropdowns");
  if (!wrap || wrap.dataset.init) return;
  wrap.dataset.init = "1";
  wrap.innerHTML = "";
  var options = [["", "全部职业"]];
  for (var i = 0; i < HS_CLASSES.length; i++) options.push([HS_CLASSES[i], HS_CLASSES[i]]);
  hsCreateDropdown({
    mount: wrap,
    label: "职业",
    options: options,
    value: hsClassValue,
    clearLabel: "清除职业筛选",
    onPick: function (v) {
      hsClassValue = v;
      if (hsIndexList.length) hsRenderList();
      else if (v) hsLoadIndex();
    }
  });
}

/* 推荐页的原生 <select> 换成同一套自绘下拉：select 只留作取值容器，既有读取逻辑完全不变 */
function hsEnhanceSelects() {
  var form = document.querySelector("#tab-finder .finder-form");
  if (!form) return;
  var sels = form.querySelectorAll("select");
  for (var i = 0; i < sels.length; i++) {
    (function (sel) {
      if (sel.dataset.ddDone) return;
      sel.dataset.ddDone = "1";
      var options = [];
      for (var j = 0; j < sel.options.length; j++) {
        options.push([sel.options[j].value, (sel.options[j].textContent || "").trim()]);
      }
      var host = document.createElement("div");
      host.className = "filter-dd-host";
      sel.parentNode.insertBefore(host, sel.nextSibling);
      sel.style.display = "none";
      sel.setAttribute("tabindex", "-1");
      sel.setAttribute("aria-hidden", "true");
      hsCreateDropdown({
        mount: host,
        label: "",
        options: options,
        value: sel.value,
        onPick: function (v) {
          sel.value = v;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    })(sels[i]);
  }
}

/* 卡组侧栏「狂野 / 标准」的原生 select 换成同一套自绘下拉。
   select 本身隐藏但保留在 DOM 里当取值容器：现有代码读的都是
   document.getElementById("deckFormatSelect").value，因此一行都不用改。 */
function hsBuildDeckFormatDropdown() {
  var host = document.getElementById("deckFormatDd");
  var sel = document.getElementById("deckFormatSelect");
  if (!host || !sel || host.dataset.init) return;
  host.dataset.init = "1";
  var options = [];
  for (var i = 0; i < sel.options.length; i++) {
    options.push([sel.options[i].value, (sel.options[i].textContent || "").trim()]);
  }
  var dd = hsCreateDropdown({
    mount: host,
    label: "",
    options: options,
    value: sel.value,
    onPick: function (v) {
      sel.value = v;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  sel._hsDd = dd;
}

/* 代码里直接给 deckFormatSelect.value 赋值时（如导入卡组回填模式），把自绘下拉同步过去 */
function hsSyncDeckFormat() {
  var sel = document.getElementById("deckFormatSelect");
  if (sel && sel._hsDd) sel._hsDd.hsSync(sel.value);
}

function initHsLibrary() {
  if (hsInited) return;
  hsInited = true;
  var btn = document.getElementById("btnHsLoad");
  var box = document.getElementById("hsList");
  var qInput = document.getElementById("hsSearch");

  hsBuildClassDropdown();

  if (btn) btn.addEventListener("click", hsLoadIndex);
  if (qInput) {
    qInput.addEventListener("input", function () {
      if (!hsIndexList.length) return;
      clearTimeout(qInput._t);
      qInput._t = setTimeout(hsRenderList, 180);
    });
  }
  if (box) {
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("[data-hs-import]") : null;
      if (!b) return;
      hsImportDeck(b.getAttribute("data-hs-import"), b);
    });
  }
}


// ============================================================
// 第一梯队补齐（对标暴雪官方组卡器）：
//   1) 关键词解释 tooltip      3) 卡组长图（canvas）
//   4) 死亡骑士符文校验        5) 卡牌库排序方式
// 说明：本段整体追加在 app.js 末尾，只读依赖前面已声明的函数与常量；
//       KEYWORD_DEFS / KEYWORD_SLUGS 数据取自暴雪官方组卡器关键词表的 refText。
// ============================================================

// 关键词中文释义（取自暴雪官方组卡器关键词表的 refText，约 67 条）
const KEYWORD_DEFS = {
  "嘲讽": "敌人必须攻击具有嘲讽的随从。",
  "法术伤害": "你的法术能造成额外的伤害。",
  "圣盾": "被圣盾保护的随从免疫其受到的第一次伤害。",
  "冲锋": "可以立即发起攻击。",
  "奥秘": "在对手的回合发生某些特殊情况时展示并产生效果。",
  "潜行": "无法被攻击或被指定为目标，直到其开始攻击为止。",
  "战吼": "当你从你的手牌中使用它的时候，它会产生一些效果。",
  "冻结": "被冻结的角色失去他们的下一次攻击机会。",
  "风怒": "每个回合能够攻击两次。",
  "亡语": "在其死亡时会产生一些效果。",
  "连击": "如果在本回合中你已经使用过其他牌，它会产生额外的效果。",
  "过载：X": "具有过载效果的卡牌会在下一个回合限制你的法力值。",
  "沉默": "移除所有卡牌描述和附加效果。",
  "反制": "被反制的牌不会产生任何效果。",
  "免疫": "免疫的角色无法成为敌方的目标，不会受到伤害。",
  "备用零件": "备用零件是一些法力值消耗为（1）点的法术，使用它们能够产生一些效果。",
  "激励": "在你使用英雄技能后才会触发效果。",
  "发现": "在三张卡牌中选择其一置入你的手牌。",
  "任务": "会出现在起始手牌中。完成任务，获取奖励。",
  "剧毒": "消灭任何受到其伤害的随从。",
  "进化": "在三个增益中选择其一。",
  "吸血": "造成伤害的同时，为你的英雄恢复等量的生命值。",
  "招募": "从你的牌库中召唤一个随从。",
  "回响": "使用此牌的回合内可反复使用。复制牌的法力值消耗不能低于（1）点。",
  "突袭": "可以立即攻击随从。",
  "超杀": "如果这张牌在你的回合中造成了过量的伤害，它会产生额外的效果。",
  "对战开始时": "对战一开始就会产生某种作用。",
  "磁力": "将具有磁力的牌置于机械牌的左侧可使其合体！",
  "跟班": "跟班是一类法力值消耗为（1）点的具有战吼的随从。",
  "双生法术": "可以被施放两次。",
  "超级风怒": "每个回合能够攻击四次。",
  "复生": "在其首次死亡时复活，并具有1点生命值。",
  "祈求": "使用迦拉克隆的技能。",
  "流放": "在手牌中的最左或最右侧使用时触发的额外效果。",
  "法术迸发": "在你施放一个法术后触发的一次性效果。",
  "支线任务": "完成任务，获取奖励。",
  "腐蚀": "当它在你的手牌中时，使用一张法力值消耗更高的牌就会使其升级。",
  "任务线": "会出现在起始手牌中。完成任务，获取奖励，最多3步！",
  "可交易": "可以将此牌拖入牌库，消耗1点法力值并另抽一张牌。",
  "暴怒": "该随从第一次受到伤害并存活后触发的一次性效果。",
  "荣誉消灭": "如果这张牌在你的回合中造成了刚好消灭目标的伤害，它会产生额外的效果。",
  "自然法术伤害": "你的自然法术能造成额外的伤害。",
  "鲜血宝石": "法术牌，使一个友方随从获得+1/+1。",
  "刷新": "让酒馆换上新的卡牌。",
  "复仇（X）": "在战斗阶段中，X个友方随从死亡后，它会产生一些效果。",
  "巨型+X": "被召唤时会生成X个附属物。",
  "探底": "检视你牌库底的3张牌，将其中一张置于牌库顶。",
  "塑造法术": "每回合获得一张临时法术牌。",
  "注能": "此牌在你手中时，在X个友方随从死亡后此牌会升级。",
  "残骸": "当友方随从死亡时会获得的一种资源。",
  "压轴": "当这张牌消耗了你剩余的所有法力值时触发的加成效果。",
  "过量治疗": "受到的治疗溢出时触发的加成效果。",
  "法力渴求（X）": "如果你有X个法力水晶，就会有加成效果。",
  "烈毒": "可以消灭第一个受到其伤害的随从。",
  "扰魔": "无法成为法术或英雄技能的目标。",
  "锻造": "可以将此牌拖向牌库，消耗（2）点法力值以提升其效果。",
  "泰坦": "点击泰坦不会使其攻击，而会弹出3个技能，你可以选择1个使用。",
  "微缩": "获取本牌的一张法力值消耗为（1）的1/1复制。",
  "微型": "某张牌的法力值消耗为（1）的1/1复制。",
  "快枪": "如果在本回合中进入你的手牌则会有加成效果。",
  "发掘": "挖出越来越稀有的宝藏。稀有度将在达到最高后重置。",
  "传递": "送到你的队友的手中。",
  "伙伴": "与各英雄技能配套的强力随从。",
  "灌注": "获得一项新的英雄技能，你每灌注一次，该技能都会升级。",
  "黑暗之赐": "附加在随从上的增益。",
  "临时": "在你的回合结束时弃掉。",
  "星舰": "星舰拥有你此前死亡的组件的属性值和效果。点击即可发射！",
};
// mechanics 代码 → 中文关键词（用于按 mechanics 标悬浮解释）
const KEYWORD_SLUGS = {
  "TAUNT": "嘲讽",
  "SPELL-DAMAGE": "法术伤害",
  "DIVINE-SHIELD": "圣盾",
  "CHARGE": "冲锋",
  "SECRET": "奥秘",
  "STEALTH": "潜行",
  "BATTLECRY": "战吼",
  "FREEZE": "冻结",
  "WINDFURY": "风怒",
  "DEATHRATTLE": "亡语",
  "COMBO": "连击",
  "OVERLOAD:-X": "过载：X",
  "SILENCE": "沉默",
  "COUNTER": "反制",
  "IMMUNE": "免疫",
  "SPARE-PARTS": "备用零件",
  "INSPIRE": "激励",
  "DISCOVER": "发现",
  "QUEST": "任务",
  "POISONOUS": "剧毒",
  "ADAPT": "进化",
  "LIFESTEAL": "吸血",
  "RECRUIT": "招募",
  "ECHO": "回响",
  "RUSH": "突袭",
  "OVERKILL": "超杀",
  "START-OF-GAME": "对战开始时",
  "MAGNETIC": "磁力",
  "LACKEY": "跟班",
  "TWINSPELL": "双生法术",
  "MEGA-WINDFURY": "超级风怒",
  "REBORN": "复生",
  "INVOKE": "祈求",
  "OUTCAST": "流放",
  "SPELLBURST": "法术迸发",
  "SIDEQUEST": "支线任务",
  "CORRUPT": "腐蚀",
  "QUESTLINE": "任务线",
  "TRADEABLE": "可交易",
  "FRENZY": "暴怒",
  "HONORABLE-KILL": "荣誉消灭",
  "NATURE-SPELL-DAMAGE": "自然法术伤害",
  "BLOOD-GEM": "鲜血宝石",
  "REFRESH": "刷新",
  "AVENGE-(X)": "复仇（X）",
  "COLOSSAL-+X": "巨型+X",
  "DREDGE": "探底",
  "SPELLCRAFT": "塑造法术",
  "INFUSE": "注能",
  "CORPSE": "残骸",
  "FINALE": "压轴",
  "OVERHEAL": "过量治疗",
  "MANATHIRST-(X)": "法力渴求（X）",
  "VENOMOUS": "烈毒",
  "ELUSIVE": "扰魔",
  "FORGE\\T\\T": "锻造",
  "TITAN": "泰坦",
  "MINIATURIZE": "微缩",
  "MINI": "微型",
  "QUICKDRAW": "快枪",
  "EXCAVATE": "发掘",
  "PASS": "传递",
  "BUDDY": "伙伴",
  "IMBUE": "灌注",
  "DARK-GIFT": "黑暗之赐",
  "TEMPORARY": "临时",
  "STARSHIP": "星舰",
};

// ---------- 1. 关键词解释 ----------

// 关键词查表：卡面写法可能带「（X）」「+X」等后缀，逐级回退
function lookupKeyword(raw) {
  const key = String(raw || "").trim();
  if (!key) return "";
  if (KEYWORD_DEFS[key]) return KEYWORD_DEFS[key];
  const stripped = key.replace(/[（(].*?[)）]/g, "").replace(/[+＋]\s*\d+/g, "").replace(/\d+$/g, "").trim();
  if (KEYWORD_DEFS[stripped]) return KEYWORD_DEFS[stripped];
  // 「法术伤害」「自然法术伤害」这类前缀变体
  const tail = stripped.replace(/^(自然|奥术|火焰|冰霜|神圣|暗影|邪能)/, "");
  if (tail && KEYWORD_DEFS[tail]) return KEYWORD_DEFS[tail];
  return "";
}

// 卡牌文本 → 安全 HTML：只保留 <b></b><i></i>，其余尖括号全部转义，
// 并把命中关键词的 <b> 打上 data-kw 供悬浮解释使用（B10 的同类问题一并堵住）
function renderCardTextHtml(text) {
  const src = String(text || "");
  const parts = src.split(/(<\/?(?:b|i)>)/i);
  let html = "";
  for (const part of parts) {
    if (/^<\/?(?:b|i)>$/i.test(part)) html += part.toLowerCase();
    else html += escapeHtml(part);
  }
  return html.replace(/<b>([^<]{1,14})<\/b>/g, function (m, inner) {
    if (!lookupKeyword(inner)) return m;
    return '<b class="kw" data-kw="' + escapeHtml(inner.trim()) + '">' + inner + "</b>";
  });
}

let kwTipEl = null;
function ensureKwTip() {
  if (kwTipEl && kwTipEl.isConnected) return kwTipEl;
  kwTipEl = document.createElement("div");
  kwTipEl.className = "kw-tip";
  kwTipEl.setAttribute("role", "tooltip");
  document.body.appendChild(kwTipEl);
  return kwTipEl;
}

function showKwTip(target) {
  const kw = target.getAttribute("data-kw");
  const def = lookupKeyword(kw);
  if (!kw || !def) return;
  const tip = ensureKwTip();
  tip.innerHTML = '<span class="kw-tip-name">' + escapeHtml(kw) + "</span>" + escapeHtml(def);
  tip.classList.add("show");
  const r = target.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - tr.width - 10));
  let top = r.top - tr.height - 8;
  if (top < 10) top = r.bottom + 8;
  tip.style.left = Math.round(left) + "px";
  tip.style.top = Math.round(top) + "px";
}

function hideKwTip() {
  if (kwTipEl) kwTipEl.classList.remove("show");
}

document.addEventListener("mouseover", function (e) {
  const t = e.target && e.target.closest ? e.target.closest("[data-kw]") : null;
  if (t) showKwTip(t); else hideKwTip();
});
document.addEventListener("focusin", function (e) {
  const t = e.target && e.target.closest ? e.target.closest("[data-kw]") : null;
  if (t) showKwTip(t); else hideKwTip();
});
document.addEventListener("scroll", hideKwTip, true);
window.addEventListener("resize", hideKwTip);

// ---------- 5. 卡牌库排序方式 ----------

const SORT_OPTIONS = [
  ["default", "默认（可收藏优先）"],
  ["cost-asc", "法力：低到高"],
  ["cost-desc", "法力：高到低"],
  ["attack-asc", "攻击：低到高"],
  ["attack-desc", "攻击：高到低"],
  ["health-asc", "生命：低到高"],
  ["health-desc", "生命：高到低"],
  ["name", "名称"],
  ["new", "最新"],
];

function sortCardList(list, sort) {
  const num = (v, dflt) => (v === undefined || v === null ? dflt : v);
  const byName = (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN");
  const cmp = function (a, b) {
    switch (sort) {
      case "cost-asc": return num(a.cost, 99) - num(b.cost, 99) || byName(a, b);
      case "cost-desc": return num(b.cost, -1) - num(a.cost, -1) || byName(a, b);
      case "attack-asc": return num(a.attack, 99) - num(b.attack, 99) || num(a.cost, 99) - num(b.cost, 99) || byName(a, b);
      case "attack-desc": return num(b.attack, -1) - num(a.attack, -1) || num(a.cost, 99) - num(b.cost, 99) || byName(a, b);
      case "health-asc": return num(a.health, 99) - num(b.health, 99) || num(a.cost, 99) - num(b.cost, 99) || byName(a, b);
      case "health-desc": return num(b.health, -1) - num(a.health, -1) || num(a.cost, 99) - num(b.cost, 99) || byName(a, b);
      case "name": return byName(a, b);
      case "new": return num(b.dbfId, 0) - num(a.dbfId, 0);
      default: {
        const ca = isCollectible(a) ? 0 : 1, cb = isCollectible(b) ? 0 : 1;
        return ca - cb || num(a.cost, 99) - num(b.cost, 99) || byName(a, b);
      }
    }
  };
  list.sort(cmp);
  return list;
}

function buildSortDropdown() {
  const wrap = document.getElementById("sortDropdowns");
  if (!wrap || wrap.dataset.init) return;
  wrap.dataset.init = "1";
  searchState.sort = searchState.sort || "default";
  hsCreateDropdown({
    mount: wrap,
    label: "排序方式",
    options: SORT_OPTIONS,
    value: searchState.sort,
    clearLabel: "恢复默认排序",
    onPick: function (v) {
      searchState.sort = v || "default";
      doCardSearch(1);
    }
  });
}

// ---------- 4. 死亡骑士符文校验 ----------

const RUNE_LIMIT = 3;
const RUNE_KINDS = [["blood", "血"], ["frost", "冰"], ["unholy", "邪"]];

function cardRunes(card) {
  const r = card && card.runeCost;
  if (!r) return null;
  const blood = r.blood | 0, frost = r.frost | 0, unholy = r.unholy | 0;
  if (blood + frost + unholy === 0) return null;
  return { blood: blood, frost: frost, unholy: unholy };
}

// 卡组当前需要的符文数 = 每类符文在卡牌中的最大值（官方规则：上限 3 点）
function deckRuneNeed(extraCard) {
  const need = { blood: 0, frost: 0, unholy: 0 };
  const take = function (c) {
    const r = cardRunes(c);
    if (!r) return;
    need.blood = Math.max(need.blood, r.blood);
    need.frost = Math.max(need.frost, r.frost);
    need.unholy = Math.max(need.unholy, r.unholy);
  };
  deckState.cards.forEach(function (e) { take(e.card); });
  if (extraCard) take(extraCard);
  return { need: need, total: need.blood + need.frost + need.unholy };
}

function runeText(need) {
  const out = [];
  RUNE_KINDS.forEach(function (k) { if (need[k[0]] > 0) out.push(k[1] + need[k[0]]); });
  return out.join(" ") || "无";
}

function runeConflictMessage(card) {
  const res = deckRuneNeed(card);
  if (res.total <= RUNE_LIMIT) return "";
  return "符文冲突：" + card.name + " 会让卡组需要 " + runeText(res.need) +
    "（共 " + res.total + " 点，上限 " + RUNE_LIMIT + " 点）";
}

function renderDeckRunes() {
  const box = document.getElementById("deckRunes");
  if (!box) return;
  const res = deckRuneNeed(null);
  const hasAny = res.total > 0 || (deckState.hero && deckState.hero.cardClass === "DEATHKNIGHT");
  if (!hasAny) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }
  box.style.display = "flex";
  let html = "";
  RUNE_KINDS.forEach(function (k) {
    const key = k[0], cn = k[1], n = res.need[key];
    html += '<span class="rune-pill rune-' + key + (n ? "" : " rune-zero") + '" title="' + cn + "符文需求：" + n + '">' +
      cn + " " + n + "</span>";
  });
  html += '<span class="deck-rune-total' + (res.total > RUNE_LIMIT ? " over" : "") + '">' +
    res.total + " / " + RUNE_LIMIT + "</span>";
  box.innerHTML = html;
}

// 导入/解码得到卡组后统一复查一次（只提示，不删卡：用户可能想自己改）
function warnDeckRunes() {
  const res = deckRuneNeed(null);
  if (res.total > RUNE_LIMIT) {
    toast("符文超限：" + runeText(res.need) + "（共 " + res.total + " 点，上限 " + RUNE_LIMIT + " 点）");
  }
}

// ---------- 3. 卡组长图 ----------

function posterEntries() {
  const list = [];
  deckState.cards.forEach(function (e) { list.push({ card: e.card, count: e.count }); });
  list.sort(function (a, b) {
    const ca = deckDisplayCost(a.card), cb = deckDisplayCost(b.card);
    if (ca !== cb) return ca - cb;
    return a.card.name.localeCompare(b.card.name, "zh-Hans-CN");
  });
  return list;
}

function loadPix(url) {
  return new Promise(function (resolve) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    // 图床慢/不通时不能把长图卡死：8 秒没回来就当作无图（该卡面走文字兜底）
    const timer = setTimeout(function () { resolve(null); }, 8000);
    img.onload = function () { clearTimeout(timer); resolve(img); };
    img.onerror = function () { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
}

// 批量取图：限制并发（4 路）。30 张卡一次性并发打 30 个 /api/card-img，
// 冷启动时容易撞上边缘的并发/超时，表现就是「图全没了」。失败重试一次。
async function loadPixBatch(urls, conc) {
  const out = new Array(urls.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      let img = await loadPix(urls[i]);
      if (!img && urls[i].indexOf("/api/card-img") === 0) {
        await new Promise(function (r) { setTimeout(r, 250); });
        img = await loadPix(urls[i]);
      }
      out[i] = img;
    }
  }
  const lanes = Math.min(conc || 4, urls.length);
  const pool = [];
  for (let k = 0; k < lanes; k++) pool.push(worker());
  await Promise.all(pool);
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth) {
  const chars = String(text || "").split("");
  const lines = [];
  let line = "";
  for (const ch of chars) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// 生成卡组长图，返回 PNG Blob
async function renderDeckPosterBlob(entries) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = 780;
  const PAD = 34;
  const COLS = 4;
  const CW = 156, CH = 227, GX = (W - PAD * 2 - COLS * CW) / (COLS - 1), GY = 18;
  const rows = Math.ceil(entries.length / COLS);
  const HEAD = 150, CURVE = 104, FOOT = 158;
  const H = PAD * 2 + HEAD + CURVE + rows * (CH + 26 + GY) + FOOT;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  // 背景：深色渐变 + 顶部金色光晕
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#1b1520");
  bg.addColorStop(0.5, "#171218");
  bg.addColorStop(1, "#120e14");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.5, 0, 0, W * 0.5, 0, W * 0.9);
  glow.addColorStop(0, "rgba(197,148,61,0.22)");
  glow.addColorStop(1, "rgba(197,148,61,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, HEAD + 60);

  // 标题
  const heroName = deckState.hero ? (deckState.hero.name || "") : "未选择英雄";
  const heroClass = deckState.hero ? (DB.maps.class[deckState.hero.cardClass] || "") : "";
  const fmtText = deckState.format === 1 ? "狂野" : "标准";
  const total = entries.reduce(function (a, e) { return a + e.count; }, 0);

  ctx.fillStyle = "#f4e9d6";
  ctx.font = "700 30px 'Segoe UI', 'Microsoft YaHei', sans-serif";
  const deckName = deckState.deckName || "HsTool 卡组";
  ctx.fillText(deckName, PAD, PAD + 34);

  ctx.font = "15px 'Segoe UI', 'Microsoft YaHei', sans-serif";
  ctx.fillStyle = "#c2ae90";
  const runeRes = deckRuneNeed(null);
  const sub = [heroClass ? heroName + " · " + heroClass : heroName, fmtText, total + " 张"]
    .concat(runeRes.total > 0 ? ["符文 " + runeText(runeRes.need)] : [])
    .join("   ·   ");
  ctx.fillText(sub, PAD, PAD + 64);

  // 粉尘
  let dust = 0, goldDust = 0;
  deckState.cards.forEach(function (e) {
    dust += (DUST_COST[e.card.rarity] || 0) * e.count;
    goldDust += (DUST_COST_GOLD[e.card.rarity] || 0) * e.count;
  });
  ctx.fillStyle = "#c5943d";
  ctx.font = "600 15px 'Segoe UI', 'Microsoft YaHei', sans-serif";
  ctx.fillText("奥术之尘 " + dust.toLocaleString() + " / 金 " + goldDust.toLocaleString(), PAD, PAD + 92);

  // 品牌角标
  ctx.textAlign = "right";
  ctx.fillStyle = "#8d7c66";
  ctx.font = "600 14px 'Segoe UI', 'Microsoft YaHei', sans-serif";
  ctx.fillText("HsTool · hstool.pages.dev", W - PAD, PAD + 30);
  ctx.textAlign = "left";

  // 法力曲线
  const buckets = new Array(8).fill(0);
  deckState.cards.forEach(function (e) {
    const idx = Math.min(7, Math.floor(deckDisplayCost(e.card)));
    buckets[idx] += e.count;
  });
  const maxB = Math.max.apply(null, buckets) || 1;
  const curveTop = PAD + HEAD;
  const barW = (W - PAD * 2) / 8 - 14;
  ctx.strokeStyle = "rgba(197,148,61,0.28)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, curveTop + 66);
  ctx.lineTo(W - PAD, curveTop + 66);
  ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const x = PAD + i * ((W - PAD * 2) / 8);
    const h = buckets[i] ? Math.max(6, Math.round((buckets[i] / maxB) * 54)) : 0;
    if (h) {
      const g = ctx.createLinearGradient(0, curveTop + 66 - h, 0, curveTop + 66);
      g.addColorStop(0, "#e8c277");
      g.addColorStop(1, "rgba(197,148,61,0.35)");
      ctx.fillStyle = g;
      roundRect(ctx, x + 6, curveTop + 66 - h, barW, h, 3);
      ctx.fill();
    }
    ctx.fillStyle = "#8d7c66";
    ctx.font = "11px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(i === 7 ? "7+" : String(i), x + 6 + barW / 2, curveTop + 80);
    if (buckets[i]) {
      ctx.fillStyle = "#d9c08a";
      ctx.fillText(String(buckets[i]), x + 6 + barW / 2, curveTop + 66 - h - 5);
    }
    ctx.textAlign = "left";
  }

  // 卡牌网格
  const gridTop = PAD + HEAD + CURVE;
  const urls = entries.map(function (e) { return posterImgUrl(e.card); });
  const pix = await loadPixBatch(urls, 6);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const col = i % COLS, row = Math.floor(i / COLS);
    const x = PAD + col * (CW + GX);
    const y = gridTop + row * (CH + 26 + GY);

    // 卡位底
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    roundRect(ctx, x, y, CW, CH, 10);
    ctx.fill();

    const img = pix[i];
    ctx.save();
    roundRect(ctx, x, y, CW, CH, 10);
    ctx.clip();
    if (img) {
      ctx.drawImage(img, x, y, CW, CH);
    } else {
      // 图床不可用时的兜底卡面：名称 + 费用
      ctx.fillStyle = "#2a2130";
      ctx.fillRect(x, y, CW, CH);
      ctx.fillStyle = "#e6d8bf";
      ctx.font = "600 14px 'Segoe UI', 'Microsoft YaHei', sans-serif";
      const lines = wrapText(ctx, e.card.name, CW - 20).slice(0, 4);
      lines.forEach(function (ln, k) { ctx.fillText(ln, x + 10, y + 34 + k * 20); });
    }
    ctx.restore();

    // 费用角标
    const cost = deckDisplayCost(e.card);
    ctx.beginPath();
    ctx.arc(x + 17, y + 17, 13, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(12,9,14,0.82)";
    ctx.fill();
    ctx.strokeStyle = "rgba(232,194,119,0.85)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#f0dfb8";
    ctx.font = "700 14px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(cost == null ? "-" : cost), x + 17, y + 22);
    ctx.textAlign = "left";

    // 份数角标
    if (e.count > 1) {
      const label = "×" + e.count;
      ctx.font = "700 13px 'Segoe UI', sans-serif";
      const tw = ctx.measureText(label).width + 14;
      ctx.fillStyle = "rgba(12,9,14,0.82)";
      roundRect(ctx, x + CW - tw - 6, y + CH - 24, tw, 18, 9);
      ctx.fill();
      ctx.fillStyle = "#e8c277";
      ctx.textAlign = "center";
      ctx.fillText(label, x + CW - tw / 2 - 6, y + CH - 11);
      ctx.textAlign = "left";
    }

    // 名称
    ctx.fillStyle = "#cdb894";
    ctx.font = "12.5px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.textAlign = "center";
    const nameLines = wrapText(ctx, e.card.name, CW);
    ctx.fillText(nameLines[0] || "", x + CW / 2, y + CH + 16);
    ctx.textAlign = "left";
  }

  // 页脚：卡组码 + 署名
  let fy = gridTop + rows * (CH + 26 + GY) + 18;
  ctx.strokeStyle = "rgba(197,148,61,0.3)";
  ctx.beginPath();
  ctx.moveTo(PAD, fy);
  ctx.lineTo(W - PAD, fy);
  ctx.stroke();
  fy += 22;

  let code = "";
  try {
    code = encodeDeckstring(
      deckState.hero ? [deckState.hero.dbfId] : [],
      Array.from(deckState.cards.values()).map(function (e) { return [e.card.dbfId, e.count]; }),
      deckState.format,
      undefined,
      deckState.bands.size ? Array.from(deckState.bands.entries()).map(function (kv) {
        return [Number(kv[0]), kv[1].size];
      }) : null
    );
  } catch (err) {
    code = "";
  }

  ctx.fillStyle = "#7f6f5c";
  ctx.font = "11.5px Consolas, 'Courier New', monospace";
  if (code) {
    const codeLines = wrapText(ctx, code, W - PAD * 2).slice(0, 5);
    codeLines.forEach(function (ln, k) { ctx.fillText(ln, PAD, fy + k * 17); });
    fy += codeLines.length * 17 + 8;
  }
  ctx.fillStyle = "#5f5347";
  ctx.font = "11px 'Segoe UI', 'Microsoft YaHei', sans-serif";
  ctx.fillText("由 HsTool 生成 · 卡牌数据来自 HearthstoneJSON · 鼠标右键另存 / 手机长按保存", PAD, fy + 12);

  return new Promise(function (resolve, reject) {
    try {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error("画布导出为空"));
      }, "image/png");
    } catch (err) {
      reject(err);
    }
  });
}

async function exportDeckPoster() {
  const entries = posterEntries();
  if (!entries.length) {
    toast("卡组是空的，先加几张卡");
    return;
  }
  toast("正在生成长图…");
  try {
    const blob = await renderDeckPosterBlob(entries);
    const safe = String(deckState.deckName || "HsTool卡组").replace(/[\\/:*?"<>|]/g, "_");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = safe + ".png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    toast("长图已生成：" + safe + ".png");
  } catch (err) {
    toast("长图生成失败：" + (err && err.message ? err.message : "未知错误"));
  }
}

// 初始化：排序下拉（组卡器页首次进入时挂载）
(function () {
  const tryInit = function () { buildSortDropdown(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tryInit);
  else tryInit();
})();
