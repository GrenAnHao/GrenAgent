# Agent Note: bash 是自有实现：每次调用都是 job，前台超时转后台

Status: implemented

## Problem

sandbox 扩展 2026-09-12 起自持 spawn 的 BashOperations（667c7cf8）并注册 bash / user_bash / bash_escalate（d5d90c43，规格 `docs/superpowers/specs/2026-09-12-os-sandbox-design.md`）。

### bash 改为自有实现：每次调用都是 job，前台超时转后台，界面跟随后台输出

上一篇把 DSH 的 jobs 体系和 `run_in_background` 搬了过来，但留了两处：模型没想到加 `run_in_background` 的长命令仍然整轮阻塞（那次 15 分钟的 Chromium 构建就是这样）；后台 job 的输出只有模型能经 `job_output` 看到，卡片上看不见。前者绕不开 pi 的 `createBashToolDefinition`：它的 execute 要等 `operations.exec` 结束才返回，没法在中途把进程交出去。pi 的 bash 在 CHANGELOG 里一直有修复，但我们早已用同名工具覆盖内置 bash、进程也走自己的 operations，只剩 execute 这一层还在复用。

### 后台任务跟着会话走，前台命令的匿名 job 把实时输出和停止接到卡片上

要求后台任务不做全局，由启动它的会话各自承载，并且照 DSH（`packages/jobs/*`、`packages/shell/tool-pwsh`、`packages/client/ui-tool` 的 `LiveShellOutput`）的做法来。对照下来有两处差距。

第一，归属在数据上是对的：`jobs.start` 记 `owner = sessionId`，`list` / `read` / `kill` 都按 owner 围栏，界面卡片也只出现在启动它的会话的时间线里。但生命周期不对。jobs 扩展在 `session_shutdown` 里 `detachOwner` 取消该会话名下的全部任务，而 pi 的 `switchSession` / `newSession` 会先 `teardownCurrent`，原地发出 `session_shutdown`。`PiRuntimeService` 只在前景会话正在流式时才停靠 handle，回合一结束、只剩后台任务在跑的会话，用户切到另一个会话，它的任务就被一并取消了。DSH 里多个会话并存，切换不销毁。

第二，DSH 的前台命令也是 job，但是匿名的：模型拿不到 id，命令在超时内结束就连记录一起移除。界面上运行中的卡片不靠工具更新，而是找到这条命令对应的运行中 job，读它保留的输出来画卡片。我们的 `bashJob.ts` 前台命令已经注册成 job 了，运行中的前台卡片却只吃 pi 的 partial 更新，界面不知道这个匿名 job，所以重载后拿不到保留输出，也没法单独停止这一条命令。

## Decision

### bash 改为自有实现：每次调用都是 job，前台超时转后台，界面跟随后台输出

- bash 改为自有实现（`bashTool.ts`）。对外契约照 pi 1.0.2：工具名、`command` / `timeout` 参数、结构化结果 `{ output, truncated, full_output_path, exit_code, wall_time_seconds }`、截断提示 `Full output: <路径>`、`Command exited with code N` 标 isError、`Command aborted`、流式更新只放尾部、`PI_*` 会话环境变量、strict-prefer 约束采样。截断算法直接用 pi 导出的 `truncateTail`；累积器（`bashOutput.ts`）照抄 `output-accumulator.js`，另加按字节偏移的保留窗口作为 jobs 拉取源。`bashTool.test.ts` 是钉住这些格式的契约测试。
- 执行照 DSH tool-bash：每次调用先注册成 bash job，前台只是等它。等到 `timeout`（默认 120 秒，`BASH_FOREGROUND_TIMEOUT_SEC` 可改）仍在跑，就做一次消耗式读取把已有输出交给模型，附 `[still running after Ns; moved to background job bash-N]`，命令留在后台，结束时照常发通知。等待期间结算的，结果随本次调用交付并移除记录（awaited，不发通知）；调用被中止则停掉 job 并按 pi 抛 `Command aborted`；外部停止（界面、job_kill）抛 `Command stopped: <原因>`。会话 id 缺失或准入被拒（每会话 10 个）时退回 pi 原来的前台执行，`timeout` 到点杀。
- 界面跟随：注册表加 `onEvent`（registered / output / progress / stopping / settled / removed）。主进程 `jobsBridge` 用 `createJobObserver` 订阅，输出事件按 100ms 合并，以非消耗 `readAt` 取增量经 `pi://jobs` 推帧；卡片先用 `job_snapshot` 拿保留输出再接帧，按字节偏移对齐，断档重拉快照。bash 结果 details 带 `jobId` + `jobStartedAt`（进程内 id 重启后会复用），卡片据此跟随，底栏给状态与停止（`job_kill`，原因记 `cancelled by the user`，模型照常收通知）；job 不在了回退到工具结果文本。
- 上一篇里 jobs 注册表、tool-jobs 语义、通知格式的移植全部保留；本篇推翻的是其中「不做前台超时转后台」和「界面跟随不接」两点。

### 后台任务跟着会话走，前台命令的匿名 job 把实时输出和停止接到卡片上

会话承载：`PiRuntimeService` 加 `hasLiveJobs(sessionId)` 选项（`main.ts` 接 `jobs.hasLive`）。`agent_switch_session` / `agent_new_session` 时，前景会话空闲但名下有存活后台任务，也走原来的停靠：另开一个 handle 当前景，旧 handle 留在后台继续跑。停靠的会话回合结束后，`releaseIdleParked` 看到它名下还有存活任务就不拆；任务结算会叫醒会话，那一轮跑完再走到这里，任务都结束了才释放。宿主不支持停靠时退回原地切换，不为这个拒绝用户切会话。`fork` / `rewind` 本来就会改前景那份，不在此列。

前台匿名管道：工具侧，前台命令的 job 一启动，就在 partial 更新的 `details.foregroundJob` 里带上 `{ jobId, jobStartedAt }`，之后每次输出更新也带着（partial 每次整体替换 result）。partial 不进模型上下文，最终结果仍然没有 id，所以模型看不到，超时转后台才把 id 交给它，这条行为不变。界面侧，运行中的前台 bash 卡片读 `foregroundJob`，用已有的 `jobLiveStore` 跟随这条 job：输出来自 `pi://jobs` 帧，底栏只写状态、不写 id，并给「停止」，点它只发 `job_kill`，只结束这条命令，工具那边会给模型 `Command stopped: cancelled by the user`。找不到 job（重载后记录已离开、快照在路上）时静默回退到 partial 文本，不说「任务已不在」。命令结束后工具结果是同一条消息被更新，卡片不重新挂载，展开状态保持。

### 涉及文件

- `extensions/sandbox/bashTool.ts`
- `extensions/sandbox/bashJob.ts`
- `extensions/sandbox/bashOutput.ts`
- `extensions/sandbox/index.ts`
- `extensions/jobs/service.ts`
- `extensions/jobs/observer.ts`
- `electron-agent/electron/app/jobsBridge.ts`
- `electron-agent/electron/ipc/register.ts`
- `electron-agent/src/stores/jobLiveStore.ts`
- `electron-agent/src/features/tools/BashJobTerminal.tsx`
- `electron-agent/electron/app/piRuntimeService.ts`
- `electron-agent/electron/main.ts`
- `electron-agent/src/features/tools/bashCardModel.ts`
- `electron-agent/src/features/tools/ToolExecution.tsx`
- `extensions/jobs/types.ts`
- `extensions/jobs/ring.ts`
- `extensions/jobs/pump.ts`
- `extensions/jobs/render.ts`
- `extensions/jobs/notice.ts`
- `extensions/jobs/index.ts`
- `extensions/sandbox/background.ts`

### 来源

- `docs/decisions/extensions/2026-10-05-own-bash-promote-and-live-jobs.md`
- `docs/decisions/electron-agent/tools/2026-10-05-bash-jobs-follow-session-and-foreground-pipe.md`
- `docs/decisions/extensions/2026-10-04-jobs-dsh-port-bash-background.md`（已被取代）
- 667c7cf8
- d5d90c43

## Alternatives considered

### bash 改为自有实现：每次调用都是 job，前台超时转后台，界面跟随后台输出

- 继续包 pi 的 execute，让 `operations.exec` 在超时时提前 resolve：pi 会把半截输出当正常退出，退出码只能伪造，模型和 codemode 的结构化结果都会误判。
- 超时转后台只在模型显式给 `timeout` 时生效：长构建正是模型没想到设 timeout 的场景，默认关等于没做。
- 保持 pi 的默认无超时：前台不设上限就回到整轮阻塞；DSH bash-local 默认 120 秒，照搬。
- 界面轮询 job 列表（子代理面板的做法）：输出跟随要字节增量，轮询要么延迟大要么空转；推帧加快照兜底更省。
- 界面复用 `job_output`：那是消耗式读取，会抢走模型的游标，通知是否已送达的判断也跟着乱。
- 后台输出另开 dock 标签页：卡片就是这条命令所在的位置，先在卡片里跟随，入口只有一处。

### 后台任务跟着会话走，前台命令的匿名 job 把实时输出和停止接到卡片上

- 照 DSH 按 kind + label（命令文本）匹配运行中的 job：同一个会话里并行跑两条相同命令时只能挑最新的，会跟错；我们的工具本来就知道 id，显式带引用更准。
- 把前台任务的 id 放进最终结果或模型可见的文本：破坏「匿名」，模型会开始 `job_output` 一个它不该管的 id，还会让结果多出每次都变的噪声。
- 给 `jobs` 扩展的 `session_shutdown` 加「按 reason 区分」，切换会话时不取消任务：`detachOwner` 之后 `owners` 里的通知投递也被删掉，任务还活着却没人接收结算；并且 handle 里的 session 对象被替换，保留任务就得自己再管一份会话引用。停靠整个 handle 是现成的、同一套路。
- 所有切会话都停靠：空闲会话原地切换更便宜，停靠要多开一个 handle 和一套会话，只有名下有存活任务才值得。
- 做一个全局的后台任务面板或角标：和「任务由会话各自承载」相反，没做。

### 已被取代的旧决定：jobs 按 DSH 移植输出环与结算语义，bash 增加 run_in_background

- 照 DSH `jobs-local` 移植注册表：每个 job 一个 `OutputRing`（绝对字节偏移，运行期 256KB、结算后 16KB，模型未读的字节保留到首次终态读取），拉取源由 `startPump` 每 150ms 泵入、结算前再排干一次；模型用消耗式游标读，`readAt` 非消耗；`wait` 与读取分开；kill 原因合并进 killed 的 detail；每个 owner 最多 10 个存活 job；`detachOwner` 以 teardown 原因结算并删记录，cancel 抛错时强制 failed。
- 照 DSH `tool-jobs`：`job_output` 先输出（无新输出写 `(no new output)`）、末尾状态行 `[status: <status>, <detail>]`，按生产方 `outputLimitBytes` 保留尾部；结算通知跳过等待释放的（awaited）、模型自己 `job_kill` 的、teardown 的。
- 照 DSH `tool-bash`：bash 增加 `run_in_background`，命令在 `run()` 里经同一套沙箱 operations 起，非零退出记 completed + `exit code: N`，被取消记 killed，拿不到退出码记 failed。
- 兼容本仓库：`JobsService.read(id, caller, { wait })` 保留为「可选等待 + 一次消耗读取 + 渲染」，multi-agent 不改；终值 job 的通知仍把结果内联；通知首行格式不变（界面 `JobDonePill` 用正则解析），流式 job 在第二行给 DSH 状态行和 job_output 指引。
- 与 DSH 的差别：沙箱 exec 把 stdout / stderr 合成一路，bash job 不分通道；完整日志总是写临时文件并在开始结果里给出路径（DSH 只在超出保留窗口时 spill）；不移植 scope 分层与 controller 准入（本进程只有一套组合，jobs 总随 sandbox 加载）。

当时放弃的方案：

- 前台超时自动转后台（DSH `promoteOnTimeout`）：要把前台 bash 改成「每次都是 job、前台只是等它」，等于重写 pi 自带 bash 的流式更新、尾部截断和临时文件逻辑，卡片的流式行为也要跟着重测。这次先只做显式的 `run_in_background`，靠 guideline 引导长命令用它。
- 给 operations.exec 加分通道回调，让 bash job 分 stdout / stderr：受限 runner 路径要一起改，合流顺序对构建日志反而更直观。
- 保留 `readOutput()` 推模型、不引入环：没有偏移就做不了非消耗的观察者读取，界面以后要跟随后台 job 输出时还得再推翻一次。
- 新增独立的 `bash_background` 工具：多一个 schema，模型要在两个工具间选；DSH 与 Claude Code 都是 bash 上的一个布尔参数。

## Consequences

### bash 改为自有实现：每次调用都是 job，前台超时转后台，界面跟随后台输出

pi 后续对 bash execute 的修复不再自动生效，基线是 pi 1.0.2 的 `dist/core/tools/bash.js` 与 `output-accumulator.js`，升级 pi 时 diff 这两个文件，契约测试红了说明官方改了对外格式。`timeout` 的语义从「到点杀」变成「到点转后台」，要杀用 `job_kill`；挂死的命令会留在后台占名额，直到会话关闭或被停。pi 的 TUI 渲染器（`createShellRenderers`）没带过来，CLI 交互模式下 bash 走通用渲染。界面只跟得到主进程里的 job，goal / system worker 进程里的看不见。应用重启后 job 全部消失，卡片回退到工具结果文本。

### 后台任务跟着会话走，前台命令的匿名 job 把实时输出和停止接到卡片上

有存活后台任务的会话被切走后会多占一个 `WorkspaceHandle`，直到任务跑完。同一项目里 handle 的数量因此可能增加，上限仍由用户能同时开的会话数决定。

停靠的会话里任务跑完，结算会叫醒它；如果会话在预算耗尽后降级为注入、没被叫醒，handle 要等下一次这个会话的回合结束才会被释放。没有主动轮询。

匿名 job 的引用依赖 `onUpdate` 存在：pi 不传 `onUpdate`（例如非交互模式）时不发，界面没有可跟随的 job，行为和之前一样。

`bash` 在 Windows 上就是 PowerShell（`annotateWindowsBashTool`），DSH 的 `pwsh-local` 里的执行器细节（`pwsh -NoLogo -NoProfile -NonInteractive -Command`、UTF-8 固定、stdout / stderr 分流）这次没动：我们的执行走沙箱 `operations.exec`，stdout 和 stderr 合成一路回调，这是 `bashJob.ts` 开头已经记下的差异。

## Verification

verify: n/a 回填的历史决定，源记录（docs/decisions）未记录验证
