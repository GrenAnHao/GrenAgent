---
title: 进程内子代理的空闲超时按活动重新计时，超时算失败而不是被终止
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/multi-agent/embedded-runner.ts
  - extensions/multi-agent/index.ts
  - extensions/jobs/notice.ts
supersedes:
superseded_by:
---

## 背景

进程内 one-shot 子代理（前台并行 run 和后台 one-shot job 都走它）在开跑时设了一个 `SUBAGENT_TIMEOUT_MS`（默认 300 秒）的「空闲」定时器，之后再没重设。它实际是 5 分钟硬上限：注册表里一批子代理在 301 到 316 秒之间以 `aborted` 结束，结束前几秒还在读文件、调工具。后台 job 把这种结束记成 `killed`，通知正文又因为输出是空串、`output ?? error` 取不到错误，只剩一句 `finished killed`，看起来像有人手动停了它。

## 决定

子会话每来一个事件就记一次活动时间。定时器到点时按最后一次活动顺延，真正安静满 `idleMs` 才 abort，错误写 `idle timeout: no activity for Ns`。第一次出现模型输出或工具执行之前用启动宽限 `SUBAGENT_STARTUP_MS`（默认 `max(idle×2, 300s)`），另设 `SUBAGENT_MAX_MS`（默认 idle×10）硬上限，文案与进程子代理 `runner.ts` 一致，界面已有的「超时」识别直接生效。后台 job 只有外部取消才记 `killed`，自身超时记 `failed`。通知正文在输出为空时带上错误原因。

## 放弃的方案

- 每个事件 `clearTimeout` 再 `setTimeout`：流式 delta 很密，八个子代理同时跑时每秒上千次重建定时器；记时间戳、到点再顺延就够了。
- 只把默认超时调大：干活中的子代理照样会在某个固定时刻被杀，只是推迟。
- 去掉超时：真正卡死（模型无响应、工具挂住）的子代理会一直占着并发名额。

## 后果

长任务只要还在产出事件就不会被杀，最长跑到 idle×10。一个工具本身安静执行超过 `idleMs`（没有 `tool_execution_update`）仍会被判空闲超时，与进程子代理相同。`killed` 不再表示超时，旧会话里已有的 `killed` 通知不受影响。
