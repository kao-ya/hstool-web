# HsTool

**炉石传说卡组构筑与解析工具** —— 纯前端静态站，零后端依赖，部署即用。

![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)
![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-F38020?logo=cloudflare&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

把完整的卡牌数据库交给浏览器，所有查询、编解码、渲染都在本地完成 —— 没有服务器，没有接口，没有等待。

---

## 💡 特性

### 🎴 组卡器

- 遵循构筑规则：传说 1 张、其余 2 张，上限 30 张
- **实时粉尘统计**：按稀有度自动换算合成所需奥术之尘
- **法力曲线**：随组卡实时更新
- 卡组列表支持行内移除、份数增减
- **导出到解码页**：一键生成卡组代码

### 🔁 卡组编解码

- **解码**：粘贴官方短码，解析出完整卡组与英雄
- **编码**：卡组一键生成官方短码，可直接分享
- 完整实现官方 **deckstring** 格式：Base64 → varint 编解码，涵盖版本、格式、英雄列表、单张 / 双张、多张块与副卡组
- 编码时自动按 `dbfId` 升序排序，保证同一卡组生成**稳定一致的短码**

### 🔍 卡牌搜索与筛选

- **8 个筛选维度**：职业、类型、稀有度、随从种族、法术派系、系列、费用、收藏状态
- **同维度多选取并集，跨维度取交集**
- **标签式筛选**：已选项以标签展示，可单点移除、可一键清空
- 支持按**卡牌名称、描述文本、卡牌 ID、dbfId 前缀**搜索
- 可收藏判定：先按类型门（仅随从 / 法术 / 英雄 / 武器 / 地标可收藏），再按系列（经典排除、核心放行），最后回落数据源字段

### 🃏 特殊卡牌支持

- **奇闻卡附属卡**：自动识别奇闻卡并按 ID 前缀挂载附属卡牌
- **乐队 / 定制模式**：支持布洛克斯加、血色战队、奇利亚斯等带归属卡的门槛校验
- **英雄选择器**：11 个基础职业英雄可选
- **衍生 token 联动清理**：移除主卡时自动清理关联的附属卡，避免孤儿卡

### 🖼️ 卡图加载

- **IntersectionObserver 懒加载**：首屏仅加载可见的约 30 张，其余随滚动按需加载
- **按类型直连占位图**：附魔 / 按钮 / 拖动这三类内部对象全库都没有卡图（实测缺图率 90%~100%），直接使用本地占位卡背，**零网络探测**
- **双源回退**：其余卡牌中文卡图缺失时自动切英文，仍失败则用本地占位图
- 未加载时预留卡面比例，避免布局抖动

### 🎨 界面与设置

- **Material Design 3** 设计规范对齐
- **12 项设置**，面板分「设置 / 关于」两页；「设置」页内按 *功能 / 布局 / 控件* 分三组。
  命名约定：凡带「透明」的开关，一律 **ON = 该元素透出背景**，且**默认全部关闭**。
  - *功能*：悬停预览、水晶颜色
  - *布局*：MD3 风格、紧凑布局、减弱动效、背景纯色、背景可见度
  - *控件*：卡牌面板透明、搜索栏透明、预览图背景透明、卡牌背景透明、去边框去线条
- **「关于」页**：项目图标、简介、作者、贡献者与致谢
- 设置持久化于 `localStorage`
- 响应式布局，适配窄屏
- 全局悬浮卡图预览（可在设置中关闭）

---

## 🚀 部署到 Cloudflare Pages

### 方式一：拖拽上传（最快）

1. 进入 Cloudflare 控制台 → **Workers & Pages** → **Create application** → **Pages** → **Upload assets**
2. 把本项目**所有文件和文件夹**一起拖进去
3. 点击 **Deploy site**

> ⚠️ 必须保证 `index.html` 在**根目录**，否则站点会 404。

### 方式二：连接 Git 仓库（推荐，之后 push 即自动部署）

1. 把本项目推送到 GitHub 仓库
2. Cloudflare → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
3. 选择仓库，按下表填写构建配置：

| 配置项 | 填写内容 |
| --- | --- |
| Framework preset | `None` |
| **Build command** | **留空** |
| **Build output directory** | `/` |
| Production branch | `main` |

4. 保存并部署。之后每次 `git push`，Cloudflare 会**自动重新部署**（约 30 秒 ~ 2 分钟）

---

## 📁 项目结构

```
.
├── index.html                          # 页面外壳（结构）
├── css/
│   └── style.css                       # 全部样式
├── js/
│   └── app.js                          # 全部逻辑（含纯前端数据层）
├── img/
│   ├── Background.jpg                  # 背景图
│   ├── manacrystal.png                 # 法力水晶贴图
│   ├── nocard.png                      # 无卡图时的占位卡背
│   └── wawa.png                        # 「关于」页的项目图标
├── fonts/
│   └── Belwe.ttf                       # 卡牌显示字体
└── data/
    ├── hearthstone_cards_zhCN.json     # 完整卡库（36,022 张，约 10.4 MB）
    └── cards-meta.json                 # 元数据（6 KB）
```

---

## 📡 数据文件说明

项目采用**双文件**数据方案，职责分离：

| 文件 | 回答的问题 | 内容 |
| --- | --- | --- |
| `hearthstone_cards_zhCN.json` | 这张卡**是什么** | 卡牌原始数据数组（36,022 条） |
| `cards-meta.json` | 怎么用人话**讲出来** | 枚举→中文映射、58 个系列分组、图床前缀 |

`cards-meta.json` 中的 `maps` 字段承载全部中文翻译（`MAGE → 法师`、`LEGENDARY → 传说`、`BEAST → 野兽` 等约 200 条），`sets` 字段承载 58 个系列及其 5 个分组。

> 💡 游戏更新出新系列时，**只需修改 `cards-meta.json`**，无需改动任何代码。

---

## 🔌 本地预览

浏览器出于安全策略（CORS）禁止 `file://` 协议下 `fetch` 本地 JSON，**必须通过 HTTP 访问**：

```bash
python3 -m http.server 8000    # 二选一
npx serve .                    # 二选一
```

然后打开 `http://localhost:8000`。

---

## 🧱 技术栈

| 层面 | 方案 |
| --- | --- |
| 结构 / 样式 / 逻辑 | 原生 HTML + CSS + JavaScript，**无框架、无构建步骤** |
| 数据层 | 纯前端，`fetch` 静态 JSON 后在内存建立 `Map` 索引 |
| 卡图 | [HearthstoneJSON](https://hearthstonejson.com/) 官方图床 |
| 字体 | Belwe |
| 托管 | Cloudflare Pages（全球 CDN） |

---

## ❓ 常见问题

**为什么不用后端？**

卡库只读且体积可控（10.4 MB），交给浏览器本地索引后所有查询都是内存操作，**延迟趋近于 0**；同时省去服务器与运维成本。

**为什么卡图加载看起来慢？**

卡图来自外部图床，单张约 138 KB，浏览器同域并发上限为 6。项目已通过懒加载把首屏控制在 **2~3 秒**。

**首次加载为什么要等？**

需下载约 10.4 MB 的卡库（浏览器会缓存）。Cloudflare Pages 默认开启 gzip/Brotli，实际传输量约 2~3 MB。

**为什么搜不到某张卡？**

本项目使用**官方全量原始数据**（36,022 张，含战棋 / 佣兵 / 附魔 / 英雄皮肤与全部衍生 token），不会出现漏卡。若搜不到，请先确认 `data/hearthstone_cards_zhCN.json` 已正确放置。

---

## 🙏 致谢

- [HearthstoneJSON](https://hearthstonejson.com/) —— 提供卡牌数据与卡图图床
- [Cloudflare Pages](https://pages.cloudflare.com/) —— 提供静态托管
- [Blizzard Entertainment](https://www.blizzard.com/) —— 炉石传说

---

## 📄 许可证

本项目仅供学习与交流使用。炉石传说及其相关素材版权归 **Blizzard Entertainment** 所有。
