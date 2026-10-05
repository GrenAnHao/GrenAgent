---
title: 子代理流式 transcript 只在内存里留 64KB 尾部
status: active
date: 2026-10-03
scope: extensions
files:
  - extensions/multi-agent/transcript-tail.ts
  - extensions/multi-agent/embedded-runner.ts
  - extensions/multi-agent/runner.ts
supersedes:
superseded_by:
---

## 背景

进程内子代理把每个 `message_update` 原样 `JSON.stringify` 后拼进一条字符串。这一帧带有截至当前的完整 `partial` / `message`，字符串按输出长度平方增长，并且一直留到子代理结束。Electron 主进程因此把约 1.5GB 的 V8 堆撑满后退出。界面不读这串：右坞用子会话 JSONL 和已剥快照的事件，聊天横条只看 registry 状态。

## 决定

序列化进内存 transcript 之前去掉 `message_update` 的快照，只留 delta。`message_end` 和工具起止仍保留。内存里的字符串超过 `LIVE_TRANSCRIPT_TAIL`（64KB）就截成尾部，截断结果复制成独立字符串。子进程 stdout 按行消化，正文用按行吸收的状态返回给父代理，不再把整段 stdout 放进 SQLite。

## 放弃的方案

- 只在 registry 落库时 `tailLines`：截断前那条字符串已经占满堆。
- 内嵌路径连 64KB 尾部也不留：运行中的 registry 预览还要它。
- 子进程另写一份 JSONL 当完整记录：内嵌会话文件已经是完整历史；子进程这条只需要父代理的正文和同一截预览，不值得再加文件和读取路径。
- 运行时按 `heapUsed` 告警：GC 前的尖峰会误报，也盖不住已经留住的字符串。

## 后果

registry 里的子代理 transcript 最多 64KB 尾部，不再在终态写回多达 4MB 的原始流。子进程没有会话文件时，右坞回放只能看到这截尾部。父代理拿到的正文仍来自按行吸收，不依赖被丢掉的快照。
