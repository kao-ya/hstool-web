# HsTool

炉石传说的**纯前端**卡牌工具箱：卡牌检索、卡组编辑器、卡组代码（deckstring）编解码。整站是一个静态站点，没有后端、没有登录、不需要构建，卡牌数据以 JSON 形式随站点一起发布。

在线地址：<https://hstool.pages.dev>

---

## 1. 目录结构

```
index.html                     单页入口（三个页面：组卡器 / 解码 / 编码）
css/style.css                  全部样式
js/app.js                      全部逻辑（单文件，无模块化，函数都是全局的）
data/hearthstone_cards_zhCN.json   全量卡牌数据，36,390 条，约 11 MB
data/cards-meta.json               分组元数据（职业/系列/稀有度… 的中文名与排序）
data/cards-signatures.json         异画（签名版）卡图索引，460 条
img/  fonts/                   背景、图标、字体
```

部署方式与本文件无关：把上述目录原样放到任意静态服务器上即可。

---

## 2. 页面能做什么

| 页面 | 能力 |
| --- | --- |
| 组卡器 | 卡组编辑、7 维筛选、9 种排序、导入导出、符文校验、法力曲线、尘量统计、卡组长图 |
| 解码 | 把卡组代码或官方格式文本解析成卡表，可一键跳到组卡器继续编辑 |
| 编码 | 用「英雄 + 卡牌列表」生成卡组代码，支持标准/狂野、乐队（sideboard） |

---

## 3. 在代码里直接调用（推荐方式一：同页面控制台）

`js/app.js` 是普通脚本，**所有函数都挂在全局作用域**，页面加载完成后即可直接调用。

打开站点 → F12 → Console，粘贴：

```js
// 1) 卡组代码 → 结构
const deck = decodeDeckstring("AAEBAaCKBAGWBQG7AgAA");
console.log(deck);

// 2) 结构 → 卡组代码
const code = encodeDeckstring([66848], [[662, 1], [315, 2]], 1);
console.log(code);   // "AAEBAaCKBAGWBQG7AgAA"

// 3) 卡组代码 → 中文清单（可直接展示给用户）
console.log(formatDecoded(deck));
```

实测输出：

```js
decodeDeckstring("AAEBAaCKBAGWBQG7AgAA")
// {
//   version: 1,
//   format: 1,
//   hero_dbf: [66848],
//   cards: [[662, 1], [315, 2]],
//   sideboard: []
// }

formatDecoded(...)
// 版本     : 1
// 模式     : 狂野
// 英雄     : 魔导师晨拥(DBF 66848)
// 卡牌总数 : 3
//
// 卡牌列表：
//   · 寒冰箭(DBF 662) × 1
//   · 火球术(DBF 315) × 2
```

### 常用函数一览

| 函数 | 签名 | 说明 |
| --- | --- | --- |
| `decodeDeckstring(code)` | `(string) => {version, format, hero_dbf, cards, sideboard}` | 卡组代码 → 结构。校验失败会抛 `Error`，`message` 是中文原因 |
| `encodeDeckstring(heroes, cards, fmt, version, sideboard)` | `(number[], [dbf,count][], 1\|2, 1, sideboard?) => string` | 结构 → 卡组代码。`fmt`：1 狂野 / 2 标准 |
| `formatDecoded(deck)` | `(deck) => string` | 结构 → 可读清单 |
| `formatOfficialDeck(deck)` | `(deck) => string` | 结构 → 官方「# 2x (4) 火球术」文本 |
| `parseDeckText(text)` | `(string) => {hero, format, cards}` | 官方文本或卡名列表 → 结构（导入用） |
| `searchCards(q, filters, offset, limit, sort)` | 见下 | 本地检索，返回 `{cards, total, offset, shown}` |
| `cardImgUrl(card, size)` | `(card\|dbfId, "256x"\|"512x"\|"orig") => string` | 卡面渲染图 URL |
| `heroIllustrationUrl(cardId)` | `(string) => string` | 英雄/随从方形插画 URL |
| `cardRunes(card)` | `(card) => {blood,frost,unholy}` | 死亡骑士符文消耗 |
| `renderCardTextHtml(text)` | `(string) => string` | 卡牌描述 → 带关键词标记的 HTML（已转义，可安全插入） |

检索示例：

```js
const r = searchCards("火", {}, 0, 3, "default");
// { total: 1315, cards: [炽热连击, 怒火中烧, 突破邪火], offset: 0, shown: 3 }

// 筛选：法师的随从，按费用从高到低
searchCards("", { cardClass: ["MAGE"], type: ["MINION"] }, 0, 20, "cost-desc");

// 只查可收藏
searchCards("", { collectible: ["yes"] }, 0, 20, "default");
```

`filters` 支持的维度：`cardClass` `type` `rarity` `race` `spellSchool` `set` `cost`（`0`…`9`、`10plus`） `collectible`（`yes`/`no`），值统一传数组。

`sort` 取值：`default` `cost-asc` `cost-desc` `attack-asc` `attack-desc` `health-asc` `health-desc` `name` `new`。

### 卡牌对象长什么样

`searchCards` / `DB.cards` 返回的是原始卡牌记录（58 个字段，字段含义同 [hearthstonejson](https://hearthstonejson.com/)），常用字段：

```json
{
  "dbfId": 315, "id": "CS2_029", "name": "火球术",
  "cardClass": "MAGE", "type": "SPELL", "rarity": "FREE", "set": "CORE",
  "cost": 4, "text": "造成 <b>6</b> 点伤害。",
  "spellSchool": "FIRE", "mechanics": ["AFFECTED_BY_SPELL_POWER"],
  "collectible": true, "artist": "Ralph Horsley"
}
```

访问索引：

```js
DB.byId.get("CS2_029")     // 按 cardId
DB.byDbf.get(315)          // 按 dbfId
DB.cards                   // Map<cardId, card>
DB.cards.size              // 36390
```

---

## 4. 集成方式二：`iframe` 嵌入

页面没有 URL 参数，默认停在「组卡器」；需要别的页面就让用户点顶部导航。

```html
<iframe src="https://hstool.pages.dev/"
        style="width:100%;height:900px;border:0"
        title="HsTool"></iframe>
```

因为整站是纯静态 + 同源数据，`iframe` 之间没有跨域限制；父页面若要读子页面的 `encodeDeckstring` 等函数，需同源（自己部署一份）。

---

## 5. 集成方式三：只要卡牌数据

```js
const cards = await (await fetch("/data/hearthstone_cards_zhCN.json")).json();
const meta  = await (await fetch("/data/cards-meta.json")).json();
```

- `hearthstone_cards_zhCN.json`：数组，36,390 条，原始字段（含酒馆战棋、佣兵等非对战数据）。
- `cards-meta.json`：`{counts:{total}, sets:[{key,name,groups[]}], maps:{cardClass,rarity,type,set,race,spellSchool}}`，中文字名与排序都在 `maps` 里。
- 想只取对战可收藏卡：`cards.filter(c => c.collectible)` → 8,015 条。

数据更新：仓库内 `.github/workflows/` 有定时任务，会从 `api.hearthstonejson.com/v1/latest` 重新拉取并提交（目前约每 10 小时）。

---

## 6. 集成方式四：只想照抄 deckstring 编解码

规范（官方 `hearthstone-deckstrings`）不长，照着写大约 80 行：

```
base64 → 字节流，按 varint（7 位一组，最高位为续位）依次读：

0x00            header（固定 0）
1               version
1 | 2           format（1 狂野 / 2 标准）
n               hero 数量，随后 n 个 dbfId
                —— 主卡组：三段，每段「条数 + 若干 dbfId」
A               1 张段条数，随后 A 个 dbfId
B               2 张段条数，随后 B 个 dbfId
C               3 张及以上段条数，随后 C 组「dbfId, 份数」
                —— 乐队（sideboard）：
0 | 1           是否存在
（若存在）与主卡组同构的三段，但每张卡后面额外跟一个「归属卡 dbfId」
```

三个坑：

1. **乐队不是「1 + 条数 + (卡, 归属)」**，而是和主卡组一样的三段（1 张段 / 2 张段 / 3+ 张段）。写成前一种，乐队里两张相同的卡会被游戏读成「两条单卡」。
2. 3 张及以上段才显式写份数，1 张段和 2 张段不写。
3. 没有乐队也必须写一个 `0`。

本仓库实现见 `js/app.js` 中的 `encodeDeckstring` / `decodeDeckstring`（`writeVarint` / `readVarint` 在文件开头，`bytesToB64` / `b64ToBytes` 用 `btoa` / `atob`）。

---

## 7. 图片

| 用途 | 地址 | 注意 |
| --- | --- | --- |
| 卡面渲染图 | `https://art.hearthstonejson.com/v1/render/latest/zhCN/256x/{cardId}.png` | **不返回 `Access-Control-Allow-Origin`**，`<img>` 能显示，但 `canvas` 会污染（`toBlob` 抛 `SecurityError`） |
| 方形插画 | `https://art.hearthstonejson.com/v1/512x/{cardId}.jpg` | 同上；体积小（30 KB 级），适合列表 |
| 异画（签名版） | wiki 的 `{cardId}_Premium3.png` | wiki 有防盗链，直接 `<img>` 可能 403 |

要在 `canvas` 里画卡图/生成长图，必须走同源代理：本站自带两个（见 `functions/api/`，Cloudflare Pages Functions）：

```
GET /api/card-img?u=render%2Flatest%2FzhCN%2F256x%2FCS2_029.png
GET /api/hs-signature?card=BE_013&w=512
```

前者加了 `Access-Control-Allow-Origin: *` 与一年 immutable 缓存；后者按 wiki 的四种文件名依次回退。自己部署时若不用 Cloudflare，需要另写一个同样形状的代理。

---

## 8. 常见问题

**双击 `index.html` 打不开/卡在加载？** 必须走 HTTP。浏览器在 `file://` 下会禁止 `fetch` 本地 JSON。

**本地起服务：**

```bash
python -m http.server 8080      # 或 npx serve
# 打开 http://127.0.0.1:8080/
```

**中文目录名会不会出问题？** 不会，站点自身不做路径拼接，只按相对路径取 `data/`。

**卡牌数据里为什么有酒馆战棋/佣兵的卡？** 上游是原始全量数据；界面里通过 `collectible` 过滤，默认只显示可收藏卡。

**关键词提示的文案哪来的？** 游戏内官方文案（`HearthSim/hsdata` 的 `Strings/zhCN/GLOBAL.txt`），共 200 余条，见 `js/app.js` 的 `KEYWORD_DEFS`。

**卡组上限（20/30/40 张）怎么算的？** `DECK_SIZE_RULES` 表：裂魂者阿扎莉娜 20、雷纳索尔王子与时空大盗拉法姆 40，多张冲突时取最严格的。

---

## 9. 许可与来源

- 代码：见 `LICENSE`。
- 卡牌数据：[hearthstonejson](https://hearthstonejson.com/)，暴雪娱乐版权所有，本项目仅作展示。
- 关键词文案：[HearthSim/hsdata](https://github.com/HearthSim/hsdata)（游戏内文本）。
- deckstring 规范：[HearthSim/python-hearthstone-deckstrings](https://github.com/HearthSim/python-hearthstone-deckstrings)。
