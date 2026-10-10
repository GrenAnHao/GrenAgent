---
title: 后台 bash 行的图标和时长跟着后台任务走，不再跟着工具调用本身
status: active
date: 2026-10-05
scope: electron-agent
files:
  - electron-agent/src/features/tools/ToolExecution.tsx
  - electron-agent/src/features/tools/bashCardModel.ts
  - electron-agent/ui-harness/scenarios/bash-job-card.tsx
supersedes:
superseded_by:
---

## 背景

`bash` 加 `run_in_background` 时，工具调用本身瞬间就返回了，reducer 里这条工具消息立刻是 `done`。折叠行的状态图标取的是这个 `status`，时长取的是 reducer 记的调用耗时，于是一个还在跑了八分钟的后台任务，行上是绿色对勾加 `0s`，和一条已经跑完的命令没有区别。唯一能看出还在跑的只有右边一小块灰色的「后台运行中」，颜色和普通 meta 一样。用户因此以为任务结束了，界面上也找不到别的地方显示它。

这个问题光看代码看不出来：数据链路是通的。真实会话 JSONL 里这次调用的 `details` 带着 `jobId` / `jobStartedAt`，运行诊断日志里能看到卡片渲染后立刻调了一次 `job_snapshot`，`pi://jobs` 帧也在发，`droppedSends` 为 0。是展示本身把它画成了已完成。

## 决定

`PlainToolExecution` 对后台 bash 订阅 `jobLiveStore`（`BashJobMeta` 已经在订阅同一个条目，不增加请求），用 `jobRowStatus` 推出行状态：任务在跑或正在停止是 `running`（转圈），失败、被停止、非零退出是 `error`，其余沿用调用本身的状态。时长用 `jobTiming`：在跑时从任务开始时间起算并逐秒自增，结束后定格在任务自己的耗时。任务还没取到（快照在路上）或已不在时沿用调用本身的状态。

`toolTitle` 里 bash 分支仍按调用本身的 `status` 决定要不要取任务引用，只给 `timing` 加了可选的 `running`，只管时长是否自增。

新增 ui-harness 场景 `bash-job-card`，数据形状照真实会话里 `run_in_background` 的结果，覆盖实时、历史回放、任务已不在，以及输出帧追加、停止、结束。已有的 jsdom 单测（`BashJobTerminal.test.tsx`）覆盖了卡片内容，但没有断言行图标和时长，也没在真实窗口里跑过；两者互补，都留着。

## 放弃的方案

- 让 reducer 里的工具消息在任务结束前一直保持 `running`：调用已经返回给模型，这条消息的状态要和 pi 的一致，回合级的运行中判断也会被它拖住。
- 只把「后台运行中」那块 meta 做得更醒目：行首的 ✓ 和 `0s` 仍然在说已完成，两处互相矛盾。
- 在 reducer 里消费 `pi://jobs` 帧来改工具消息状态：reducer 是纯的事件折叠，job 帧走独立通道和独立 store（`jobLiveStore`），混进去会让历史回放和实时走两套逻辑。
- 加一个全局的后台任务面板或角标：属于新功能，范围更大，这次没做。

## 后果

「任务已不在」（应用重启或已清理）的行没有任务可参考，仍然是 ✓ 加调用本身的 `0s`，和之前一样。

带后台任务的 bash 行现在会随任务状态重渲染。`ToolExecution` 是 memo 的，订阅发生在组件内部，不受父级 memo 拦截。

界面上目前除了这一行和展开后的终端，没有别的地方列出正在跑的后台任务。如果要一个全局入口，需要另做。
