---
title: 链式步骤先显示模型，未轮到的步单独等待
status: active
date: 2026-10-04
scope: electron-agent/chat
files:
  - extensions/multi-agent/index.ts
  - electron-agent/src/features/panels/subagentUtils.ts
  - electron-agent/src/features/chat/SubAgentGroupInline.tsx
supersedes:
superseded_by:
---

## 背景

链式 `spawn_agent` 跑完一步后，这一行的模型名消失。结果里没有 `model`，界面只在 registry 仍是 running 时才把模型补上，步骤一结束就对不上。后面的步还没创建子代理，却和并行组一样被标成 starting，行上因此显示「正在处理」，计时从卡片出现时开始。

## 决定

链式一开始就解析每步模型，并用工具的增量结果推送：当前步 starting/running，其余步 `status: "waiting"`。完成或失败的结果保留 `model`。界面把 waiting 显示为「等待上一步完成」，模型在状态前面；没有模型时不留空框。旧结果没有模型时，按任务原文对一次 registry 里已结束的记录。

## 放弃的方案

- 继续把未开始的步标成 starting：并行组需要这个状态，链式会让后面的步看起来已经在跑。
- 只在参数写了 `chain[].model` 时显示：多数步骤继承父模型，参数里没有名字，完成前仍然是空的。
- 完成行只靠实时轮询补模型：轮询在组结束后会清掉，已经落盘的结果还是空的。

## 后果

链路中途失败时，没跑到的步仍是「未执行」，不再保持等待。已经结束、结果里又没有模型、任务原文也对不上 registry 的旧步骤，模型名补不回来。
