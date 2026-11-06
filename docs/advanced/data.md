# 卡牌数据与图源

## 数据

站点启动时加载 `data/` 下的卡牌 JSON（全库 36,022 张，压缩传输，浏览器缓存）。字段主要来自 **HearthstoneJSON**，外加本地的收藏判定与系列映射。

关键字段：`dbfId`、`id`、`name`、`cost`、`attack`、`health`、`durability`、`type`、`rarity`、`set`、`classes`、`text`、`flavor`、`artist`、`mechanics`、`childIds`。

## 卡图

卡图不打包进站点，按需从图床拉：

| 用途 | 源 |
| --- | --- |
| 网格缩略图 | `art.hearthstonejson.com` 的 256 宽版本 |
| 详情大图 | 512 宽版本 |
| 异画（签名卡） | `hearthstone.wiki.gg` 的签名卡图 |

三级回退：**中文 → 英文 → 本地占位卡背**。附魔、按钮、拖动这三类内部对象全库都没有卡图，直接使用占位卡背，不会发起无意义的网络探测。

## 跨域与代理

图床不发 CORS 头，所以需要时通过站内的 `api/card-img` 路径转发（Cloudflare Pages Functions）。如果这个函数不存在或被禁用，卡图会退回占位图——这是「整屏卡背」最常见的原因。

## 更新卡库

1. 从 HearthstoneJSON 拉最新 `cards.collectible.json`（或全量）
2. 按站点 `data/` 目录的字段约定做一次瘦身（只保留渲染需要的字段）
3. 替换 `data/*.json`，重新部署

瘦身很重要：全量原始 JSON 有几十 MB，直接塞进去首屏会非常慢。

## 兼容性

代码保持 ES2017 语法（不使用 `??`、`?.`、`replaceAll`、`.at()`），以兼容较旧内核。新语法请自行降级后再提交。
