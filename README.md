# HsTool

**炉石传说卡组构筑与解析工具** —— 纯前端静态站，零后端、零构建、部署即用。

![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)
![No Build](https://img.shields.io/badge/build-none-brightgreen)
![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-F38020?logo=cloudflare&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

把完整卡牌数据库交给浏览器，所有查询、编解码、渲染都在本地完成 —— 没有服务器，没有接口，没有等待。

> 在线体验：`https://<你的项目>.pages.dev`（部署后替换此处）

---

## 目录

- [特性](#-特性)
- [快速开始](#-快速开始本地预览)
- [部署](#-部署cloudflare-pages)
- [项目结构](#-项目结构)
- [数据文件](#-数据文件)
- [更新卡库](#-更新卡库)
- [技术栈与兼容性](#-技术栈与兼容性)
- [性能](#-性能)
- [常见问题](#-常见问题)
- [已知限制](#-已知限制)
- [致谢与声明](#-致谢与声明)

---

## ✨ 特性

### 🎴 组卡器

- 构筑规则校验：传说 1 张、其余 2 张、卡组上限 30 张
- **实时粉尘统计**：按稀有度自动换算合成所需奥术之尘
- **法力曲线**：随组卡实时更新
- 卡组列表支持行内移除、份数增减、拖拽加入
- **导出到解码页**：一键生成可分享的卡组代码

### 🔁 卡组编解码

- **解码**：粘贴官方短码，解析出完整卡组与英雄
- **编码**：卡组一键生成官方短码
- 完整实现官方 **deckstring** 格式：Base64 → varint，涵盖版本、格式、英雄列表、单张 / 双张、多张块与副卡组
- 编码时按 `dbfId` 升序排序，保证同一卡组生成**稳定一致的短码**
- 同时支持「官方格式文本」导入（自动识别并降级解析）

### 🔍 卡牌搜索与筛选

- **8 个筛选维度**：职业、类型、稀有度、随从种族、法术派系、系列、费用、收藏状态
- 同维度多选取并集，跨维度取交集
- **标签式筛选**：已选项以标签展示，可单点移除、可一键清空
- 支持按**卡牌名称、描述文本、卡牌 ID、dbfId 前缀**搜索
- 可收藏判定：先按类型门（仅随从 / 法术 / 英雄 / 武器 / 地标可收藏），再按系列（经典排除、核心放行），最后回落数据源字段
- 分页 200 张/页，36,022 张共 181 页

### 🃏 特殊卡牌支持

- **奇闻卡附属卡**：按 ID 前缀自动挂载附属卡牌，并在详情页展示归属关系
- **乐队 / 定制模式**：支持布洛克斯加、血色战队、奇利亚斯等带归属卡的门槛校验
- **英雄选择器**：11 个基础职业英雄
- **衍生 token 联动清理**：移除主卡时自动清理关联附属卡，不留孤儿卡

### 🖼️ 卡图加载

- **IntersectionObserver 懒加载**：首屏仅加载可见的约 30 张
- **按类型直连占位图**：附魔 / 按钮 / 拖动三类内部对象全库无卡图，直接使用本地占位卡背，**零网络探测**
- **双源回退**：中文卡图缺失自动切英文，仍失败则用本地占位图
- 未加载时预留卡面比例，避免布局抖动

### 🎨 界面与设置

- **Material Design 3** 设计规范对齐
- **12 项设置**，面板分「设置 / 关于」两页，「设置」页内按 *功能 / 布局 / 控件* 分三组：

  | 分组 | 设置项 |
  | --- | --- |
  | 功能 | 悬停预览、水晶颜色 |
  | 布局 | MD3 风格、紧凑布局、减弱动效、背景纯色、背景可见度（0–100 滑块） |
  | 控件 | 卡牌面板透明、搜索栏透明、预览图背景透明、卡牌背景透明、去边框去线条 |

  命名约定：凡带「透明」的开关，一律 **ON = 该元素透出背景**，且**默认全部关闭**。
- 设置持久化于 `localStorage`（键名 `hstool-settings`）
- 响应式布局，适配窄屏
- 全局悬浮卡图预览（可在设置中关闭）

---

## 🚀 快速开始（本地预览）

浏览器出于安全策略禁止 `file://` 下 `fetch` 本地 JSON，**必须通过 HTTP 访问**：

```bash
# 任选其一，在项目根目录执行
python -m http.server 8000      # Windows / macOS / Linux（python3 亦可）
npx serve .                     # 需要 Node.js
php -S localhost:8000           # 需要 PHP
```

打开 `http://localhost:8000` 即可。

> 直接双击 `index.html` 会白屏并提示加载失败，这不是 bug，是 CORS 限制。

---

## ☁️ 部署（Cloudflare Pages）

### 方式一：连接 Git 仓库（推荐，push 即自动部署）

1. 把本项目推送到 GitHub / GitLab 仓库
2. Cloudflare 控制台 → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
3. 选择仓库，按下表填写构建配置：

| 配置项 | 填写内容 |
| --- | --- |
| Production branch | `main` |
| Framework preset | `None` |
| **Build command** | **留空** |
| **Build output directory** | `/` |
| Root directory | 留空 |

4. 保存并部署，约 30 秒 ~ 2 分钟后拿到 `https://<项目名>.pages.dev`

之后每次推送到 `main` 都会自动重建。历史版本可在 **Deployments** 里一键 **Rollback**。

### 方式二：拖拽上传（最快，无需仓库）

1. **Workers & Pages** → **Create application** → **Pages** → **Upload assets**
2. 把本项目**所有文件和文件夹**（或打包后的 zip）一起拖进去
3. **Deploy site**

> ⚠️ 必须保证 `index.html` 在**根目录**，否则站点 404。压缩时请进入文件夹内全选再压，不要连文件夹一起压。

### 手动触发重建（可选）

若代码通过 API 提交、CI 未收到 push 事件，可在项目 **Settings → Builds & deployments → Deploy hooks** 建一条 hook，之后 `GET` 该 URL 即可触发构建。

---

## 📁 项目结构

```
.
├── index.html                          # 页面外壳（结构）
├── css/
│   └── style.css                       # 全部样式（MD3 设计变量 + 主题开关）
├── js/
│   └── app.js                          # 全部逻辑（数据层 / 搜索 / 组卡 / 编解码 / 设置）
├── img/
│   ├── Background.jpg                  # 背景图
│   ├── manacrystal.png                 # 法力水晶贴图
│   ├── nocard.png                      # 无卡图时的占位卡背
│   └── wawa.png                        # 「关于」页项目图标
├── fonts/
│   └── Belwe.ttf                       # 卡牌显示字体
└── data/
    ├── hearthstone_cards_zhCN.json     # 完整卡库（36,022 张，10.9 MB）
    └── cards-meta.json                 # 元数据（6 KB）
```

无 `package.json`、无 `node_modules`、无打包产物 —— 这就是全部。

---

## 📡 数据文件

采用**双文件**方案，职责分离：

| 文件 | 回答的问题 | 内容 |
| --- | --- | --- |
| `hearthstone_cards_zhCN.json` | 这张卡**是什么** | 卡牌原始数据数组，36,022 条 |
| `cards-meta.json` | 怎么用人话**讲出来** | 枚举中文映射、58 个系列分组、图床前缀 |

`cards-meta.json` 结构：

```jsonc
{
  "version": 2,
  "source": "official-json",
  "counts": { "total": 36022 },
  "sets": [ { "group": "基础与经典", "items": [["BASIC", "基础"], ...] }, ... ],  // 5 组 / 58 系列
  "maps": {                                                                       // 143 条翻译
    "class": 13, "rarity": 5, "type": 20, "set": 69, "race": 27, "spellSchool": 9
  },
  "imageBase": { "256": ".../256x/", "512": ".../512x/", "orig": ".../orig/" }
}
```

系列分组：基础与经典 7、冒险模式 4、正式系列 36、活动 / 特殊 8、游戏模式 3 = **58 个系列**。

> 💡 出新系列时**只需改 `cards-meta.json`**，不用动一行代码。

---

## 🔄 更新卡库

卡牌数据来自 [HearthstoneJSON](https://hearthstonejson.com/)，官方构建地址：

```
https://api.hearthstonejson.com/v1/latest/zhCN/cards.collectible.json   # 仅可收藏
https://api.hearthstonejson.com/v1/latest/zhCN/cards.json              # 全量（本项目用这个）
```

更新步骤：

1. 下载全量 JSON，覆盖 `data/hearthstone_cards_zhCN.json`
2. 如出现新系列，在 `data/cards-meta.json` 的 `sets` 里补上 `[代码, 中文名]`，`maps.set` 里补翻译
3. 更新 `counts.total`
4. 浏览器强刷（Ctrl+F5）验证张数与新卡

---

## 🧱 技术栈与兼容性

| 层面 | 方案 |
| --- | --- |
| 结构 / 样式 / 逻辑 | 原生 HTML + CSS + JavaScript，**无框架、无构建步骤** |
| 数据层 | `fetch` 静态 JSON，内存建 `Map` 索引 |
| 卡图 | [HearthstoneJSON](https://hearthstonejson.com/) 官方图床 |
| 字体 | Belwe |
| 托管 | Cloudflare Pages（全球 CDN） |

**浏览器要求**：支持 ES2017 的现代浏览器 —— Chrome / Edge ≥ 80、Firefox ≥ 78、Safari ≥ 14。
代码刻意不使用 `??`、`?.`、`Object.hasOwn`、`replaceAll` 等新语法，以兼容较老的 WebView 与 WebView 内核浏览器。

**不支持**：IE 11 及任何不支持 `IntersectionObserver` 的内核。

---

## ⚡ 性能

| 指标 | 实测 |
| --- | --- |
| 卡库体积 | 10.9 MB（Brotli 后约 1.2–1.8 MB） |
| 首次加载 | 2–3 秒（视网络） |
| 二次加载 | 走 HTTP 缓存，< 1 秒 |
| 搜索 36,022 张 | 单页 200 条，内存过滤，无网络请求 |
| 首屏卡图 | 仅加载视口内约 30 张 |

---

## ❓ 常见问题

**为什么不用后端？**

卡库只读且体积可控，交给浏览器本地索引后所有查询都是内存操作，延迟趋近于 0，同时省去服务器与运维成本。

**为什么卡图加载看起来慢？**

卡图来自外部图床，单张约 138 KB，浏览器同域并发上限 6。已通过懒加载把首屏控制在 2–3 秒。

**首次加载为什么要等？**

需下载 10.9 MB 卡库，Cloudflare Pages 默认开启 Brotli，实际传输约 1.2–1.8 MB，之后走缓存。

**为什么搜不到某张卡？**

本项目使用官方全量原始数据（含战棋 / 佣兵 / 附魔 / 英雄皮肤与全部衍生 token），正常不会漏卡。请先确认 `data/hearthstone_cards_zhCN.json` 已正确放置且未被篡改。

**卡组代码解不出来？**

先确认短码完整。若粘贴的是中文笔记或含多余字符，工具会自动降级尝试「官方格式文本」解析；仍失败会给出具体原因。

---

## ⚠️ 已知限制

- 卡库体积决定了首屏无法做到「秒开」，这是纯静态方案的固有代价
- 卡图依赖第三方图床，图床不可达时只能显示占位卡背
- 英雄选择器只提供 11 个基础职业英雄，不含皮肤
- 设置存于 `localStorage`，换浏览器 / 清缓存后需重设
- 无 PWA / 离线模式（未注册 Service Worker）

---

## 🙏 致谢与声明

- [HearthstoneJSON](https://hearthstonejson.com/) —— 卡牌数据与卡图图床
- [Cloudflare Pages](https://pages.cloudflare.com/) —— 静态托管
- [Blizzard Entertainment](https://www.blizzard.com/) —— 炉石传说

本项目为**非官方**粉丝作品，与 Blizzard Entertainment 无任何关联。仅供学习与交流，不得用于商业用途。炉石传说及其相关素材版权归 Blizzard Entertainment 所有。

代码部分以 MIT 许可发布。
