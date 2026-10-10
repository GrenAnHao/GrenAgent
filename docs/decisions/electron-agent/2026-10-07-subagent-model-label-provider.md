---
title: 子代理模型标签带上供应商：`供应商显示名 / 模型 id`
status: active
date: 2026-10-07
scope: electron-agent/subagents
files:
  - electron-agent/src/features/panels/subagentUtils.ts
  - electron-agent/src/features/settings/providerListCache.ts
  - electron-agent/src/features/chat/SubAgentInline.tsx
  - electron-agent/src/features/chat/SubAgentGroupInline.tsx
  - electron-agent/src/features/subagents/SubAgentCard.tsx
  - electron-agent/src/features/chat/input/workspace/TaskTray.tsx
supersedes:
superseded_by:
---

## 背景
`displayModel` 把路由的 provider 前缀整个去掉，只留模型 id。用户在两个自定义供应商下挂了同一个 `deepseek-v4.1-flash`，卡片上看不出子代理实际走的是哪一家。Bot 菜单和任务托盘则直接显示原始路由，provider 是 `custom-muc3psr5` 这类自动生成的 id，没法读。

## 决定
主对话单卡、并行/链式行、Bot 菜单卡片、任务托盘统一显示 `供应商显示名 / 模型 id · 档位`。显示名取设置里的供应商列表（`useProviderNames`，复用 `providerListCache` 的进程级缓存），查不到时用 provider id。provider 取路由第一个 `/` 之前的部分，模型 id 自身带的 `/`（如 openrouter 的 `anthropic/...`）保留。没有前缀的值（别名、旧数据）原样显示。Bot 菜单卡片的悬停提示附带原始路由。

## 放弃的方案
- 直接显示原始路由 `custom-xxx/model`：能区分，但自定义供应商的 id 是随机串，用户认不出是哪一家。
- 只显示供应商显示名、不带模型 id：同一供应商下的不同模型又分不开。
- 把显示名在后端写进 `details`：供应商改名后历史卡片会停在旧名字，而且主进程这边不需要显示名。

## 后果
标签变长，靠 `ModelNameTag` / 卡片的省略号截断，完整内容在悬停提示里。两个供应商起了相同显示名时仍分不开，这时只能看悬停提示里的原始路由。供应商列表加载失败时退回 provider id，不影响卡片其他内容。
