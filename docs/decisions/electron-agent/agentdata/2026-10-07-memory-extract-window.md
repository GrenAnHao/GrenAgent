> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-18-memory-pipeline-upstream-aligned.md](../../../../.agents/notes/implemented/architecture/2026-09-18-memory-pipeline-upstream-aligned.md) 维护；本文件冻结只读。

---
title: memory_extract 只送最近 10 条对话加 5 条背景，工具输出不进抽取；delta 只当游标
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/app/memoryExtractionWindow.ts
  - electron-agent/electron/app/memoryService.ts
  - electron-agent/electron/pi/systemWorkerManager.ts
  - extensions/memory/capture.ts
supersedes: 2026-10-06-memory-task-usage-and-payload-dedupe.md
superseded_by:
---

## 背景
历史 311 个 memory_extract 任务的载荷里，工具输出占 94.7%（42.3 MB），用户发言 0.6%，assistant 文本 4.5%。delta 不设上限，老会话第一次捕获会把整段历史一次发出（实测 286 KB）。上游 TencentDB-Agent-Memory 只送 user/assistant 文本（l0-recorder.ts:551-590），assistant 去掉代码块，每批最多 10 条新消息加 5 条背景（l1-extractor.ts:149-182）。

## 决定
新增 buildExtractionWindow：按 pi 的角色行切分 transcript，只留 user/assistant；assistant 去代码块、去内联图片；按上游 shouldExtractL1 过滤；同一轮里被工具调用隔开的 assistant 文本合成一条（任何 user 段，包括被过滤掉的 /compact，都会断开合并；被过滤掉的 assistant 纯代码块不会）；单条截到 4000 字；最后取 10 条新消息，背景从「更早的会话文本 + delta 里没进窗口的消息」里取最后 5 条。

任务输入新增 newMessages / backgroundMessages，去掉 background 字符串。delta 保留，只给 captureFromTask / commitCapture 做游标；systemWorkerManager 的 Input 行一律不带 newMessages、backgroundMessages、delta、background、previousSceneName。窗口为空（新增内容只有工具输出）时不入队，直接提交游标。memory.capture 的回执新增 extraction 字段，扩展看到它就不走本地兜底抽取。

被推翻的旧笔记里，以下结论仍然有效：service_tasks 的 token 用量埋点（input / output / cache_read / cache_write_tokens、model 按 attempt 累加）；formatNonStream 先看 stopReason、provider 报错透出原文；empty content 开头的错误不重试。被推翻的只有「newMessages 是数组时，没渲染的 delta 保留在 Input 段」这一条。

## 放弃的方案
- 在扩展里改 flattenTranscript，捕获时就不存工具输出：conversation_search 依赖完整的 transcript，L0 归档会因此变样。
- 不合并同一轮的 assistant 段：一轮常被工具调用切成好几段，10 条新消息只能覆盖两三轮，和抽取节奏的 5 轮对不上。
- 不截单条：一条长报告就能把批量上限抵掉。
- 窗口外更早的 delta 消息另开任务补抽：和上游的批次语义不一致，而且会把节省的成本又花回去。
- 把 delta 从任务输入拿掉，改用 memory_captures.pending 或偏移量做游标：captureFromTask 在进程重启后要靠任务输入还原游标，commitCapture 用 delta 做前缀比对来只消费本批内容，换成偏移量要改游标模型，超出本次范围。
- 背景对整段历史做完整切分清洗、再留最后 5 条：background 是整段更早的会话，可达 MB 级，在主进程同步执行。改为只在 delta 窗口非空、且 delta 自己填不满背景时才取值，并从尾部按 64 KB 起、每次放大 4 倍的窗口解析，窗口从角色行开头切，拿到多于所需条数（窗口第一条可能和窗口之前的 assistant 合并过，只算半截）才停，放大到整段时与全量解析一致。

## 后果
一批里超过 10 条之前的对话不会被单独抽取，提交游标时视为已处理，这和上游一致。工具输出里的事实（比如某个命令的报错）只有在 assistant 文本里转述过才会被记住。截断以「…（已截断）」结尾，模型能看出来。

service_tasks.input 仍存完整 delta（含工具输出），落库体积没有按比例下降，只是不再发给模型。

扁平 transcript 里工具输出中恰好以 `user: ` / `assistant: ` 开头的行仍会被当成对话进入窗口，这是 transcript 格式本身的歧义，旧的 messagesFromTranscript 也一样；彻底解决要让 sidecar 传结构化消息。
