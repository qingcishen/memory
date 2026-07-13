# 穿搭系统（O 线 · Outfit）

> 让她「现在穿着什么」成为可感知、可切换、可被问起的状态，并驱动对话与自拍。

## 原则

- **可感知才模拟**：不问也不主动报整套清单；问了 / 刚换装 / 自拍时才强调。
- **与 StateLayer 同构**：`snapshot` / `toPrompt` / `evolve`，失败降级。
- **衣橱在人设，状态在库**：目录 `companions/<id>/outfit.json`；当前穿着在 `life_state.outfit`。

## 状态

```js
outfit: {
  current: { id, context, summary, pieces, style },
  context: 'home'|'work'|'date'|'outing'|'sport'|'sleep'|'intimate'|'sick',
  changed_at, updated_at
}
```

## 切换

| 触发 | 行为 |
|------|------|
| 时间/活动/生病/亲密阶段 | `inferOutfitContext` → `pickOutfit` |
| 对话「换衬衫/睡衣」 | `applyOutfitFromTurns` |
| 用户问穿什么 | prompt 里已有 summary，按真话说 |

## 接线

- `src/state/outfit.js`
- `src/state/outfitCards.js`（UI 卡片目录 + 默认出图提示词 + 本地图资产）
- `StateLayer.snapshot/toPrompt`
- `memory.observe` → outfit.evolve
- `buildSelfiePrompt` 用 `outfit.current.summary`
- UI：
  - **穿搭系统**页（侧栏「内在」）：造型 / 单品 / 包 / 妆台 / 内衣全量卡片；正面图、背面 AI 提示词；造型可「上身」
  - **穿搭相册**页：按造型展示「她穿上之后」的成片；卡片交互同穿搭系统；可加自定义场景
  - 情绪与身体页可改摘要；伴侣升级页只读摘要
  - **图床 Cloudflare R2**：卡片成片上传到 bucket `qingci-companion-media`，公网 `R2_PUBLIC_BASE`
  - **元数据 Supabase** 表 `companion_card_assets`（prompt / url / r2_key / mime）；自定义场景 `album_custom_entries`
  - 迁移脚本：`sql/card-assets.sql`（幂等）；环境变量见 `.env.example` 的 R2 段

## 开关

`PARAMS.outfit.enabled`

## 奢侈人设约定

- 衣橱 / 包柜 / 妆台写**一线品牌**（Hermès、Chanel、The Row、Loro Piana、Dior、Cartier…），不写杂牌。
- 对话里**点到品牌即可**，禁止导购式报货号、逐件念清单。
- `beauty`：护肤 / 底妆 / 眼唇 / 甲油 / 香氛 / 工具  
- `bags`：包柜列表  
- `shoes`：鞋履柜（高跟 / 平底 / 乐福 / 靴 / 球鞋 / 拖鞋）Manolo、Louboutin、Chanel、Hermès…  
- `jewelry`：珠宝盒（Cartier LOVE、VCA 四叶草、钻耳钉…）  
- `watches`：表盘（Tank 为主，可加 Rolex 女款）  
- `accessories`：丝巾 / 披肩 / 腰带 / 墨镜 / 棒球帽 / 泳装…  
- `outerwear`：大衣 / 西装 / 羊绒开衫 / 晨袍  
- `travel`：登机箱 / 托运箱 / 机场托特 / 旅行护肤 mini  
- `beauty.travel_mini`：出差分装清单  
- `accessories` 含 **近视光学框**（Lindberg / Cartier 金丝等，区别于墨镜）  
- `seasonal`：`{ spring, summer, autumn, winter }` → 四季主 look id  
- `wardrobe[].season`：`spring|summer|autumn|winter`；`pickOutfit` 在外出/约会时优先当季  
- `lingerie`：内衣抽屉（文胸 / 内裤 / 套装 / 丝袜 / 吊带），品牌如 La Perla、Agent Provocateur、Eres、Wolford  
- `wardrobe[].pieces` 可含：`bra`、`panties`、`lingerie`、`hosiery`、`bag`、`watch`、`jewelry`、`perfume`、`skincare` 等  

内衣规则：日常 look 自动补默认内衣；**对话里不主动报内裤文胸**，亲密场景或对方问到才说。
