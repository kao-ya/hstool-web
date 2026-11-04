// 服务端卡库索引：把「筛选 + 排序 + 切页 + 详情」全部搬到边缘
// 纯函数集合，不依赖 CDN 运行时，方便本地 node 直接跑同一套逻辑做对照。
// 语义严格对齐前端 js/app.js 的 searchCards / sortCardList / cardDetail。

export function createDb(lite, meta) {
  const F = lite.fields;
  const rows = lite.rows;
  const idx = {};
  F.forEach((name, i) => { idx[name] = i; });

  const cards = rows.map((r) => ({
    dbfId: r[idx.dbfId],
    id: r[idx.id],
    name: r[idx.name],
    cost: r[idx.cost],
    attack: r[idx.attack],
    health: r[idx.health],
    durability: r[idx.durability],
    armor: r[idx.armor],
    cardClass: r[idx.cardClass],
    type: r[idx.type],
    rarity: r[idx.rarity],
    set: r[idx.set],
    races: r[idx.races],
    spellSchool: r[idx.spellSchool],
    text: r[idx.text],
    mechanics: r[idx.mechanics],
    collectible: r[idx.collectible] === 1,
    elite: r[idx.elite] === 1,
    runeCost: r[idx.runeCost],
    artist: r[idx.artist],
    flavor: r[idx.flavor],
    nameRank: r[idx.nameRank],
    attached: r[idx.attached],
  }));

  const byDbf = new Map();
  const byId = new Map();
  const byNameMap = new Map();
  for (const c of cards) {
    byDbf.set(c.dbfId, c);
    if (c.id) byId.set(c.id, c);
    if (c.name && !byNameMap.has(c.name)) byNameMap.set(c.name, c);
  }

  const asValueSet = (v) => {
    if (v === undefined || v === null) return new Set();
    if (Array.isArray(v)) return new Set(v.filter((x) => x !== undefined && x !== null && String(x) !== "").map(String));
    if (String(v) === "") return new Set();
    return new Set([String(v)]);
  };

  const num = (v, d) => (v === undefined || v === null ? d : v);
  const byNameRank = (a, b) => a.nameRank - b.nameRank;

  function cmpFor(sort) {
    switch (sort) {
      case "cost-asc": return (a, b) => num(a.cost, 99) - num(b.cost, 99) || byNameRank(a, b);
      case "cost-desc": return (a, b) => num(b.cost, -1) - num(a.cost, -1) || byNameRank(a, b);
      case "attack-asc": return (a, b) => num(a.attack, 99) - num(b.attack, 99) || num(a.cost, 99) - num(b.cost, 99) || byNameRank(a, b);
      case "attack-desc": return (a, b) => num(b.attack, -1) - num(a.attack, -1) || num(a.cost, 99) - num(b.cost, 99) || byNameRank(a, b);
      case "health-asc": return (a, b) => num(a.health, 99) - num(b.health, 99) || num(a.cost, 99) - num(b.cost, 99) || byNameRank(a, b);
      case "health-desc": return (a, b) => num(b.health, -1) - num(a.health, -1) || num(a.cost, 99) - num(b.cost, 99) || byNameRank(a, b);
      case "name": return byNameRank;
      case "name-desc": return (a, b) => byNameRank(b, a);
      case "new": return (a, b) => num(b.dbfId, 0) - num(a.dbfId, 0);
      default: return (a, b) => {
        const ca = a.collectible ? 0 : 1, cb = b.collectible ? 0 : 1;
        return ca - cb || num(a.cost, 99) - num(b.cost, 99) || byNameRank(a, b);
      };
    }
  }

  function search(query, filters, offset, limit, sort) {
    const t0 = Date.now();
    query = String(query || "").trim().toLowerCase();
    const queryIsDbf = /^\d+$/.test(query);
    filters = filters || {};
    offset = Math.max(0, parseInt(offset || 0, 10) || 0);
    limit = Math.min(200, Math.max(1, parseInt(limit || 200, 10) || 200));

    const fCol = asValueSet(filters.collectible);
    const fClass = asValueSet(filters.cardClass);
    const fType = asValueSet(filters.type);
    const fRarity = asValueSet(filters.rarity);
    const fSet = asValueSet(filters.set);
    const fCost = asValueSet(filters.cost);
    const fRace = asValueSet(filters.race);
    const fSchool = asValueSet(filters.spellSchool);
    const hasCost = fCost.size > 0 || (filters.cost !== undefined && filters.cost !== null && String(filters.cost) !== "");
    const wantCol = fCol.has("yes"), wantNo = fCol.has("no");
    const costNums = new Set();
    let cost10 = false;
    for (const c of fCost) { if (c === "10plus") cost10 = true; else costNums.add(parseInt(c, 10)); }

    const hit = [];
    for (const card of cards) {
      if (query) {
        const inName = card.name.toLowerCase().includes(query);
        if (!inName) {
          const inText = (card.text || "").toLowerCase().includes(query);
          const inId = (card.id || "").toLowerCase().includes(query);
          if (!inText && !inId && !(queryIsDbf && String(card.dbfId).startsWith(query))) continue;
        }
      }
      if (wantCol && !wantNo && !card.collectible) continue;
      if (wantNo && !wantCol && card.collectible) continue;
      if (fClass.size && !fClass.has(card.cardClass || "")) continue;
      if (fType.size && !fType.has(card.type || "")) continue;
      if (fRarity.size && !fRarity.has(card.rarity || "")) continue;
      if (fSet.size && !fSet.has(card.set || "")) continue;
      if (fRace.size && !card.races.some((r) => fRace.has(r))) continue;
      if (fSchool.size && !fSchool.has(card.spellSchool || "")) continue;
      if (hasCost) {
        const cc = card.cost;
        let ok = false;
        if (cost10 && cc !== null && cc >= 10) ok = true;
        if (!ok && cc !== null && costNums.has(cc)) ok = true;
        if (!ok) continue;
      }
      hit.push(card);
    }
    hit.sort(cmpFor(sort || "default"));
    const total = hit.length;
    const page = hit.slice(offset, offset + limit);
    return {
      cards: page,
      total,
      offset,
      limit,
      shown: Math.min(limit, Math.max(0, total - offset)),
      page_ms: Math.round((Date.now() - t0) * 100) / 100,
    };
  }

  const M = meta || {};
  const maps = M.maps || {};
  const imageBase = M.imageBase || {};

  function detail(dbfId) {
    const c = byDbf.get(Number(dbfId));
    if (!c) return null;
    const id = c.id || "";
    return Object.assign({}, c, {
      class_cn: (maps.class || {})[c.cardClass] || c.cardClass || "",
      type_cn: (maps.type || {})[c.type] || c.type || "",
      rarity_cn: (maps.rarity || {})[c.rarity] || c.rarity || "",
      set_cn: (maps.set || {})[c.set] || c.set || "",
      race_cn: (c.races || []).map((r) => (maps.race || {})[r] || r).join(" "),
      spellSchool_cn: (maps.spellSchool || {})[c.spellSchool] || c.spellSchool || "",
      image_256: id && imageBase["256"] ? imageBase["256"] + id + ".png" : "",
      image_512: id && imageBase["512"] ? imageBase["512"] + id + ".png" : "",
      image_orig: id && imageBase["orig"] ? imageBase["orig"] + id + ".png" : "",
      entourage: (c.attached || []),
    });
  }

  return {
    meta: M,
    cards,
    total: cards.length,
    boot(limit) {
      const r = search("", {}, 0, limit || 200, "default");
      return { meta: M, cards: r.cards, total: r.total, page_ms: r.page_ms };
    },
    search,
    detail,
    lookup(mixed) {
      const out = [];
      const seen = new Set();
      for (const raw of mixed || []) {
        if (raw === undefined || raw === null || raw === "") continue;
        const key = String(raw);
        let c = null;
        if (/^\d+$/.test(key)) c = byDbf.get(Number(key));
        if (!c) c = byId.get(key);
        if (!c || seen.has(c.dbfId)) continue;
        seen.add(c.dbfId);
        out.push(c);
      }
      return out;
    },
    // 按卡名批量取（编解码只给了名字时用）
    byName(names) {
      const out = [];
      const seen = new Set();
      for (const raw of names || []) {
        const key = String(raw || "").trim();
        if (!key) continue;
        const c = byNameMap.get(key) || byNameMap.get(key.replace(/\s+/g, ""));
        if (!c || seen.has(c.dbfId)) continue;
        seen.add(c.dbfId);
        out.push(c);
      }
      return out;
    },
    heroes() { return cards.filter((c) => c.type === "HERO"); },
    sets() { return M.sets || {}; },
    status() {
      return {
        ready: true,
        count: cards.length,
        card_count: cards.length,
        collectible_count: cards.filter((c) => c.collectible).length,
        hero_count: cards.filter((c) => c.type === "HERO").length,
        error: null,
        load_seconds: 0,
        remote: true,
      };
    },
  };
}
