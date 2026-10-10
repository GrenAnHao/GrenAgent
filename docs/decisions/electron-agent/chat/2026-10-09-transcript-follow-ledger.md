---
title: 对话列表贴底改用 DSH 的「位置账本 + 停手采样」归因，不再按滚轮判断读者
status: superseded
date: 2026-10-09
scope: electron-agent/chat
files:
  - electron-agent/src/features/chat/transcriptFollow.ts
  - electron-agent/src/features/chat/VirtualizedMessageList.tsx
  - electron-agent/src/features/chat/ChatMessageItems.tsx
  - electron-agent/ui-harness/scenarios/chat-follow.tsx
  - electron-agent/ui-harness/probes/chat-follow.mjs
supersedes:
superseded_by: 2026-10-09-follow-ledger-gesture-gate.md
---

> 已过时 → 见 2026-10-09-follow-ledger-gesture-gate.md

## 背景

用户反馈对话「挂着挂着突然就不贴底了」。旧实现靠 `onWheel` 收到 `deltaY < 0` 就关掉贴底，再靠外层 scroll 事件按 120px 阈值改回来。滚轮落在思考块、终端、代码块这类内部滚动区上，或会话不满一屏时上滚，外层列表根本不动、没有 scroll 事件，贴底就一直关着，「回到底部」也不出现。`onScroll` 还用 virtua 的 `scrollSize` 判断离底，它在条目测高时就先涨了，一次长出超过阈值会把程序贴底误判成离底。新加的 `chat-follow` 场景复现了前一类：内部滚动区上滚后外层离底 528px，短会话上滚后离底 1204px。

DSH（`deepseek-harness/packages/client/ui-chat/src/client/chat/`）踩过同一类坑，先是只认滚轮，后来在 `reader-scroll-attribution-observed-top-ledger` 笔记里改成按位置归因，并把跟随意图抽成 `ScrollFollow`、读者采样放进 `ChatReading`。

## 决定

照 DSH 的模型重写，跟随意图单独放在 `transcriptFollow.ts`（`TranscriptFollow`），`VirtualizedMessageList` 只管 DOM 事件、virtua 测高期间的钉底和 resize 锚点：

- 账本：每次程序写入 `scrollTop`（贴底、钉底、resize 恢复的回声）都记下落点。scroll 事件的位置偏离 `min(账本, 底部)` 超过半像素才算读者移动；滚轮、触控板、拖滚动条、键盘都走这一条，不再监听滚轮判断读者。内部滚动区的滚动不产生外层 scroll 事件，自然不影响外层。
- 停手采样：读者移动先挂起，scrollend（或 500ms 兜底）时离底 ≤ 25px 继续跟随，否则停止并露出「回到底部」。挂起期间内容长高不贴底，小幅上滚不会被流式增长抵消。读者正好滚到最底立即恢复跟随。
- 跟随中只有往上的位移算读者：virtua 的跳变补偿（视口上方条目长高时它会把 `scrollTop` 往下推）不在账本里，DSH 不虚拟化正文所以没有这个来源；往下的位移读者本来也离不开底部，按程序回声处理。
- 用户发出新消息（列表末尾是新的用户消息）时回到底部继续跟随，与 DSH 提交输入时恢复跟随一致。
- 读者手势（wheel / touchstart / pointerdown / 滚动键）只用来打断钉底循环，与 DSH 用它释放分页锚点同理，不参与判断是否离底。
- 「回到底部」改为立即贴底并走钉底循环，不再用 virtua 的平滑 `scrollToIndex`；平滑动画的中间位置会被账本当成读者移动。这一点改了 `2026-10-08-stick-bottom-without-scrolltoindex.md` 里「回到底部仍用 scrollToIndex」的细节，那篇的主结论（贴底直接写 scrollTop）不变。

## 放弃的方案

- 保留 `onWheel`，只排除内部滚动区和滚不动的情况（本次第一版做法）：能修住复现的两种情况，但读者识别仍绑在滚轮上，触控、拖滚动条、键盘各要单独兜；DSH 正是从这条路走出来的。
- 照搬 DSH 的「跟随中任何偏离账本都算读者」：在 virtua 下，视口上方条目长高引起的跳变补偿会被当成读者，挂起期间若底部继续长高超过 25px 就丢掉跟随。
- 把 DSH 的语义位置记忆（每个会话保存锚点、切回来恢复）一起搬过来：需要会话级存储和条目锚点 key，超出这次修复范围；切换会话仍然贴底。
- 继续用 virtua 的 `scrollSize` 判断离底并调大阈值：大段工具结果一次能长出几千像素，调多大都挡不住。

## 后果

- 跟随阈值从 120px 降到 25px，读者往上滚一点也会停在原处，不再被拽回；想回到跟随要滚到底部附近停手、点「回到底部」或发消息。
- 判断依赖滚动容器是 `containerRef` 的第一个子元素（virtua 的 VList 根），并依赖 Chromium 的 `scrollend`；没有 scrollend 时由 500ms 采样兜底。
- 同一次更新里内容先缩短再长高、且不是 React 提交驱动的重排，可能被误判成读者移动而暂停跟随（DSH 笔记记录的同一取舍），可用「回到底部」恢复。
- jsdom 单测没有布局，测跟随状态时要给滚动容器补可写的 `scrollTop` 和 `scrollHeight` / `clientHeight`。
