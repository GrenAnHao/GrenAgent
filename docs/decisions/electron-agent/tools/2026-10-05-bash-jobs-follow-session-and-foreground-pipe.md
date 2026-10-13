> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-12-own-bash-every-call-is-job.md](../../../../.agents/notes/implemented/architecture/2026-09-12-own-bash-every-call-is-job.md) 维护；本文件冻结只读。

---
title: 后台任务跟着会话走，前台命令的匿名 job 把实时输出和停止接到卡片上
status: active
date: 2026-10-05
scope: electron-agent
files:
  - electron-agent/electron/app/piRuntimeService.ts
  - electron-agent/electron/main.ts
  - extensions/sandbox/bashTool.ts
  - electron-agent/src/features/tools/BashJobTerminal.tsx
  - electron-agent/src/features/tools/bashCardModel.ts
  - electron-agent/src/features/tools/ToolExecution.tsx
supersedes:
superseded_by:
---

> 「命令结束后展开状态保持」这一条已过时 → 见 [2026-10-06-bash-collapse-on-completion.md](./2026-10-06-bash-collapse-on-completion.md)

## 背景

要求后台任务不做全局，由启动它的会话各自承载，并且照 DSH（`packages/jobs/*`、`packages/shell/tool-pwsh`、`packages/client/ui-tool` 的 `LiveShellOutput`）的做法来。对照下来有两处差距。

第一，归属在数据上是对的：`jobs.start` 记 `owner = sessionId`，`list` / `read` / `kill` 都按 owner 围栏，界面卡片也只出现在启动它的会话的时间线里。但生命周期不对。jobs 扩展在 `session_shutdown` 里 `detachOwner` 取消该会话名下的全部任务，而 pi 的 `switchSession` / `newSession` 会先 `teardownCurrent`，原地发出 `session_shutdown`。`PiRuntimeService` 只在前景会话正在流式时才停靠 handle，回合一结束、只剩后台任务在跑的会话，用户切到另一个会话，它的任务就被一并取消了。DSH 里多个会话并存，切换不销毁。

第二，DSH 的前台命令也是 job，但是匿名的：模型拿不到 id，命令在超时内结束就连记录一起移除。界面上运行中的卡片不靠工具更新，而是找到这条命令对应的运行中 job，读它保留的输出来画卡片。我们的 `bashJob.ts` 前台命令已经注册成 job 了，运行中的前台卡片却只吃 pi 的 partial 更新，界面不知道这个匿名 job，所以重载后拿不到保留输出，也没法单独停止这一条命令。

## 决定

会话承载：`PiRuntimeService` 加 `hasLiveJobs(sessionId)` 选项（`main.ts` 接 `jobs.hasLive`）。`agent_switch_session` / `agent_new_session` 时，前景会话空闲但名下有存活后台任务，也走原来的停靠：另开一个 handle 当前景，旧 handle 留在后台继续跑。停靠的会话回合结束后，`releaseIdleParked` 看到它名下还有存活任务就不拆；任务结算会叫醒会话，那一轮跑完再走到这里，任务都结束了才释放。宿主不支持停靠时退回原地切换，不为这个拒绝用户切会话。`fork` / `rewind` 本来就会改前景那份，不在此列。

前台匿名管道：工具侧，前台命令的 job 一启动，就在 partial 更新的 `details.foregroundJob` 里带上 `{ jobId, jobStartedAt }`，之后每次输出更新也带着（partial 每次整体替换 result）。partial 不进模型上下文，最终结果仍然没有 id，所以模型看不到，超时转后台才把 id 交给它，这条行为不变。界面侧，运行中的前台 bash 卡片读 `foregroundJob`，用已有的 `jobLiveStore` 跟随这条 job：输出来自 `pi://jobs` 帧，底栏只写状态、不写 id，并给「停止」，点它只发 `job_kill`，只结束这条命令，工具那边会给模型 `Command stopped: cancelled by the user`。找不到 job（重载后记录已离开、快照在路上）时静默回退到 partial 文本，不说「任务已不在」。命令结束后工具结果是同一条消息被更新，卡片不重新挂载，展开状态保持。

## 放弃的方案

- 照 DSH 按 kind + label（命令文本）匹配运行中的 job：同一个会话里并行跑两条相同命令时只能挑最新的，会跟错；我们的工具本来就知道 id，显式带引用更准。
- 把前台任务的 id 放进最终结果或模型可见的文本：破坏「匿名」，模型会开始 `job_output` 一个它不该管的 id，还会让结果多出每次都变的噪声。
- 给 `jobs` 扩展的 `session_shutdown` 加「按 reason 区分」，切换会话时不取消任务：`detachOwner` 之后 `owners` 里的通知投递也被删掉，任务还活着却没人接收结算；并且 handle 里的 session 对象被替换，保留任务就得自己再管一份会话引用。停靠整个 handle 是现成的、同一套路。
- 所有切会话都停靠：空闲会话原地切换更便宜，停靠要多开一个 handle 和一套会话，只有名下有存活任务才值得。
- 做一个全局的后台任务面板或角标：和「任务由会话各自承载」相反，没做。

## 后果

有存活后台任务的会话被切走后会多占一个 `WorkspaceHandle`，直到任务跑完。同一项目里 handle 的数量因此可能增加，上限仍由用户能同时开的会话数决定。

停靠的会话里任务跑完，结算会叫醒它；如果会话在预算耗尽后降级为注入、没被叫醒，handle 要等下一次这个会话的回合结束才会被释放。没有主动轮询。

匿名 job 的引用依赖 `onUpdate` 存在：pi 不传 `onUpdate`（例如非交互模式）时不发，界面没有可跟随的 job，行为和之前一样。

`bash` 在 Windows 上就是 PowerShell（`annotateWindowsBashTool`），DSH 的 `pwsh-local` 里的执行器细节（`pwsh -NoLogo -NoProfile -NonInteractive -Command`、UTF-8 固定、stdout / stderr 分流）这次没动：我们的执行走沙箱 `operations.exec`，stdout 和 stderr 合成一路回调，这是 `bashJob.ts` 开头已经记下的差异。
