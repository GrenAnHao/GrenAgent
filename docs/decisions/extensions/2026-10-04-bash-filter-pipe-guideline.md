---
title: bash 流式纪律扩到过滤管道（Select-String / grep / findstr）
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/sandbox/bashUiDescription.ts
supersedes:
superseded_by:
---

## 背景
一次 Chromium 增量构建写成 `autoninja ... 2>&1 | Select-String -Pattern "(FAILED|error|Build Succeeded|...)"`，卡片停在「等待响应中」15 分钟。管道和 AutoFlush 都在正常流式传输，只是构建成功前进度行（`[3/5] LINK chrome.dll`）一行都不匹配，全被筛掉。原有 promptGuideline 只点名了 `Select-Object -Last`、`tail`、`Out-String`，模型改用过滤管道就绕了过去。

## 决定
同一条 STREAMING_GUIDELINE 里追加 `Select-String`、`grep`、`findstr`：长命令不加过滤直接跑；需要定位错误时，到 bash 截断提示里的 `Full output:` 临时日志里搜。仍是一条 guideline，不新增条目。

## 放弃的方案
- bash 换 ConPTY + 卡片换 xterm：前两篇笔记已否决 ConPTY，理由不变；就算换了，过滤管道照样把输出吃掉，问题不在传输层。
- 在 bash 工具里剥掉命令末尾的过滤管道：会改变输出和退出码语义，模型也不知道命令被改过，与 2026-10-04 streaming-gaps 笔记放弃改写 `-Last` 的理由相同。
- 给 bash 加后台 job（jobs 现只有 subagent 一种）：能让回合不阻塞，但这次的症状是看不到进度而不是回合阻塞，按需另行评估。

## 后果
提示词变长一点，会重建一次系统提示前缀缓存。确实只想看匹配行的短命令（例如在已有日志里 grep）不受影响，guideline 只针对长时间运行的构建 / 测试。用户手动 `!` 命令不受约束。
