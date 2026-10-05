---
title: 切到没有缓存的在跑会话时，实时尾巴先接住，后端快照到了垫在前面
status: active
date: 2026-10-04
scope: electron-agent
files:
  - electron-agent/src/stores/agent.ts
  - electron-agent/src/stores/sessionMessageSync.ts
  - electron-agent/src/lib/sessionMessageCache.ts
  - electron-agent/src/App.tsx
  - electron-agent/electron/app/piRuntimeService.ts
  - electron-agent/electron/app/sessionIdentity.ts
  - electron-agent/electron/app/workspaceService.ts
supersedes:
superseded_by:
---

## 背景
渲染层重载后，或者会话从没在画面上显示过，在后台跑的会话没有缓存可垫底，它的事件只能攒成 partial shadow。切回去时 `showCachedSession` 不认 partial，走「无缓存」分支，把画面清成空壳。跨项目切换时常驻 store 的 `workspaceReady` 初值是 true，空壳就显示成空对话，看着像草稿页。要等串行的 openWorkspace、全项目会话扫描、switchSession、getMessages 都跑完，主进程又在跑任务，大约十秒。快照回来后，同一会话在流式中的 `loadMessages` 会直接返回，所以历史一直垫不上，再点一次也没用。更糟的是，这时切走会把空壳当完整内容写进缓存；回合结束写 UI 历史时，磁盘上的完整历史会被只有半轮的尾巴覆盖。

## 决定
store 记一个 `viewHasHistory`：画面只有实时尾巴时为 false。这种画面停靠时停成 partial shadow，不写缓存，`message_end` / 后台 `agent_end` 也不写 UI 历史。partial shadow 一出现就在后台发一次 `getMessages(workspace, path)`，读 UI 历史，用 `mergeLiveTail` 把快照和尾巴合起来，再把它标成完整、写缓存，这样之后切回直接秒显。切回时快照还没回来，就把尾巴接到画面上继续收事件，并返回 false，让调用方显示骨架；快照一到，按同一会话合并，不再被流式挡掉。合并时助手消息按 pi timestamp 对齐，工具按 toolCallId 对齐，快照里没有的按尾巴顺序追加。

跨项目切回没命中缓存时把 `workspaceReady` 压回 false，显示骨架，而不是空对话。已知目标会话时，侧栏会话列表不再挡在 switchSession / getMessages 前面。后端 `agent_get_messages` 带的目标路径不在任何 handle 上时，读那份会话文件，不再落到前景会话。`readSessionIdentity` 只读首行；`listSessions` 先按首行 cwd 筛掉别的项目，再完整解析剩下的文件。

## 放弃的方案
- 切回 partial 会话时直接显示尾巴、标成就绪：只显示半轮内容，用户会以为历史丢了，而且快照到了仍会被流式挡掉。
- 给 partial shadow 记一份原始事件日志，快照到了把事件重放上去：已落盘的 `message_start` 会重放出重复的助手气泡，要区分哪些事件已经落盘，比按 timestamp / toolCallId 合并更脆。
- 无缓存分支里立刻再发一次 getMessages：同项目切换本来就会马上取快照，这样每次未命中都要多算一次投影、多传一次整份历史。
- 停靠时不管有没有历史都写缓存（维持现状）：正是这一步把空壳变成了「完整缓存」，之后的 shadow 又在空壳上继续长。

## 后果
- 合并只认 timestamp 和 toolCallId。如果以后助手消息没有 pi timestamp，尾巴里的同一条会被追加成第二条，要换别的对齐键。
- 每个 partial shadow 会多一次后台 getMessages。只有渲染层没见过的在跑会话才会走到这里，代价可以接受；如果以后后台会话很多，需要限流。
- `showCachedSession` 对「画面就是它、而且在跑」现在返回 `viewHasHistory`，不再一律 false，再点一次正在看的会话不会退回骨架。
- 读不在 handle 上的会话文件用 `SessionManager.open` 只读投影，前提是它不会改写文件；SDK 如果开始在 open 时迁移格式并写回，这里要改成自己解析。
