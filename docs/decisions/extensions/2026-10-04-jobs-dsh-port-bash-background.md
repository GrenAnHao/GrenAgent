---
title: jobs 按 DSH 移植输出环与结算语义，bash 增加 run_in_background
status: superseded
date: 2026-10-04
scope: extensions
files:
  - extensions/jobs/types.ts
  - extensions/jobs/service.ts
  - extensions/jobs/ring.ts
  - extensions/jobs/pump.ts
  - extensions/jobs/render.ts
  - extensions/jobs/notice.ts
  - extensions/jobs/index.ts
  - extensions/sandbox/background.ts
  - extensions/sandbox/index.ts
supersedes:
superseded_by: extensions/2026-10-05-own-bash-promote-and-live-jobs.md
---

> 已过时 → 见 [2026-10-05-own-bash-promote-and-live-jobs.md](2026-10-05-own-bash-promote-and-live-jobs.md)

## 背景
一次 Chromium 构建在前台 bash 里跑了 15 分钟，整轮阻塞，模型和用户都只能等。jobs 只有 subagent 一种 kind，没有后台命令；原 service 是 DSH tool-jobs 的简化版：流式 job 靠生产方的 `readOutput()` 回调，没有输出环、没有结算原因，通知在等待方已经拿到终态时仍会再发一次。用户要求直接照抄 DSH（deepseek-harness）的 jobs 体系。

## 决定
- 照 DSH `jobs-local` 移植注册表：每个 job 一个 `OutputRing`（绝对字节偏移，运行期 256KB、结算后 16KB，模型未读的字节保留到首次终态读取），拉取源由 `startPump` 每 150ms 泵入、结算前再排干一次；模型用消耗式游标读，`readAt` 非消耗；`wait` 与读取分开；kill 原因合并进 killed 的 detail；每个 owner 最多 10 个存活 job；`detachOwner` 以 teardown 原因结算并删记录，cancel 抛错时强制 failed。
- 照 DSH `tool-jobs`：`job_output` 先输出（无新输出写 `(no new output)`）、末尾状态行 `[status: <status>, <detail>]`，按生产方 `outputLimitBytes` 保留尾部；结算通知跳过等待释放的（awaited）、模型自己 `job_kill` 的、teardown 的。
- 照 DSH `tool-bash`：bash 增加 `run_in_background`，命令在 `run()` 里经同一套沙箱 operations 起，非零退出记 completed + `exit code: N`，被取消记 killed，拿不到退出码记 failed。
- 兼容本仓库：`JobsService.read(id, caller, { wait })` 保留为「可选等待 + 一次消耗读取 + 渲染」，multi-agent 不改；终值 job 的通知仍把结果内联；通知首行格式不变（界面 `JobDonePill` 用正则解析），流式 job 在第二行给 DSH 状态行和 job_output 指引。
- 与 DSH 的差别：沙箱 exec 把 stdout / stderr 合成一路，bash job 不分通道；完整日志总是写临时文件并在开始结果里给出路径（DSH 只在超出保留窗口时 spill）；不移植 scope 分层与 controller 准入（本进程只有一套组合，jobs 总随 sandbox 加载）。

## 放弃的方案
- 前台超时自动转后台（DSH `promoteOnTimeout`）：要把前台 bash 改成「每次都是 job、前台只是等它」，等于重写 pi 自带 bash 的流式更新、尾部截断和临时文件逻辑，卡片的流式行为也要跟着重测。这次先只做显式的 `run_in_background`，靠 guideline 引导长命令用它。
- 给 operations.exec 加分通道回调，让 bash job 分 stdout / stderr：受限 runner 路径要一起改，合流顺序对构建日志反而更直观。
- 保留 `readOutput()` 推模型、不引入环：没有偏移就做不了非消耗的观察者读取，界面以后要跟随后台 job 输出时还得再推翻一次。
- 新增独立的 `bash_background` 工具：多一个 schema，模型要在两个工具间选；DSH 与 Claude Code 都是 bash 上的一个布尔参数。

## 后果
后台 job 的实时输出目前只有模型通过 `job_output` 能看到；界面跟随（DSH `job.follow` / 名册）还没接，`readAt` 已经备好。`job_output` / `job_list` / `job_kill` 的文本格式变了，依赖旧格式的提示或测试要跟着改。临时日志写在系统 temp，不主动清理，与 pi 前台 bash 的截断日志一致。若之后做前台超时转后台，应以新笔记 supersede 本篇的「放弃的方案」第一条。
