---
title: 自动压缩触发值按全局加会话覆盖
status: active
date: 2026-10-02
scope: extensions
files:
  - extensions/compaction-policy/threshold.ts
  - extensions/compaction-policy/index.ts
  - electron-agent/src/features/chat/input/ContextUsageTag.tsx
  - electron-agent/src/features/settings/settingsSchema.ts
supersedes:
superseded_by:
---

## 背景
自动压缩写死在上下文占用 80%。大窗口上 Pi 自己的 `reserveTokens` 触发线接近 100%，压缩请求容易在摘要写满输出上限时失败。手动压缩按钮另外卡在用量 70% 才能点。

## 决定
触发值是上下文窗口的百分比，范围 5 到 90。全局值存在设置 `AUTO_COMPACT_PERCENT`，没写时仍是 80。单个会话的覆盖存在 `AUTO_COMPACT_OVERRIDES`，键是会话文件路径；上下文面板的滑块改的是这份覆盖。底部「跟随全局设置」删掉覆盖，下一次判断回到全局值。手动压缩不再看 70% 门槛。

## 放弃的方案
- 把百分比折成 Pi 的 `reserveTokens`：同一字段还决定摘要输出上限，大窗口上会把摘要预算放大到几十万 token，而且按模型存，做不到按会话覆盖。
- 只放全局滑块、会话不能单独改：和上下文面板里「这一份会话」的用法不一致。
- 默认改成 Kirocrew 的 70：当前产品已经按 80 触发，未设置的会话保持原行为。

## 后果
滑块在松手后写入 runtime settings，下一轮 `turn_end` 才用新值。会话还没有文件路径时滑块不可拖，只能跟随全局。覆盖表按路径累积，删掉的会话不会自动清键。
