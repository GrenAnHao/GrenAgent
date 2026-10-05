---
title: PowerShell 在完全语言模式下按次刷新标准输出
status: active
date: 2026-10-03
scope: extensions
files:
  - extensions/_shared/sandbox/operations.ts
supersedes:
superseded_by:
---

## 背景
bash 工具会把 stdout 分片交给 `onUpdate`，界面也吃 `tool_execution_update`。Windows 上壳是 PowerShell，stdout 接到管道时默认攒缓冲，短命令要等进程退出才有第一块输出，看起来像没有流式传输。

## 决定
在已有的 FullLanguage 前缀里把 `Console.Out` / `Console.Error` 换成 `AutoFlush = true` 的 StreamWriter。约束语言模式仍然不碰这些 .NET 调用。

## 放弃的方案
- 给 bash 换 ConPTY：沙箱子进程要继承伪控制台句柄，还得把 node-pty 从 Electron 应用扯进扩展进程，失败面比一条前缀大。
- 在约束语言模式里也 SetOut：那里禁止这类赋值，每条命令都会多印一行错误。

## 后果
PowerShell 自己的输出会随写入刷新。子进程若发现 stdout 不是控制台而自行全缓冲（常见于原生程序），仍然要等它自己 flush 或退出。界面侧只要分片到达就会更新。
