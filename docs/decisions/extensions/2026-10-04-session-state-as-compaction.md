> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-30-compaction-and-context-policy.md](../../../.agents/notes/implemented/architecture/2026-09-30-compaction-and-context-policy.md) 维护；本文件冻结只读。

---
title: 旧工具结果默认按压力裁并冷时定案；压缩时一次状态抽取兼作摘要
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/compaction-policy/cache-warmth.ts
  - extensions/compaction-policy/pressure-prune.ts
  - extensions/compaction-policy/prune.ts
  - extensions/compaction-policy/index.ts
  - extensions/session-memory/compaction.ts
  - extensions/session-memory/serialize.ts
  - extensions/session-memory/store.ts
  - extensions/session-memory/writer.ts
  - extensions/session-memory/index.ts
supersedes:
superseded_by:
---

## 背景
旧工具结果的裁剪默认关闭，打开后按保留轮数整段替换，每次请求都重算。压缩时 `session-memory` 只看对话末尾 12000 字符抽一次状态，Pi 再读全部待丢弃消息写一次摘要，真正读过被丢内容的只有 Pi 那次。状态文件按 sessionId 存，回退或换分支后会带着不在当前分支上的工作。

## 决定
`COMPACTION_POLICY_PRUNE` 未设置时按压力裁。缓存冷时（距最后一条助手消息与最后一次 `cache_warm` 保温中较晚的那个已超过 `COMPACTION_POLICY_PRUNE_TTL_MS`，默认 5 分钟），按未裁占用定一份 `toolCallId → soft | replace` 的计划；热时原样重放这份计划，压缩或换会话后清空。读 `SKILL.md` 的结果不参与压力裁剪，但超过熔断阈值时仍会被熔断。

压缩时 `session-memory` 读 `messagesToSummarize`、上一份摘要、属于当前分支的上一份状态和切轮前缀，做唯一一次抽取。结果写入状态文件，并作为 `{ compaction }` 返回；文件列表按 Pi 的标签附在后面，存进 `details` 由本扩展自己接力。抽取失败、被取消、带附言或准备数据不全时交给 Pi。状态文件第一行写分支锚点，不在当前分支上就不用。`session_compact` 按 `fromExtension` 和 `details.source` 决定是否再注入。

## 放弃的方案
- 每次请求单独判断冷热并重算裁法：热请求会退回未裁前缀，刚写的缓存整段 miss，与 2026-09-30-revert-thinking-strip.md 放弃开关的理由相同（前缀时有时无会打穿提示缓存）。
- 冷热只看最后一条助手消息：Pi 1.0.2 的保温不产生助手消息，会把 Pi 刚保住的缓存裁掉。
- 直接拿周期状态文件当摘要：它只看过末尾 12000 字符，没读过待丢弃的消息。
- 摘要交回 Pi、压缩时不再抽取：同样一次调用，但压缩后注入的状态会偏旧。
- 搬 MiMo 的 checkpoint 写手和边界重建：要接管会话存储，扩展钩子够不到。
- 把触发百分比改成 90：与 2026-10-02-auto-compact-threshold.md 保留的默认 80 冲突，也不改善摘要内容。
- 指望 Pi 下一轮压缩继承 `details` 里的文件列表：`fromHook` 条目不会被继承，改为本扩展合并上一份。
- 按 sessionId 记「本次摘要来自状态」的进程内标记：`session_compact` 已带 `fromExtension` 和条目 `details`，标记还要额外处理失败清理。

## 后果
- 自动压缩的触发看最后一次请求的实际用量，裁剪会推迟压缩。压缩后到下一次回复之前，Pi 报告的占用是 `null`，这段时间既不裁剪，也不触发自动压缩。
- 裁剪计划只在进程内，重启后第一次热请求不沿用旧裁法，可能 miss 一次。
- TTL 默认对应 5 分钟缓存档；用 1 小时档的提供方要调大 `COMPACTION_POLICY_PRUNE_TTL_MS`，否则会在缓存仍热时重新定案。
- codemode 嵌套调用里读的 `SKILL.md` 不受保护。
- `SESSION_STATE_MODEL` 指向小窗口模型时，压缩抽取可能溢出并回到 Pi 摘要，这次压缩仍是两次调用，状态文件不更新。
- 没有锚点的旧状态文件在下一次写入前不会被使用。
