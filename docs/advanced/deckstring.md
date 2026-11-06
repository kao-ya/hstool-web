# 卡组代码（deckstring）

官方卡组代码是 **Base64 包装的一串 varint**。这里把结构拆开讲清楚，方便自己写解析器或核对本工具的行为。

## 整体结构

```
deckstring = base64( [header] [heroes] [cards-single] [cards-double] [cards-n] [n-card-blocks] )
```

| 段 | 内容 |
| --- | --- |
| header | `0` 保留位、`version`（当前 1）、`format`（1=狂野 / 2=标准 / 3=经典…） |
| heroes | 英雄 dbfId 列表（通常 1 个，多英雄模式可有多个） |
| cards-single | 只带 1 张的卡 dbfId 列表 |
| cards-double | 带 2 张的卡 dbfId 列表 |
| cards-n | 带 3 张及以上的卡（`N, dbfId, count` 三元组） |
| n-card-blocks | 结尾保留位，通常 0 |

每段都以「数量」开头，数量 0 表示该段结束。

## varint 编码

和 protobuf 一样：每个字节低 7 位是数据，最高位表示「后面还有」。

```js
function readVarint(bytes, i) {
  let value = 0, shift = 0, b;
  do {
    b = bytes[i++];
    value |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return [value, i];
}
```

写入侧对称：

```js
function writeVarint(out, value) {
  do {
    let b = value & 0x7f;
    value >>>= 7;
    if (value) b |= 0x80;
    out.push(b);
  } while (value);
}
```

## 为什么同一个卡组每次短码一样

编码时把三组卡牌都按 **dbfId 升序**排序后再写入。排序消除了「加入顺序」这个自由度，所以同一套卡组永远得到同一个字节序列——可以直接用来做去重或对比。

## 常见坑

- **别按「1 张 / 2 张」硬分**：有的模式允许 3 张以上（冒险、乱斗），必须走多张块。
- **format 位不能漏**：漏掉会让某些客户端判成狂野/标准不符。
- **heroes 可以为空**：纯中立卡组或部分特殊模式，解析器要容得下空列表。
- **Base64 有变体**：官方用标准表，但有时外面会包 URL-safe `-_`，解析前先统一替换。

## 在本工具里的对应实现

编解码在 `js/app.js` 里是一对纯函数（`decodeDeckstring` / `encodeDeckstring`），不依赖任何网络请求——所以断网也能用，解码失败只会给出格式错误，不会去问服务器。
