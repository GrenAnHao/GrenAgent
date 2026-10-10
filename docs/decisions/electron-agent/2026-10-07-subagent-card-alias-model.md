---
title: 子代理卡片不把参数里的 cheap / strong 别名当模型名显示
status: active
date: 2026-10-07
scope: electron-agent/subagents
files:
  - electron-agent/src/features/panels/subagentUtils.ts
  - electron-agent/src/features/chat/SubAgentInline.tsx
  - electron-agent/src/features/chat/SubAgentGroupInline.tsx
  - extensions/multi-agent/index.ts
supersedes:
superseded_by:
---

## 背景
2026-10-05 起 `spawn_agent` 的 `model` 可以直接写 `cheap` / `strong`。正常完成的结果在 `details.model` 里写解析后的路由，卡片显示真实模型；但前台单任务「中途出错保留已产出部分」那条路径的 `details` 没写 `model`，直接抛错、运行中的卡片也没有结果。卡片这时退回调用参数，显示成 `cheap · 最高`、`strong · 高`，看起来像设置里没配的模型名。档位同理：参数里的 `max` 是请求值，子会话按模型能力收窄成 `xhigh`，卡片却显示「最高」。

## 决定
前端把参数里的 `cheap` / `strong` 视为别名（`isModelAlias`）：单卡和并行/链式行都优先用工具结果的 `details.model`，其次注册表里登记的实际路由（`registry.create` 时就写了解析后的 `chosenModel`），别名只作最后兜底；别名同样算「缺模型」，会触发一次注册表查询。单卡的思考档改为结果 → 注册表 → 运行中实时值 → 参数请求值。后端在部分产出路径的 `details` 里补上 `model` 与实际档位。

## 放弃的方案
- 只在后端补 `details.model`：抛错路径没有 details 可写，运行中也还没有结果，前端仍会显示别名；旧会话的历史也修不回来。
- 前端自己把别名按当前设置解析成路由：设置可能在派发之后改过，显示的就不是当时真正跑的模型；注册表记的是当时的值。
- 把抛错改成带 details 的 `isError` 结果：改动面大，牵涉现有错误文案与测试，收益已被注册表兜底覆盖。

## 后果
别名之外的字面路由仍以参数为准（它就是实际路由）。并行/链式行的思考档仍是「结果行 → 参数」，没有改成注册表优先；如果那里也出现请求档与实际档不一致，再按同样顺序调整。
