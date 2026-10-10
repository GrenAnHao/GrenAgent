---
title: 自定义模型的价格补齐缓存读写价与分段计费，落盘保留 tiers
status: active
date: 2026-10-09
scope: electron-agent/settings
files:
  - electron-agent/src/features/settings/providerConfigAdapter.ts
  - electron-agent/src/features/settings/ProviderModelCard.tsx
supersedes:
superseded_by:
---

## 背景

pi-ai 1.1.0 的 `calculateCost` 已按 `cost.tiers[]` 分段计费：`input + cacheRead + cacheWrite` 严格大于 `inputTokensAbove` 时整单套用该档，多档取阈值最高的命中档。1 小时缓存写固定按 `input × 2` 计。pi-coding-agent 的 `models.json` schema 也认 `tiers`，每档要求阈值和四个价格都是数字。设置页只有输入、输出两个价格框，`completeCost` 序列化时重建对象，文件里手写的 `tiers` 一保存就丢。Haiku 5.5 这类有长上下文档的模型，用量统计因此一直按单档算。

## 决定

- 模型卡片的价格区补「缓存读价格」「缓存写价格」两个框，和输入/输出放在同一个两列网格里。缓存写的说明写明只填 5 分钟写，1 小时写由 Pi 按输入价 ×2 计。
- 价格区下面加「分段计费」列表：每行是阈值和四个价格，可以删除。「添加分段」默认阈值取当前最高阈值 + 100000（第一档就是 100000），四个价格抄基础价。
- `completeCost` 保留 `tiers`：没填阈值或阈值为负的行丢掉，没填的价格沿用基础价，同一阈值只留最后一行，按阈值升序写出。基础价一个都没填但有有效分段时照样写 `cost`（基础价补 0），不把用户填的分段吞掉。
- 卡片上对重复阈值、没填阈值给黄字提示，不拦保存。

这推翻了 [2026-10-03-models-json-partial-cost.md](../2026-10-03-models-json-partial-cost.md) 里「不加缓存价格输入」那条放弃理由：当时 Pi 只把缓存费率当可选补齐项，现在分段计费里四价都要填，没有输入框就配不了分段。那篇的主决定（缺的费率补 0）不变，所以不加墓碑。

## 放弃的方案

- 保存时遇到重复阈值或空阈值就拦下并报错：这两种都有确定的合并规则（后者覆盖、空行丢弃），拦保存会让用户为一个提示来回改，黄字提示加保存时规整就够了。
- 暴露「1 小时缓存写倍率」配置项：Pi 把倍率写死在 `calculateCost` 里，没有对应字段，UI 填了也不会生效，还会让人以为能改。
- 基础价全空时连分段一起丢掉（沿用「四价全空就不写 cost」的旧规则）：用户明明填了分段，保存后却消失，和这次要修的丢 `tiers` 是同一类问题。

## 后果

用量统计的金额会随填的缓存价和分段变准；没填缓存价的旧配置保存后仍是 0。分段只在卡片里编辑，没有从内置模型目录同步价格表，内置模型的价格仍以 Pi 自带为准。Pi 若给分段加新字段（比如独立的长缓存写价），`completeTiers` 需要一起透传，否则会被丢掉。
