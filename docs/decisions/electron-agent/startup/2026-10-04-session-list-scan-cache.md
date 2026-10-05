---
title: 会话列表按字节标记只解析有用的行，并按大小和修改时间缓存
status: active
date: 2026-10-04
scope: electron-agent/startup
files:
  - electron-agent/electron/app/sessionLineScan.ts
  - electron-agent/electron/app/sessionLineScan.test.ts
  - electron-agent/electron/app/workspaceService.ts
  - electron-agent/electron/app/workspaceService.test.ts
  - electron-agent/src/App.tsx
supersedes:
superseded_by:
---

## 背景
冷启动在加载页收起前要调三次 `listAllSessions`：`acquireDraftScratch` 一次，`refreshAllSessions` 一次，`pruneOrphanConversations` 在主进程里再扫一次。旧实现把每份会话整份按 UTF-8 解码，逐行 `JSON.parse`，判短调用会话时又全部解析一遍。本机 265 份会话共 179MB，单次扫描约 1.1s，全在主进程主线程上跑。三次叠加，加上同期的其它 IPC 都得排队，加载页因此多挂两三秒。会话文件还在一直变大。

## 决定
侧栏只用得到五样东西：头一行、最后一个 `session_info` 标题、首条用户消息、`subagent_meta`、旧短调用提示。现在把文件读成 Buffer，用 `Buffer.indexOf` 按 ASCII 标记找行，只解码命中的行：`"session_info"`、`"user"`、`"subagent_meta"`，以及 JSON 转义后的 `\nTask kind: `。命中的行仍走原来的判定函数。这些标记都是对应判据的必要条件，所以结果和逐行全量解析一致（本机 265 份逐份对比相同）。

`WorkspaceService` 按路径缓存解析结果，键是文件大小加 `mtimeMs`。先 `stat` 再读，所以读到的内容只会比键新，不会把旧内容当成新的。并发扫描共用同一个 promise，读失败不进缓存，全量扫描时顺手删掉已不存在的文件。实测首扫约 290ms，之后每次约 10ms。

渲染层启动时不再等 `pruneOrphanConversations`：先进入草稿，清理放到后台。清理不碰当前草稿，主进程在建的草稿也有 `drafts` 集合挡着。

## 放弃的方案
- 把索引持久化到磁盘，下次启动免读：现在首扫已降到约 0.3s，持久化要多维护一份文件、处理版本和损坏。等会话总量大到首扫明显拖慢再做。
- 只读追加的尾部，增量更新记录：要另判文件是不是被整份改写过（回退、截断一类操作可能这样做），否则会拼出错误结果，复杂度不值。
- 只缓存不改解析：首扫仍是 1.1s，启动时第一次正好在关键路径上。
- 主进程先建窗口、再动态加载业务服务（主进程模块加载本身约 3.9s，其中 pi-coding-agent 约 2.5s）：试过拆成入口 + 按需分块。rolldown 会在入口里补一条 import，指向放运行时 helper 的共享分块，这里就是 2.5MB 的 extensions 分块，于是入口照样同步加载 Pi SDK 和 MCP SDK。打包版的入口又被编译成字节码外壳，`require("./main.jsc")` 不转发导出，分块从入口拿模块只会拿到空对象。改用独立入口加全局交接、调整分块配置都能绕开，但打包版没法在这里端到端验证，这次没做。

## 后果
- 文件被改写成同样大小、修改时间又没变时会读到旧结果；正常追加和改写都会改 `mtimeMs`。
- 以后侧栏要从会话里读新字段时，要给它加一个标记，否则读不到。标记必须是可打印 ASCII，`sessionLineScan` 会拒收其它字符。
- 主进程模块加载仍在建窗口之前，冷启动这一段约 4s 没动。要再快，得按「放弃的方案」最后一条拆入口，并先解决分块引用入口的问题。
