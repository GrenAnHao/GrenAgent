---
title: 主进程每 10 秒写一行运行诊断，事件不再推给已销毁的渲染帧，渲染进程崩溃后自动重载
status: active
date: 2026-10-04
scope: electron-agent
files:
  - electron-agent/electron/runtimeDiag.ts
  - electron-agent/electron/main.ts
  - electron-agent/electron/ipc/register.ts
supersedes:
superseded_by:
---

## 背景

子代理跑在 Electron 主进程里。出现过主线程卡住数秒（授权请求集体超时）、内存暴涨和渲染帧销毁后每条事件都打一整段 `Error sending from webFrameMain` 堆栈，但没有任何记录能说明是哪个进程、什么时候、被什么占住。渲染进程崩溃也没有监听，窗口只会停在那里。

## 决定

`startRuntimeDiag` 每 10 秒往 `<logs>/runtime-diag.jsonl` 追加一行：各进程私有内存、主进程堆、事件循环延迟（max / p99 / mean）、渲染层 `performance.memory`、这 10 秒内主线程耗时最多的 IPC 命令、按通道和来源统计的推送数、被跳过的推送数。`render-process-gone`、`child-process-gone` 和窗口无响应各写一行带原因的记录。文件超过 20MB 轮转一次。`broadcastPiEvent` 在帧已销毁或渲染进程崩溃时跳过推送并计数。渲染进程非正常退出后 1.5 秒自动重载窗口，10 分钟内最多 3 次；会话和子代理都在主进程里，重载后界面能接回去。

## 放弃的方案

- 只修推送报错、不记诊断：下次内存或卡顿出问题仍然只能猜。
- 接 crashReporter：只覆盖崩溃，看不到卡顿和内存爬升，还要处理 dump 文件。
- 采样时对每条推送算字节数：每条事件都 `JSON.stringify` 一次，诊断本身就成了负载。
- 崩溃后保持白屏等人重启：主进程里正在跑的会话和子代理会被一起重启打断。

## 后果

开发和打包进程都会写这份日志，每天约 8 千行。渲染层堆是 Chromium 的近似值，只能看趋势，Blink 侧（Oilpan、PartitionAlloc）不在里面，要看进程私有内存。10 分钟内崩到第 4 次就不再重载，窗口停在白屏，以日志里的崩溃原因为准排查。
