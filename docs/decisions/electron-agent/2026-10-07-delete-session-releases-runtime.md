---
title: 删会话先把它从运行时摘下，再删文件
status: active
date: 2026-10-07
scope: electron-agent
files:
  - electron-agent/electron/app/piRuntimeService.ts
  - electron-agent/electron/app/workspaceService.ts
  - electron-agent/electron/main.ts
  - electron-agent/src/stores/runningSessions.ts
  - electron-agent/src/App.tsx
  - extensions/auto-title/index.ts
supersedes:
superseded_by:
---

## 背景
`delete_pi_session` 原来只删 jsonl，不碰持有这份会话的 handle。正在跑的会话被删后照样跑完：侧栏把它藏了，回合还在后台跑，界面上没有入口可以停它。删的是当前画面那份时，渲染层随后切到别的会话，前景正忙，这份会话被停靠到后台继续跑。SDK 的 `SessionManager` 落过盘之后每条都 `appendFileSync`，会把删掉的路径重建成没有 session 头的文件。`parseSessionRecord` 读不到头时按目录名推断 cwd，这份文件还是会被列出来，所以重启后会话又回来了。会话空闲但还挂在前景 handle 上时也一样：之后改模型、写会话控制条目，文件都会被重建。另外，标题生成是后台任务，删除时如果还没跑完，它会在会话换走后把 `session_info` 追加到原路径，生成一份只有标题的空会话。

## 决定
`WorkspaceService` 增加 `setSessionReleaser`，`main.ts` 接到 `PiRuntimeService.releaseSessions`。`deleteSession` 校验完归属后先调它，然后才拆子会话、删父文件。`deleteSessionsForWorkspace`（移除项目、清空项目会话）先把所有会话路径交给它再删。releaser 抛错时文件不删，渲染层撤销乐观隐藏并提示错误。

`releaseSessions` 在所有 workspace 的 handle 里按路径（忽略分隔符、大小写）找持有者：
- 停在后台的 handle 走 `agentHost.evict`。dispose 会依次取消挂起的询问、abort、发 `session_shutdown`，名下的后台任务和子代理跟着收口。
- 前景 handle 在原地 `newSession()`。没有走 `send('agent_new_session')`，因为前景正忙或有存活后台任务时 `send` 会停靠它，而这里的目的是拆掉它。替换过程会先 abort 在跑的回合。然后刷新 `currentSessionByWorkspace`。渲染层删当前会话、项目里又没有别的会话时，用 `getState` 取到的就是这份新的空会话（`App.tsx` 原有注释就是按这个行为写的，只是主进程一直没实现）。扩展取消了替换就抛 `SESSION_RELEASE_CANCELLED`。
- 摘下之前先清 `queuedTurns` 和 SDK 的 steer / follow-up 队列，防止回合结算时把排队消息发回已删会话。摘下之后，如果回合登记还在，就记成 `cancelled` 并清掉。dispose 期间 `WorkspaceHandle` 已置 `disposed`，`agent_end` 不再转发，登记没人清的话，`listRunningTurns` 会让渲染层重载后又把它显示为运行中。

渲染层新增 `forgetRunningSession`：删除成功后从所有 workspace 的运行集合里去掉这条路径，同时 bump 纪元，防止等待中的旧快照把它重新点亮。原因同上，拆掉停靠 handle 时收不到 `agent_end`。

auto-title 的 `writeIfUnnamed`（会话已换走、往原文件补写标题）发现原文件不存在就不写。

## 放弃的方案
- 渲染层删除前先发 `agent_abort`：只能停掉在跑的回合，handle 仍持有这份会话，后续写入照样重建文件。删除和停止分两次 IPC 往返，中间还可能插进排队的跟进。
- 删除时直接 `closeWorkspace`：会把同项目其它在跑的会话一起拆掉。
- 保留删除逻辑不变，改在 `parseSessionRecord` 里跳过没有 session 头的文件：pi sidecar 曾经不写头，旧会话都靠按路径推断才能列出来；而且后台的回合还在继续跑，用户看不见。
- 维护一份持久化的删除墓碑表，扫描时过滤或清理：能挡住任何迟到的写入，但新增一份要跨重启维护的状态，也没解决会话还在后台跑的问题。等出现无法在源头拦住的写入方时再考虑。
- 停靠的 handle 先 abort 再 evict，好让 `agent_end` 照常转发：abort 发出的 `agent_end` 会触发 `releaseIdleParked` 并发 evict，这条 evict 发现 handle 已摘掉就直接返回，于是 `releaseSessions` 会在 dispose（`session_shutdown`）跑完之前返回并删文件。

## 后果
删除正在跑的会话会立刻中止它，后台任务和子代理一起取消，不会先跑完再删。删当前会话会让前景 handle 换成新的空会话。在新会话第一条助手消息落盘之前，这份新会话没有文件。扩展可以通过 `session_before_switch` 取消替换，取消时删除失败，文件保留。auto-title 用 `existsSync` 判断文件是否已被删除，如果将来出现会话换走后才首次落盘的路径，需要重新评估这个判断。
