---
title: 贴底跟随加读者手势闸门、跟随中接管 virtua 的跳变补偿，「回到底部」只看跟随意图
status: active
date: 2026-10-09
scope: electron-agent/chat
files:
  - electron-agent/src/features/chat/transcriptFollow.ts
  - electron-agent/src/features/chat/VirtualizedMessageList.tsx
  - electron-agent/ui-harness/scenarios/chat-follow.tsx
  - electron-agent/ui-harness/probes/chat-follow.mjs
supersedes: 2026-10-09-transcript-follow-ledger.md
superseded_by:
---

## 背景

上一篇照 DSH 改成「位置账本 + 停手采样」后，用户反馈：首次贴底以后，内容一快、一下挤过去就不贴底了。原 `chat-follow` 场景只用定高文字块，复现不出来；新加的真实对话模式（真实 reducer → `ChatMessageItems`，Markdown、代码块、表格、bash 工具卡，每 10~100ms 一段）三种速度都丢了贴底，离底 1637 ~ 19093px。

插桩看到的是：一条助手消息收尾并插入工具卡时内容缩短 44px，`scrollTop` 却掉了 88px——浏览器钳制一次，virtua 的跳变补偿（`_fixScrollJump`，视口上方条目变矮时 `scrollBy(jump)`）再减一次，视图落在底部上方 45px。这个位移不在账本里，按 DSH 的规则算读者移动；程序滚动是瞬时的，`scrollend` 马上到，采样离底 45px > 25px，跟随就此释放。DSH 不虚拟化正文，账本外的位移只有读者，所以它没有这个问题。

加上手势闸门后不再丢贴底，但用户又反馈跑起来会抖：被推离底部的那一帧已经画出来了，下一帧的 scroll 事件里才被拉回。给滚动容器的 `scrollBy` / `scrollTo` / `scrollTop` 加探针看到，往上推的写入全是 virtua 自己的 `scrollBy({ top: -44 })`：内容缩短 44px，浏览器把 `scrollTop` 从 2715 钳制到 2671（新底部），virtua 判断「旧位置 + 跳变 ≥ 底部」时 2715 − 44 = 2671 比 2672 差一个小数像素，走了相对分支，在钳制之上再滚 −44。

同一轮还发现「回到底部」按 `rows.length > 3` 才显示：一整轮长回复加工具卡在列表里只算一行，长会话往上滚也看不到按钮。

## 决定

保留账本与停手采样，在「跟随中」加一道读者手势闸门：

- 跟随中，往上的位移只有在读者手势之后 1 秒内、或指针按住期间（拖滚动条）才算读者；其他上移一律当程序回声，直接贴回底部。手势是滚动容器上的 wheel / touchstart / 滚动键，以及 pointerdown 到 pointerup；输入框转发的 `scrollBy` 也记一次手势。
- 不跟随时照旧：任何偏离账本的位移都进入停手采样，滚回底部附近恢复跟随。
- 跟随中接管 virtua 的跳变补偿：virtua 只在 `_fixScrollJump` 的相对分支调滚动容器的 `scrollBy`，`VirtualizedMessageList` 在这个元素上包一层 `scrollBy`，原生滚动之后若仍在跟随、且没有待采样的读者移动，同一个任务里贴回底部，这一帧画出来就是对的。读者在滚或在看中部时不插手，virtua 照常保持阅读位置。
- 「回到底部」只看跟随意图（与 DSH 一致）。不跟随必然是读者滚离底部 25px 以上，列表一定可滚，不需要按条数兜底。

`chat-follow` 场景新增真实对话模式：打开贴底、三种速度的快速输出持续贴底且没有被往上推离底部的帧（在 document 的 capture 阶段读 scroll 事件，先于列表自己的处理，读到的就是上一帧画出来的位置）、快速输出中读者上滚能离开底部且输出结束后停在原处并露出「回到底部」。去掉 `scrollBy` 接管时三种速度各有一帧被推上去 37~69px，这条断言会失败。

## 放弃的方案

- 只修这一种双重补偿（内容缩短时一律不算读者）：virtua 还有别的写入路径（边缘处按陈旧偏移的绝对 `scrollTo`、测高估算修正），逐个排除会漏；手势闸门对所有程序写入一视同仁。
- 关掉 virtua 的跳变补偿：它是 virtua 在读者阅读中部时保持视图不跳的机制，没有公开开关，改库要维护补丁。接管只在跟随中生效，保留了它在阅读中部的作用。
- 每次写 `scrollTop` 后派发一个合成 scroll 事件，让 virtua 立刻记下新位置：试过，抖动照旧——差的是边界判断里的小数像素，不是位置陈旧；位置陈旧时 virtua 的目标落在底部之下，同样走相对分支，已被 `scrollBy` 接管覆盖。
- 在下一帧的 scroll 事件里拉回（手势闸门本身）：位置对了，但错位的那一帧已经画出来，就是用户看到的抖。
- 回到旧的「滚轮即离底」：那正是最初「内部滚动区上滚后不再贴底」的根因；这里手势只是必要条件，是否离底仍由实际位移和停手采样决定，内部滚动区的滚动不产生外层位移，不会误判。
- 换掉 virtua、不虚拟化正文（DSH 的做法）：长会话的挂载成本是当初引入 virtua 的原因，超出这次修复范围。

## 后果

- `scrollBy` 接管依赖 virtua 的内部实现（跳变补偿的相对分支调滚动容器的 `scrollBy`，`scrollToIndex` / `scrollTo` 走 `scrollTo`）。升级 virtua 后跑 `chat-follow` 的真实对话模式，「没有被往上推离底部的帧」失败就说明实现变了。
- 没有手势的程序化上移（例如将来加的「跳到某条」如果走 `scrollTop` 写入）在跟随中会被拉回底部；这类功能要先关掉跟随或记一次手势。迷你地图跳转走 virtua 的平滑 `scrollToIndex`，由点击的 pointerdown 记上手势，不受影响。
- 读者在内部滚动区上滚轮的 1 秒内，若恰好有 virtua 把外层往上推，会被当成读者移动而暂停跟随，可用「回到底部」恢复。
- 真实对话模式的数据形状照 pi 事件造，速度远高于真实模型输出，用来放大问题；以后改 virtua 或列表结构要跑这一组。
