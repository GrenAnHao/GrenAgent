> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-30-compaction-and-context-policy.md](../../../.agents/notes/implemented/architecture/2026-09-30-compaction-and-context-policy.md) 维护；本文件冻结只读。

---
title: 请求前丢掉已结束轮次的助手思考，本轮工具循环原样保留
status: superseded
date: 2026-09-29
scope: extensions
files:
  - extensions/thinking-replay/strip.ts
  - extensions/thinking-replay/index.ts
  - extensions/index.ts
  - electron-agent/electron/app/contextUsageEstimate.ts
supersedes:
superseded_by: 2026-09-30-keep-completed-thinking-over-truncated-stub.md
---

> 已过时 → 见 2026-09-30-keep-completed-thinking-over-truncated-stub.md

## 背景
Pi 默认会把带签名的思考整段重放给同一模型；换模型时还会把思考改成普通文本塞进正文。已结束轮次的草稿纸既占窗口，又会在换模型时污染回复。真要裁剪必须发生在 `convertToLlm()` 之前，否则换模型时旧思考已经变成文本。

## 决定
新增 `thinking-replay` 扩展，挂 `context` 钩子：对发往模型的副本调用纯函数 `stripSettledThinking`，删掉最后一条 `role === "user"` 之前助手消息上的 `type === "thinking"` 块（含 redacted / 空文本带签名）。最后一条用户消息之后的思考、`thinkingSignature`、工具调用上的 `thoughtSignature` 全部保留。会话文件与界面不动。策略固定开启，不做开关。`contextUsageEstimate` 复用同一函数，使压缩后空窗的 chars/4 估计与真实请求一致；供应商已返回的 `contextUsage.tokens` 不改。

## 放弃的方案
- 改 pi-ai 源码：会绑死我们自己的 fork，升级成本和回归面都更大；扩展钩子已经能在 `convertToLlm` 前改副本。
- 从会话里删思考：界面展开、重试原文、压缩摘要都会丢信息；用户也看不到历史推理。
- 连本轮工具循环一起剥：Anthropic 验签会失败，DeepSeek / Kimi 在 `tool_calls` 上回放缺字段会 400。
- 做成用户开关：中途切换会让前缀时有时无，提示缓存反复失效。
- 把旧思考收成一段摘要：多一次模型调用、延迟与费用都上来，而且摘要质量难保证；本次只做「丢掉已结束草稿纸」。

## 后果
- 只写在思考里、正文没留下的决定，下一轮模型看不到。需要可见结论时必须落在正文或工具结果里。
- 压缩摘要仍读会话原文，摘要那一次仍看得到思考。
- 换模型时，本轮未结束的思考仍由 pi-ai 转成文本（未完成工具循环的既有行为）。
- 无用户消息边界时不裁，避免误伤没有切分点的上下文；用量估计在该情形下仍会计入思考。
