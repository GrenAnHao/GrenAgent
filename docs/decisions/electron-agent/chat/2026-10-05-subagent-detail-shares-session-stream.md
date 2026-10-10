---
title: 子代理详情和主代理共用同一份被动收流核心（sessionStream），JSONL 只当历史垫底
status: active
date: 2026-10-05
scope: electron-agent
files:
  - electron-agent/src/stores/sessionStream.ts
  - electron-agent/src/stores/sessionSnapshot.ts
  - electron-agent/src/stores/agent.ts
  - electron-agent/src/features/panels/useChildSessionBinding.ts
supersedes:
superseded_by:
---

## 背景

子代理详情应该和主代理一样：只被动接收事件流，再用同一套 reducer、同一套工具卡渲染。实际上 `useChildSessionBinding` 另写了一份收流逻辑，和主 store（`agent.ts`）有四处偏离：

- 每个事件各自 `setState`，主代理是入队后按动画帧批量套 reducer。
- 没有毒事件隔离。主代理里一个事件 apply 失败只丢它自己，这里会在 `setState` 更新函数里抛出，整个详情掉进错误边界。
- 丢掉了 `materializeToolDrafts` 返回的 `deferred`。超过 64KB 的大参数工具调用，主代理会安排下一次补解析，子代理没有，卡片停在旧参数上，直到下一个事件才更新。
- JSONL 种子和实时事件互相覆盖。种子晚到时按「条数更多就整份替换」处理，会把正在流的那条助手消息丢掉，之后的增量另起一条从半句开始。`running` 翻转时 effect 还会整份重置再重读一遍。

## 决定

把主 store 的收流核心抽成 `stores/sessionStream.ts`：入队、按帧 flush、rAF 暂停时的 setTimeout 兜底、毒事件隔离、大参数草稿延迟解析、epoch 计数。主 store 和子代理详情都用它，逻辑从 `agent.ts` 原样搬出，主 store 行为不变。

`useChildSessionBinding` 只依赖 `sessionPath` 订阅，`running` 翻转不再重建订阅、不清空已收到的内容。JSONL 只当历史：开头读一次，经 `snapshotMessages`（从 `agent.ts` 提到 `sessionSnapshot.ts`，主代理载入会话用的同一个函数）转成界面消息，再用 `mergeLiveTail(快照, 实时)` 垫到实时尾巴前面。先订阅再读种子，读的过程中到的事件进队列，合并前先 flush。

补读保留，但改成按场景合并：运行中安静超过 5 秒、以及运行结束时各补一次。补读时事件已经安静，快照至少一样新，快照条数不少于实时就整份采用（进程子代理不推事件，工具结果靠这里更新），否则仍把实时尾巴叠上去。推理时长在 `message_end` 后经 `persistThinkingDurations` 落盘，补读回来的快照能带上时长。

## 放弃的方案

- 子代理详情直接用 `createAgentStore`：它带着会话切换、shadow、缓存、composer 队列、ui-request 暂存，只读绑定用不到；还会写 UI 历史和会话缓存，把子会话内容混进主会话的缓存里。
- 在 hook 里再复制一遍 flush 逻辑：这次偏离的来源就是复制，两份会再漂移。
- 补读一律用 `mergeLiveTail(快照, 实时)`：`mergeLiveTail` 假设尾巴更新，重叠的工具以尾巴为准。进程子代理没有事件，实时那份是上一次读的快照，里面工具状态更旧，会盖掉新的结果。
- 删掉 `SubAgentConversation` 里的 registry transcript 和 `details.transcript` 回放：旧历史和没有 `sessionPath` 的结果仍靠它们。
- 给主进程子会话 sink 加 `toolcall_delta` 合并器（主会话有）：渲染端已经按帧批量，没有实测到 IPC 压力，先不加。

## 后果

以后改被动收流的行为（批处理节奏、毒事件处理、草稿解析）只改 `sessionStream.ts` 一处，主代理和子代理同时生效。

`SubAgentConversation` 里 `sessionHasWork` 在 transcript 回放和真会话之间切换的逻辑没动，没有 `sessionPath` 的旧结果仍走回放。

接 [2026-10-04-subagent-detail-binds-registry-session.md](2026-10-04-subagent-detail-binds-registry-session.md)：那篇的「事件在流时不重读 JSONL」仍然成立，这里只是补上结束时再读一次，并改了合并方式。
