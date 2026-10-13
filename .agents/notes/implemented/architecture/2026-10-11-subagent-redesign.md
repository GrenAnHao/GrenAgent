# Agent Note: 子代理重新设计：统一 Activation 管理器 + 可插拔执行后端

Status: implemented

本笔记取代并吸收 [2026-10-11-all-subagents-out-of-process.md](../../rejected/architecture/2026-10-11-all-subagents-out-of-process.md)（该提案已否决，见 rejected/；「全部进程外」不再作为前提，而是作为后端选项之一）。

## Problem

Pi 现在的子代理是一路叠加出来的，没有统一的模型（见 [2026-09-13-subagent-activation-and-routing.md](../../implemented/architecture/2026-09-13-subagent-activation-and-routing.md)）：

- **两条执行路径、能力不对等**。`extensions/multi-agent/index.ts` 的 `executeSubagent` 用 `canUseEmbeddedSubagent`（`embedded-runner.ts:187`）分叉：内嵌 Activation（`activation.ts`、`embedded-runner.ts`）能续聊、能 fork，不能 worktree；worker（`runner.ts`，`spawn(process.execPath, [PI_WORKER_ENTRY, --mode json, -p …])`）能 worktree，不能续聊、不能 fork，结果靠解析 stdout JSONL，靠空闲 / 首字节 / 静默完成等多种超时兜底。
- **没有统一的身份和状态**。内嵌子代理有 sessionPath，worker 只有进程；名额、注册表、重启回收分散在 `registry.ts`、`subagentProcessRegistry.ts`、`reap-continuable.ts`、`restart-reap.ts`、`inbox.ts`、`jobs`。
- **结果交付方式混杂**：前台 run、后台 `spawn` + `job_output`、continuable + `send_message`、settlement notice（`settlement-notice.ts`、`parent-host.ts`）并存。
- **约束靠特判**：worktree 不支持并行和 chain（`index.ts:885`、`index.ts:~913`），fork 必须进程内（`index.ts:881`）。
- **资源**：内嵌子代理和所有工作区的主 agent 共用 agent-host 一个事件循环（[2026-10-09-agent-host-child-process.md](../../implemented/architecture/2026-10-09-agent-host-child-process.md)），子代理多了会再次出现卡顿。

## Decision

子代理由一个管理器统一调度（`extensions/multi-agent/manager.ts`）：所有执行都从这里进，先选执行后端，再由后端声明能力。五件事不再由「跑在哪」决定，而由能力声明决定：续聊、fork、worktree、并行、chain。下面是落地后的现状，各阶段改动的细节在第 11 节。

- **两个后端，同一套 runner**：
  - 进程内（默认）和 worker（独立的 `pi-worker --mode subagent` 进程，经 IPC RPC 驱动）都是真会话：有 JSONL，能续聊、能 fork、能结构化输出。
  - 超时看门狗、Activation、收件箱、结算通知、`wait_agent` 登记都只有一份代码。
  - 只有设置 `SUBAGENT_BACKEND=worker` 或命名角色写了 `backend: worker` 才走 worker；同时运行的 worker 进程上限 2，超出排队。
- **结果交付只有两种**：
  - 前台 `run` 等结果；后台 `spawn` 立刻返回 `agentId`，结束后父会话收到 `subagent-settled` 通知。
  - 没有父会话宿主的（CLI、worker 进程里的父会话）改由发起 spawn 的会话自己的扩展 API 投递。
  - `wait_agent` 等任意一个后台子代理结算，只给摘要。子代理不再走 jobs。
- **worktree 是显式工具**：
  - `create_worktree` 在 `<仓库根>/.agents/worktrees/<name>` 建分支和 checkout，再把调用者自己会话的工作目录切过去；`working_directory` 读或换目录，也用来离开 worktree。
  - 委派不再隐含隔离，子代理继承调用者的当前目录。
  - 审批、沙箱可写根、注册表、记忆等「项目身份」固定在会话的原始目录。
- **消息与续聊**：`send_message`（父 ↔ 直接子）、`interrupt_agent`、`list_agents`（从父会话 JSONL 里的子代理目录列出，重启后照样有）。结算后的进程内子会话留在驻留池（默认 8 个）；不在池里的按 JSONL 冷恢复，worker 子代理冷恢复回 worker。
- **资源**：
  - 同时活跃的子代理上限 8（嵌套的只计数不排队）。
  - agent-host 每 10 秒的诊断采样带上在跑的子代理；8 个进程内子代理并发时实测事件循环 p99 148 ms。
- **安全**：safety 只读会话配置，不再先读 `process.env.SAFETY_*`。父会话的限制叠加到子代理上：deny 取并集，只读向下传，写白名单只收窄。

第 0～10 节是设计依据：参考系统的做法、对 Pi 和 SDK 的核查、用户确认的取舍。这几节保留提出时的写法，和落地不一致的地方已就地注明。设计里确认过、但没有排进这四个阶段的几项，后来各自单独落地，见文末「设计里确认过、四个阶段之外的」那一条。

### 0. 两个参考系统的要点（带出处）

**DSH（`D:\System Dir\Downloads\deepseek-harness`）**：
- 主文档 `docs/subsystems/subagent.md`；迁移说明 `docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.md`；笔记 `.agents/notes/implemented/simplification/2026-09-17-unified-subagent-activations.md`、`.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md`、`.agents/notes/implemented/architecture/2026-09-01-parent-owned-subagent-catalog.md`、`.agents/notes/implemented/feature/2026-08-15-product-subagent-noninteractive-permissions.md`。
- 所有后端只走一个入口 `startActivation(spec)`；`SubagentManager` 统一管身份预留、名额、输入准入、冷恢复、子先父后的释放。
- Provider 只贡献两种东西之一：`prepareContinuable()`（本地子会话，只返回「是否用父历史做 seed」这种**数据**）或 `start()`（外部执行，返回一个 `SubagentRun` 句柄，一次性，不能续聊）。能力用 `SubagentCapabilities` 声明，启动时校验，不支持就直接拒绝。
- 交付二选一：`delivery: 'parent'`（结束后给父会话发 settlement notice）或 `'caller'`（程序 await `activation.result`，不发通知）。删掉了前台结果、后台 job、`run_in_background`。
- 本地子代理有持久 Session，「最多一个活 Activation」；不活跃的可以从持久化冷恢复后继续收消息。
- 消息只允许相邻（直接父 ↔ 直接子），运行中按 step 边界 steer，空闲则开新一轮，不在内存则冷恢复。
- 父会话持有子代理目录（catalog，写进父会话事件），`list_agents` 只报 `running` / `inactive`。
- 结果统一为 `SubagentResult { output, structured?, diagnostic?, stopReason }`，子级失败不 reject，只走 stopReason。
- `interrupt` 只停当前执行，保留 Activation 和排队消息；`drainDescendants` / `drainChildren` 负责子先父后的收尾。

**Codex（`D:\System Dir\Downloads\codex\codex-rs`）**：
- 控制面 `core/src/agent/control.rs`（`LocalAgentControl`）与 trait `core/src/agent/api.rs`（`AgentControl`，本地 / host 后端可替换）；生成 `core/src/agent/control/spawn.rs`；子配置 `core/src/agent/child_config.rs`、角色 `core/src/agent/role.rs`；注册表与深度 `core/src/agent/registry.rs`。
- 子代理是同一进程里的**线程（thread）**，共享一棵 agent 树的 `LocalAgentRuntime`（`control/runtime.rs`）；身份 = ThreadId + `agent_path` + 昵称 + 角色（`agent/types.rs` 的 `AgentMetadata`）。
- 名额：生成前 `reserve_spawn_slot(max_threads)` 预占（`control/spawn.rs:705-735`）；深度上限 `exceeds_thread_spawn_depth_limit`（`registry.rs:85`）；`PendingSpawn` 守卫在初始输入被接受之前持有子代理，失败自动回收（`control/spawn_guard.rs`）。
- **驻留（residency）**：空闲子代理可以被卸载、状态保留，需要时再载入（`control/residency.rs`）；卸载期间的消息进邮箱（`control/mailbox.rs`）。
- 工具（`tools/handlers/multi_agents_v2/*`，描述在 `tools/handlers/multi_agents_spec.rs`）：`spawn_agent`（`fork_turns: all | none`）、`send_message`（只投递、不触发新一轮）、`followup_task`（空闲则触发一轮）、`wait_agent`（等任意子代理的邮箱更新，只返回摘要、不返回正文，有最小/最大超时）、`interrupt_agent`（停当前轮，代理保留）、`list_agents`、`close_agent`（v1）。
- 完成通知：子代理终态由控制面路由给父线程（`control/completion.rs`、`context/subagent_notification.rs`），投递是 best-effort。
- fork：继承父历史时给子代理加一段说明「之前的身份、任务和**针对具体动作的审批**都属于祖先；继承的工具调用只是历史，进程句柄不继承」（`control/spawn.rs:1290`）。
- 权限：子代理继承父的 exec policy / 审批策略（`control/spawn.rs:419-445`、`:473-621`）；角色只能收窄能力，不能替代父会话的授权（`role.rs` 头注释）。

**对照 Pi**：两者都是「**一个管理器 + 统一身份 + 统一状态**」，执行方式只是后端细节；Pi 现在反过来，执行方式决定了能力。两者默认都在**进程内**跑子代理，进程外只用于外部 / 远程后端（DSH 的 Codex / Claude Code / ACP / DSH SDK provider；Codex 的 host backend）。

### 1. 目标 / 非目标

目标：
- 一个 `SubagentManager`、一个入口、一套身份和生命周期，执行后端可插拔。
- 续聊、fork、worktree、并行、chain 的组合不再由「跑在哪」决定，而由后端能力声明决定，不支持就明确报错。
- 结果交付只有两种（父通知 / 调用方 await），删掉后台 job 收集子代理的路径。
- 重启可恢复：子代理目录与状态可从持久化重建。
- 子代理不拖垮 agent-host 事件循环。

非目标：
- 不做跨机器 / 远程子代理。
- 不在本笔记里重写 agent-host 的 RPC 协议，只复用。
- 不做 Agent Teams（多代理对等协作）。

### 2. 核心抽象

- **身份**：`childId` = 子会话 sessionId（持久），外加 `parentId`、`depth`、`label`（短任务名）、`role`、`backend`。借鉴 DSH 的 catalog 与 Codex 的 `AgentMetadata`。
- **Activation**：子代理的一次「活着的执行」。一个子代理同一时刻最多一个 Activation（DSH）。
- **Catalog**：父会话 JSONL 里记录子代理成员（创建时写入，不记录执行状态）。`list_agents` 从 catalog + 运行时状态投影出来（DSH `listChildren`）。
- **生命周期状态**：`reserved → starting → running ⇄ idle → settled（completed | aborted | error | max-tokens | refusal）`；另有 `evicted`（空闲已卸载、可冷恢复，借鉴 Codex residency）和 `closed`（释放后不可再续聊）。stopReason 采用 DSH 词表。落地时没有单独做状态机：`list_agents` 只报 running / inactive，「已卸载」由驻留池和子会话 JSONL 体现（第 11 节阶段 4）。
- **后端（Backend）**：
  - `in-process`：在 agent-host 内用 Pi SDK 建子会话（即现在的 Activation），可续聊、可 fork、可在 worktree 里跑（调用 `create_worktree` 切换会话目录，见第 3 节）。
  - `worker`：独立进程（复用 agent-host 的 `rpcPeer.ts` / `contract.ts` 风格的 RPC，**不再**解析 stdout JSONL），可续聊（常驻）、可 fork，也能在 `create_worktree` 切过去的目录里跑。
  - （以后）外部 CLI / ACP：一次性，不能续聊（DSH `start()` 语义）。
  - 每个后端声明能力：`continuable`、`fork`、`outputSchema`、`toolFilter`、`modelOverride`。原先列的 `worktree` 在第 2.5 阶段去掉：worktree 改成显式工具后和后端无关。

### 3. 进程 / 隔离模型与建议

建议：**默认进程内；worktree 是与后端无关的能力，靠每会话 cwd 实现；worker 只用于需要进程级隔离的场景。**

- 默认 `in-process`：两个参考系统都这样做，启动快、续聊和 fork 天然支持。
- **worktree 不需要独立进程。** 两个参考系统都没有「子代理自动 worktree」：
  - DSH 用每会话 working directory（`.agents/notes/implemented/architecture/2026-09-13-session-working-directory.md:13,19,37`），子代理接收父的当前目录或显式 `request.cwd`（`docs/subsystems/subagent.md:11`、`packages/subagent/subagent/src/manager.ts:413,492`）；worktree 是显式工具 `create_worktree`，只切换会话目录，不开新进程（`.agents/notes/implemented/feature/2026-09-13-explicit-worktree-creation.md:13-17`），并明确否决「委派时自动隔离」（同文件 `:27`；`2026-08-05-agent-teams.md:55,73`）。
  - Codex 子代理继承父 turn 的 cwd 与权限档（`core/src/agent/child_config.rs:183-199`、`core/src/agent/control/spawn.rs:419-450`），`spawn_agent` 没有 cwd 参数，没有 worktree。
- **决定（用户确认，2026-10-11）：照 DSH，worktree 改为显式工具 `create_worktree`，与委派解耦。**
  - 工具只做一件事：从当前仓库的已提交版本建新分支和 checkout，然后把**调用者自己会话**的工作目录切过去。主 agent 和子代理都可以调用；委派本身不再隐含隔离。
  - 目标设计里删除 `profile.isolation: "worktree"`，管理器不再负责创建 worktree 和出 diff。
  - 离开 worktree 用普通的切换目录操作，checkout 和分支保留，不自动删除、不自动合并（DSH `2026-09-13-explicit-worktree-creation.md:19,23`）。
  - DSH 在这些相关点上的做法（供 Pi 落地参考）：
    - 位置：默认放在当前 checkout 顶层的 `.agents/worktrees`，在 linked checkout 里也是如此；首次创建时写一个自忽略的 `.gitignore`（同文件 `:15`）。
    - 权限：用已挂载的子进程和沙箱 provider 执行 git，不扩大调用者的权限；目标目录和共享的 git 元数据目录都必须本来就允许写（同文件 `:17,29`）。会话身份和原始沙箱根不变（同文件 `:17`）。
    - cwd 切换后跟着变的：项目指令、skills、补全、文件工具与子代理默认目录；不变的：已存在的进程、终端、常驻 shell 保留各自的进程目录（`2026-09-13-session-working-directory.md:19-23`）。
    - MCP：Playwright / Chrome DevTools 这类 MCP 在获取连接时按当时的有效目录启动，之后切换目录**不重启**已保留的服务器（同文件 `:25`）。
    - 历史记录里的文件链接和命令目录用执行当时记下的元数据，切换后旧行仍正确（同文件 `:27`）。
- **worker 的理由**（不再包括 worktree）：
  1. 崩溃隔离，仅限进程内**挡不住**的那几类：同步死循环、OOM、原生模块崩溃（见下方「崩溃隔离」）。普通的异常、拒绝、工具出错、模型卡住在进程内就能收住，不需要 worker；
  2. 负载：大量或长时间运行的子代理不占 agent-host 的事件循环；
  3. 进程级环境：需要不同的 `process.env`、不同的 OS 沙箱账户 / 进程令牌、或不同 Node 运行参数时。
- 决定（用户确认）：worker 每个子代理一个进程，不做池；不按负载自动挪到 worker，超出名额就排队；只有设置 / 角色指定时才走 worker。

取舍：进程内会和 agent-host 抢事件循环，靠第 6 节的名额与驻留控制；进程外启动慢、内存高，但隔离好、崩溃不连坐。

#### 崩溃隔离（进程内子代理）

**DSH 怎么做（读源码，2026-10-11）**——DSH 子代理在进程内运行，靠的是「每一层都把错误变成结果」，而不是进程隔离：
- 智能体循环的驱动边界吞掉并上报错误：`packages/core/agent-loop/src/agent.ts:244-256`（`throwError` 先发 `agent/error` 再抛，`kick()` 的 try/catch 在驱动边界收住）；每次运行一个 `AbortController`（同文件 `:229`）。
- 工具异常变成工具错误结果，不往上抛：`packages/core/tools/src/index.ts:1583-1593`（另见 `:1485,1543,1635,1663`）。
- 子代理失败记成 `stopReason: 'error'`，不 reject：`packages/subagent/subagent/src/activation.ts:130-161`（`observeLocalFailure` 记下 `failureAt`，`captureLocalResult` 据此给出 error）。
- 释放按「子先父后」，每个边界单独 try/catch，失败聚合成 `ACTIVATION_TEARDOWN_FAILED`，但仍归还名额、发结算通知、结束结果：`packages/subagent/subagent/src/manager.ts:1090-1180`。所有「发出去不等」的 promise 都挂了 `.catch`（同文件 `:226,336,367,870,938`）。
- 全局兜底**反而是让进程退出**：`packages/boot/app-boot/src/index.ts:717-728` 的 `installFailLoud` 把 `unhandledRejection` / `uncaughtException` 当致命错误，`exit(1)`（`:714`）。也就是说，漏网的错误不被吞掉，而是让整个进程崩溃。
- 外部后端（Codex / Claude Code / ACP / DSH SDK）才是独立进程，有统一的诊断长度限制和「结果从不 reject」约定：`packages/subagent/subagent/src/out-of-process.ts:1-30`。
- 没找到：子代理专用的步数 / 轮数上限、卡死 watchdog、内存或事件循环监控（只有持久化里的 `scheduler.yield()`，`packages/session/session-persistence-jsonl/src/generation.ts:404,686,891`）。没找到 ≠ 一定没有，只是这次检索里没有。

**Codex**：子代理是 tokio 任务里的线程（`core/src/agent/control.rs:560`、`control/residency.rs:59` 的 `tokio::spawn`）。Rust 里 panic 只会结束所在的 tokio 任务，不会结束进程；除此之外，Codex 子代理同样不防同步卡死、OOM、原生崩溃。

**Pi 现状**：
- 已有：
  - 进程内子代理的模型卡住处理：首字节超时、流停顿中断并续跑、重试次数（`extensions/multi-agent/embedded-runner.ts:106,505-506`，`SUBAGENT_STREAM_STALL_MS` / `SUBAGENT_FIRST_TOKEN_MS` / `SUBAGENT_STALL_RETRIES`）；
  - Activation 的结果捕获与 `aborted` 结算（`extensions/multi-agent/activation.ts:201-229,392`）；
  - agent-host 整个崩溃后，主进程重启它，带限流（`electron-agent/electron/agentProcess/agentProcessClient.ts:245-267`，`recordCrash`）。
- 和 DSH 相反的一点：agent-host 对 `uncaughtException` / `unhandledRejection` **只打日志、继续运行**（`electron-agent/electron/agentProcess/hostEntry.ts:63-64`）。好处是一个子代理的漏网错误不会杀掉所有工作区；坏处是进程可能带着坏状态继续跑，而且出错的子代理不会被结算，会一直显示「运行中」。
- 缺少：
  - 漏网错误与具体子代理的对应（不知道是谁出的错）；
  - DSH 那样的「每个释放边界单独 try/catch，失败也照样归还名额并结算」；
  - ~~工具异常是否全部被 Pi SDK 转成错误结果~~：已核查，见下。

**SDK 的工具异常处理（pi-agent-core 1.1.0 `dist/agent-loop.js`，pi-coding-agent 1.1.0）**：
- 找不到工具 → 错误结果（`agent-loop.js:482-488`）。
- 参数准备、参数校验（`validateToolArguments`）、`beforeToolCall` 抛异常 → 全在 `prepareToolCall` 的 try/catch 里转成错误结果（`:490-539`）；`beforeToolCall` 返回 block 也是错误结果（`:507-516`）。
- `tool.execute` 抛异常 → 错误结果（`:573-593`）。
- `afterToolCall` 抛异常 → 错误结果（`:601-631`）。
- 输出被 token 上限截断的工具调用 → 不执行，返回错误结果（`:342-360`）；中止 → 「Operation aborted」错误结果（`:435-442,500-505,519-524`）。
- 扩展事件处理器抛异常 → 由扩展 runner 捕获并经 `emitError` 上报，不往上抛（`pi-coding-agent/dist/core/extensions/runner.js:258-298,780-876`）。
- 以上都没接住的，在整轮运行的边界被 `runWithLifecycle` 捕获，结束本轮并给出 `stopReason: "error"` / `"aborted"` 的助手消息（`pi-agent-core/dist/agent.js:341-372`）。

**仍可能漏出去的**：
- 进度回调出错：`onUpdate` 返回的 promise 被拒时，`execute` 的 catch 分支里再次 `await Promise.all(updateEvents)`（`agent-loop.js:587`）会把这个拒绝抛出 `executePreparedToolCall`；它会被上面的整轮边界接住（本轮以 error 结束），不会成为漏网错误，但这次工具调用拿不到结果。（落地时查实：拒绝来自会话上同步抛错的监听方，工具结果整个丢掉，会话里没有这条工具结果；防护放在 Pi 挂的监听方上，见 [2026-10-12-session-listener-guard.md](../feature/2026-10-12-session-listener-guard.md)。）
- 工具或扩展里**不被 await 的异步工作**（定时器、事件回调、fire-and-forget promise）抛出的错误：不在任何 try/catch 里，成为进程级 `uncaughtException` / `unhandledRejection`，由 agent-host 记日志（`electron-agent/electron/agentProcess/hostEntry.ts:63-64`）。这就是上面建议 2 要用 ALS 归属到子代理的那一类。
- 同步死循环、OOM、原生模块崩溃：同上文，进程内挡不住。
  - 步数 / 轮数上限与卡死 watchdog。

**进程内挡不住的**：同步死循环（事件循环被占住，任何 JS 定时器都不会触发）、OOM（V8 堆满直接结束进程）、原生模块崩溃（如 node-pty、`@ast-grep/napi`、CodeGraph 的原生部分）。DSH 也不处理这些：它的全局策略是直接退出。Pi 目前唯一的防线是「agent-host 崩了由主进程重启」，代价是**所有工作区**的主 agent 一起中断。

**建议 Pi 采用**（落地情况：3～6 已按决定做完，见第 11 节；1、2 没做，转到后续笔记）：
1. 照 DSH：错误逐层转成结果。管理器的每个释放边界单独 try/catch，失败聚合但仍归还名额、发结算、结束结果（`stopReason: 'error'`）；所有 fire-and-forget 的 promise 都挂 `.catch`。
2. 保留 agent-host「记日志不退出」的策略（和 DSH 不同，因为 Pi 的 agent-host 里有所有工作区），但要用 AsyncLocalStorage（已有 `workspace-context.ts`）把漏网错误归到具体子代理，并把该子代理结算为 error。（落地时用了单独的一份 ALS，没有复用 `workspace-context.ts`，见 [2026-10-12-subagent-leaked-errors-and-teardown.md](../feature/2026-10-12-subagent-leaked-errors-and-teardown.md)。）
   - **决定（用户确认：照 DSH）：不做「重复出错就强制释放」。** DSH 没有这个机制：子代理的失败只记成 `failureAt` 并结算为 `stopReason: 'error'`，之后该子代理一旦有一轮正常结束就清除失败标记（`packages/subagent/subagent/src/activation.ts:130-141,154`），子代理保留、可继续收消息；漏网错误走进程级 fail-loud（`packages/boot/app-boot/src/index.ts:717-728`），没有按子代理计数或驱逐。Pi 照此：错误只结算为 error，不计数、不强制释放；要停由父 / 用户 `interrupt` 或关闭。
3. **决定（用户确认：照 DSH）：不设默认的步数 / 轮数 / 墙钟上限。** DSH 子代理没有这类上限：外部后端明确写着「No wall-clock timeout … the caller cancels long work」（`packages/subagent/subagent-codex/README.md:175`、`packages/subagent/subagent-claude-code/README.md:177`）；源码里只有释放时的宽限超时（`subagent-acp/src/run.ts:390`、`subagent-codex/src/run.ts:405`、`subagent-dsh-sdk` 的 `shutdownTimeoutMs` 默认 1000，`src/index.ts:80`）。DSH 的上限只有两种：同时活跃子代理数 `maxActiveSubagents` 默认 8（`packages/subagent/subagent/README.md:53-55`）和委派深度。Pi 照此：长任务由调用方取消；保留现有模型侧的首字节 / 流停顿超时（它们处理的是上游卡住，不是任务时长）。
4. 用 `perf_hooks.monitorEventLoopDelay` 监控 agent-host 事件循环（对应第 12 题的指标，已决定：p99 ≤ 200 ms @ 8 个并发子代理），超标时记录是哪些子代理在跑。
5. 进程内挡不住的三类，交给 worker：已知会跑重 CPU 或用原生模块的角色可在设置里指定走 worker。
6. **决定（用户确认：照 DSH）：agent-host 崩溃后不自动恢复子代理，按需冷恢复。** DSH 的 Session 和描述符跨重启保留，但 Activation、收件箱、所有权图都在进程内；进程崩溃时还在收件箱、没写进会话日志的消息会丢，**不会自动重放**；之后有授权的消息到来时才冷恢复该子代理（`.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md:57,142`；状态表 `:98` 「no Activation → cold-resume a new Activation」）。Pi 照此：重启后子代理在列表里显示为未运行，父或用户给它发消息时再从 JSONL 冷恢复；不做持久收件箱。
   - 与第 11 题的关系：DSH 冷恢复靠的是持久化的子会话 + 父会话里的子代理目录（catalog 写在父会话事件里，`.agents/notes/implemented/architecture/2026-09-01-parent-owned-subagent-catalog.md`）。照 DSH 做按需冷恢复，基本就意味着第 11 题选「父会话 JSONL」；但第 11 题本身用户尚未单独确认，这里只记为「倾向」，不视为已决定。

#### 核查：Pi 进程内子会话是否跟随每会话 cwd（2026-10-11，只读）

- **Pi SDK 内置工具（bash / read / write / edit）**：子会话用 `SessionManager.create(opts.cwd, …)`（`extensions/multi-agent/embedded-runner.ts:294`）和 `createAgentSessionServices({ cwd: opts.cwd, … })`（同文件 `:327-328`）建立，cwd 是每会话的。已核查 SDK（见下方「SDK 核查」），会跟随。
- **扩展的每回合上下文**：`runInWorkspace` 用 AsyncLocalStorage 携带 `{ workspace, cwd, config }`（`extensions/_shared/workspace-context.ts:15-28`），子代理的 ctx 是 `cwd: opts.cwd`，但 **`workspace` 取的是父会话的 workspace**（`embedded-runner.ts:265,274-275`）。没有 ALS 时回退 `process.cwd()`（`workspace-context.ts:27`、`activation.ts:472`）。
- **MCP**：管理器按 workspace 取实例（`extensions/mcp/manager.ts:432,808`，无 ALS 时回退 `process.cwd()`）。worktree 子代理会复用父工作区的 MCP 实例，MCP 服务器的工作目录仍是父仓库，不是 worktree。缺口。
- **SAFETY_\***：`getConfig` 先读 ALS 的 config（`extensions/_shared/runtime-config.ts:83`），子代理的 `SAFETY_*` 走 ALS，按会话生效。但 safety 扩展**先读 `process.env.SAFETY_*`**，再读 `getConfig`（`extensions/safety/index.ts:115,122-123`），agent-host 进程里一旦设了这些环境变量，就会压过所有会话。这是进程级状态泄漏的风险点。
- **沙箱可写根**：取自扩展上下文里的 cwd（`extensions/sandbox/index.ts:18-28`），审批档 / 模式也按这个 root 查（`getApprovalPolicy(root)`）。worktree 建在系统临时目录（`extensions/multi-agent/worktree.ts:44`，`mkdtemp(tmpdir(), "grenagent-wt-")`），不在原工作区下：可写根会变成 worktree，但审批档可能按陌生路径回落到默认值。已由第 4 题决定解决：审批按原工作区查。
- **（背景）为什么 `embedded-runner.ts:187` 拒绝 worktree**：这一行在 2905d766（2026-09-13「Phase 1 embedded session sub-agents (DSH alignment)」）引入，注释只写「not worktree (handled in index)」，没有记录原因。worktree 路径（`index.ts:1231` `createWorktree(ctx.cwd)`，`:1307` 出 diff）当时只接在子进程那条路上。推断（依据：commit 2905d766 / `embedded-runner.ts:186-190` / `index.ts:1231-1311`）：这是 Phase 1 的范围限制，不是技术上必须用独立进程；真正要补的是上面列出的 MCP、审批 root、`process.env` 优先这几个缺口。
- 决定（用户确认）：
  - worktree 位置：默认 `.agents/worktrees`（照 DSH，自忽略）。
  - MCP：切换目录**不重启**已有 MCP（照 DSH），`create_worktree` 的返回里提醒模型「已有 MCP 仍指向原目录」。
  - safety：只读会话配置（`getConfig` / ALS），去掉 `process.env.SAFETY_*` 优先；审批档 / 模式按**原工作区**查，不按 worktree 路径查。因此子代理 ctx 的 `workspace` 保持为原工作区（现状即如此，`embedded-runner.ts:265`），会变的只有 `cwd`。
  - worktree 位置不支持移到 OneDrive 之外（用户确认：只是本机情况），固定默认 `.agents/worktrees`。
  - `create_worktree` 的权限（用户确认：照 DSH）：不额外授权；目标目录和共享 git 元数据目录（`.git/worktrees`）都必须本来就可写，否则明确失败并说明是哪个目录不可写（DSH `explicit-worktree-creation.md:17,29`）。

#### SDK 核查（`electron-agent/node_modules/@earendil-works/*` 1.1.0，2026-10-11，只读）

**1. `process.cwd()` 调用点（pi-coding-agent `dist/`，不含 CLI 打包产物 `dist/bundle/`）**

| 位置 | 用途 | 进程内另一 cwd 的会话是否受影响 | 处理 |
|---|---|---|---|
| `core/sdk.js:70` | `createAgentSession` 的 cwd：`options.cwd ?? sessionManager.getCwd() ?? process.cwd()` | 否：Pi 显式传 cwd（`embedded-runner.ts:328`） | 保持显式传入 |
| `core/session-manager.js:1344,1364` | 打开会话 / `inMemory()` 的默认 cwd，优先用 override 或会话头里的 cwd | 否：Pi 用 `SessionManager.create(opts.cwd, …)`（`embedded-runner.ts:294`） | 冷恢复时要确保会话头里写的是该会话的 cwd，或显式传 override |
| `utils/paths.js:83` | `resolvePath(input, baseDir = process.cwd())` 的默认值 | 只在调用方不传 baseDir 时。会话 / 工具路径都传了 cwd：`core/tools/path-utils.js:43`、`core/tools/render-utils.js:19`、`core/resource-loader.js:521,796`、`core/prompt-templates.js:219`、`core/extensions/loader.js:525,685`、`core/package-manager.js:1843`；只传一个参数的都是本来就该是绝对路径的输入（cwd、agentDir，如 `agent-session-services.js:54-55`、`resource-loader.js:166-167,241-242`） | 无需改动 |
| `core/agent-session-runtime.js:259`、`core/export-html/index.js:205`、`core/session-export.js:26` | 导入 / 导出会话文件，相对路径按进程 cwd 解析 | 只影响用户手动导入导出且给相对路径的情况，不影响子代理 | Pi 调用时传绝对路径 |
| `extensions/mcp/index.js:208` | SDK 自带 MCP 扩展的初始 cwd | 否：`session_start` 时改为 `ctx.cwd`（同文件 `:975`）；而且 Pi 用自己的 `extensions/mcp`（`extensions/index.ts:22`） | 无需改动 |
| `main.js:464`、`package-manager-cli.js:737,826`、`cli/file-processor.js:18`、`cli/startup-ui.js:49`、`modes/interactive/bug-report.js:141`、`utils/photon.js:38` | CLI / 交互模式 / 打包资源查找 | 否：嵌入式 SDK 路径不走这些 | 无需改动 |

bash 工具按调用时的 `ctx.cwd` 起进程，退回工具创建时的 cwd（`core/tools/bash.js:50-64,158,174`），不读 `process.cwd()`。

结论：**SDK 侧会跟随每会话 cwd**；`create_worktree` 切换会话目录后，要让后续工具拿到新 cwd（会话目录作为会话状态，见阶段 2.5），SDK 本身不需要改。Pi 自己代码里的回退点（`extensions/_shared/workspace-context.ts:27`、`extensions/mcp/manager.ts:432`、`extensions/_shared/sandbox/provider.ts:105`）只在没有 ALS 上下文时触发，阶段 2.5 里保证进程内会话始终在 `runInWorkspace` 里运行即可。

### 4. 消息与续聊

借鉴 Codex 的工具划分 + DSH 的相邻规则：
- `send_message(target, content)`：父 ↔ 直接子。目标运行中 → step 边界 steer；空闲 → 开新一轮；已卸载 → 冷恢复后投递（DSH）。
- 决定（用户确认）：只有一个 `send_message`，带可选 `wake: false`（只投递、不唤醒空闲子代理）。四个阶段之后单独落地，见 [2026-10-12-send-message-without-waking.md](../feature/2026-10-12-send-message-without-waking.md)；已卸载的子代理也能收（宿主直接追加 JSONL），不报错。
- `interrupt_agent(target)`：只停当前轮，保留子代理和排队消息（DSH / Codex 一致）。
- 删除 `spawn` + `job_output` 收集子代理结果的路径（DSH 迁移指南的做法）。

### 5. 上下文传递 / fork

- `fork: "none" | "all"`（Codex `fork_turns`；DSH 的 seed 只接受完整已完成轮次前缀）。不做「最近 N 轮」（Codex v2 也只开放 all / none）。
- seed 取父会话**已完成轮次**的前缀（现 `fork-seed.ts` 的 `completedPrefix`），对 worker 后端经 RPC 传入。
- fork 时在子代理开头注入 Codex 那段说明：祖先的身份、任务、**动作级审批**不继承；继承的工具调用只是历史。
- cwd：取调用者当前目录。`spawn_agent` 没有 cwd 参数（用户确认，第 2.5 阶段）；要换目录，调用方先用 `working_directory` / `create_worktree`。

### 6. 并发与资源限制

- 名额在启动前预占、结束 / 关闭后归还（Pi 现有做法，与 Codex `reserve_spawn_slot` 一致），用 guard 保证初始输入被接受前失败也能回收（Codex `PendingSpawn`）。
- 深度上限保留（`depth.ts`）。
- 驻留上限：空闲的进程内子代理超过 N 个时，按最近最少使用卸载，状态在 JSONL 里，需要时冷恢复（Codex residency）。
- 决定（用户确认）：同时活跃子代理上限 8（照 DSH `maxActiveSubagents` 默认 8，`packages/subagent/subagent/README.md:53-55`）；空闲驻留 N=8；worker 进程上限 2。三者都放进设置可调。

### 7. 审批 / 权限

- 保留 Pi 现有规则：子代理继承父审批档，并把 `full` / `workspace` 下调为 `auto`（`index.ts` 里 `profileEnv.APPROVAL_POLICY`）。
- 角色 / profile 只能收窄能力，不能放大（Codex `role.rs`）。
- 子代理需要人确认时，审批请求带上子代理身份冒泡到父会话所在的窗口；worker 后端经 RPC 回到宿主。（更正：原稿说这是 DSH「product subagent noninteractive permissions」笔记的方向，写反了。DSH 的子代理审批固定为 never，转给父会话在 DSH 是推迟项，那篇笔记也明确不转发。）
- 决定（用户确认）：无人值守时等待审批，带超时；超时后按「被拒」事实返回给子代理和父，不重试、不降级为 auto。超时 60 秒（用户确认）。
- 落地情况：继承与收窄已做（第 2.5 阶段把父会话的只读、deny、写白名单也叠到子代理上）。冒泡和限时等待在四个阶段之后单独落地，推翻了 2026-09-14 的「子级审批固定为拒绝」，见 [2026-10-12-subagent-approvals-via-parent.md](../feature/2026-10-12-subagent-approvals-via-parent.md)。

### 8. 结果交付与父通知

- 统一 `SubagentResult { output, structured?, diagnostic?, stopReason }`（DSH）。子级失败不抛异常，靠 stopReason。
- `delivery: 'parent'`：工具立即返回 `{ childId }`，结束后给父会话注入一条 settlement 消息（现 `settlement-notice.ts`）；`delivery: 'caller'`：给工作流 / goal 等程序调用方 await，不发通知。
- 决定（用户确认）：过渡期保留单任务前台阻塞；最终全部非阻塞 + settlement 通知 + `wait_agent`（Codex 式：等任意子代理的更新，只返回摘要，带最短 / 最长超时）。DSH 已删掉前台、没有 `wait_agent`；这里在交付方式上跟 DSH，在 `wait_agent` 上借 Codex。第 2 阶段按用户确认保留前台阻塞。「最终全部非阻塞」后来改为：前台照旧阻塞，等待时用户引导（steer）就把还没完成的子代理转到后台（codemode 脚本和 chain 照旧要结果），见 [2026-10-12-foreground-run-detach.md](../feature/2026-10-12-foreground-run-detach.md)。

### 9. 取消、清理与重启恢复

- 取消：启动前由调用信号取消；启动后只通过 `dispose()` / `interrupt` 取消（DSH）。
- 清理：子先父后（DSH `drainDescendants`）；父会话关闭时关闭其子树（Codex `close_agent` 关闭后代）。
- 重启恢复：从 catalog + 子会话 JSONL 重建，正在运行的标为中断，可冷恢复续聊；worker 孤儿进程按注册表回收（合并现 `restart-reap.ts`、`reap-continuable.ts`、`subagentProcessRegistry.ts`）。

### 10. UI 事件

- 一套事件：`subagent/start`、`subagent/status`（running / idle / evicted）、`subagent/message`（流式快照）、`subagent/end`（带 stopReason）。worker 后端经 agent-host 的 `broadcast` 原样转发，渲染层不区分后端。
- 父会话侧栏从 catalog 投影（DSH sidebar 行由 catalog + 会话状态派生）。
- 落地情况：没有新增事件名。worker 子会话的事件由 `WorkerSessionProxy` 转成和进程内一样的会话事件，走原来的事件流，渲染层不区分后端（第 3 阶段）。侧栏和任务托盘仍读注册表（`registry.db`），没改。

### 11. 各阶段落地内容（含删除项）

- **阶段 1：立管理器，不改行为。** 新建 `extensions/multi-agent/manager.ts`（名称待定），把 `executeSubagent` 的分叉收进管理器，两条现有路径包成两个后端，声明能力。统一 `SubagentResult` 和 stopReason。
  - **已落地（2026-10-11，未提交）**，验证见文末「验证」：
    - `manager.ts`：放 `SubagentBackend` / `SubagentCapabilities` / `SubagentResult` 三个类型，以及 `selectSubagentBackend(profile)`、`runSubagent(...)`、`startContinuableSubagent(...)` 三个入口。`runSubagent` 的签名和原来的 `executeSubagent` 一样。`withDelegationScope` 改在两个入口里统一加，调用方不再各加各的（原来续聊分支是自己加的）。
    - `backends.ts`：`inProcessBackend`（包 `runEmbeddedSubagent` / `startContinuableEmbedded`）和 `workerBackend`（包 `spawnPiAgent`，`stopReason` 的推导从 `index.ts` 原样搬来）。能力照两条路径的现状声明：

      | 能力 | in-process | worker |
      |---|---|---|
      | continuable / fork | 是 | 否 |
      | worktree | 否 | 是 |
      | outputSchema | 是 | 否（`runner.ts` 的 `buildSubagentLaunch` 本来就会拒绝） |
      | toolFilter / modelOverride | 是 | 是 |

    - `index.ts`：
      - 删掉 `executeSubagent`，5 处调用改成 `runSubagent`。
      - fork 校验和后台续聊分支改成读 `selectSubagentBackend(profile).capabilities`，报错文案不变；不支持续聊时照旧退回一次性 job。
      - `canUseEmbeddedSubagent` 现在只在 `selectSubagentBackend` 里调用，第 3 阶段要删的分叉只剩这一处。
      - worktree 特判、名额、注册表、交付方式都没动（分别留给第 2 / 2.5 / 4 阶段）。
    - `SubagentResult` 按 DSH 加了 `diagnostic`：结果不是 completed 时，把 `error` 截到 4096 个 UTF-8 字节填进去，目前还没有地方读它。过渡期保留 `ok / exitCode / error / partial / transcript`，因为 `index.ts` 各路径还在读。
    - stopReason 的类型扩成 DSH 词表（多了 `max-tokens` / `refusal`），**映射不变**：pi 返回的 `length` 等值仍记成 completed。
      - 放弃的做法：现在就产出 `max-tokens` / `refusal`。最强理由是能一次对齐 DSH，父代理也能分清「被截断」和「正常结束」。没这么做，是因为这会改变父会话和界面看到的结果（例如 `settlement-notice` 对这两个值会落到「failed」那一句，原来是「finished」），违反第 1 阶段「行为不变」的前提。原计划留到第 2 阶段统一交付时一起改，但第 2 阶段确认的计划里没有这一项，所以还没做，留待单独决定。
- **阶段 2：统一交付。** 子代理工具改为返回 `{ childId }` + settlement 通知；新增 `wait_agent`。删除：后台 `spawn` + `job_output` 收集子代理的路径、`mode: "one-shot"` 的 job 分支。
  - **已落地（2026-10-12，未提交）**，验证见文末「验证」。用户确认的范围：`run`（单任务 / 并行 / chain）仍是前台阻塞，不改；jobs 里只给子代理用的代码这次就删；worker 后台运行只做单元测试，不实跑；cancel 不归还名额的 bug 另开任务。
    - **后台交付全部改成通知**：
      - 可续聊后端（进程内）走 `startContinuableSubagent`，原有 Activation 结算通知不变。
      - 不能续聊的后端（CLI、worker 进程里的父会话）改走管理器的 `startBackgroundRun`：后台跑一次，先 `onSettled` 记账（注册表、名额、目录），再发 `subagent-settled` 通知。通知文案写明「不能再接收消息」，失败原因单独成一行 `Diagnostic:`。
      - 往哪里投递：先找父会话宿主（`sendSettlementToParent` 现在返回是否投递成功）；找不到（CLI、worker 进程）就用发起 spawn 的那个会话的 `pi.sendMessage`，忙时 steer，闲时 followUp 并触发一轮。
      - spawn 回执只带 `agentId`（与通知里的 `childId` 同值；界面读的就是 `agentId`，没有改名）和 `status:"running"`，进程内的还带 `sessionPath`，不再有 `jobId`。
    - **`child-runs.ts`**：按直接父会话 id 登记「在后台跑着的子代理」。
      - 谁登记：Activation 在 `markAnnounced` 时登记；结算或带通知的 cancel 记为 settled；rollback 和 unannounced 时直接离开，不发事件。worker 后台运行由 `startBackgroundRun` 登记。
      - 谁用它：`wait_agent` 在这里等；父 Activation 的结算条件新增「没有在跑的子代理」，这样 worker 后台孙代理结束前，子代理不会先结算（原来靠 `jobs.hasLive` 兜住，现在 jobs 没了）。
      - 删除父会话时的「静默」标记（替代原来的 `jobs.markReported`）也放在这里。没放进 `manager.ts`，因为 `controlPlane → manager → backends → embedded-runner → adjacent-tools → controlPlane` 会形成循环引用。
    - **`wait_agent`**（`wait-agent.ts`），照 Codex v2：
      - 只有 `timeout_ms` 一个参数，默认 30 秒，最小 10 秒（小于最小值会被拉到 10 秒，并在结果里说明），最大 1 小时（超过直接报错）。
      - 只等调用者自己的直接子代理。没有在跑的就立刻返回；同一刻结算的兄弟一起报告；用户插话（`ctx.hasPendingMessages()`）或中止时提前返回。
      - 结果只有摘要（childId、任务首行、stopReason），正文在随后到来的通知里。
      - 带 `promptSnippet` 和点了工具名的 `promptGuidelines`。
    - **删掉的东西**：
      - `spawn_agent` 的 `mode` 参数、`action:"wait"`、`status` / `cancel` 里读写 jobs 的分支、`waitForTerminal`、`mapStop`、`registry.setJobId`（`jobId` 列保留，旧库还要能读）。
      - jobs 里只给子代理用的代码：`JobKind` 只剩 `"bash"`；`JobOutcome.output/error`、`JobSnapshot.output/error/stream`、`JobConsume.result`、`resultText` / `resultDelivered`、`formatJobNotice` 里非流式的分支都删了。
      - `job_output` 的说明不再提 one-shot spawn_agent。
    - **提示词**：
      - `spawn_agent` 的说明不再写「独立进程」，改为写清 run 和 spawn 两种交付；guideline 改成「spawn 的结果走通知，不要轮询」。
      - Fable `delegation.md` 的「Sub-agents are stateless」改成「子代理没有你的上下文」，并说明通知会写明它还能不能接着收消息。
    - **界面**：渲染层没有读 `jobId` / `mode` 的地方，没改。后台子代理不再产生 `job-done` 胶囊，只剩 `subagent-settled`。旧历史里的 `action:"wait"`、`job-done` 照旧渲染。
    - **没选的做法**：
      - `wait_agent` 直接返回子代理正文。最强理由：模型少读一条消息，用起来最直接。没选，是因为正文已经在通知里，再返回一遍等于同一段文字进上下文两次；而且 Codex 就是只给摘要，正文留在邮箱 / 通知里。
      - 没有父会话宿主时直接拒绝后台 spawn。最强理由：`-p` 模式的 worker 进程一轮结束就退出，后台子代理本来也活不长，拒绝最简单、不会出现悄悄丢掉的结果。没选，是因为 CLI 的 `--mode rpc` 是常驻的，以前靠 jobs 能用，拒绝就是功能倒退；改用 `pi.sendMessage` 投递可以保住这条路径。
      - 从注册表删掉 `jobId` 列。最强理由：彻底干净。没选，是因为 SQLite 删列要重建表，而第 4 阶段本来就要把注册表合并进管理器，到时一起处理。
- **阶段 2.5：worktree 改为显式工具。** 新增 `create_worktree` 工具与每会话工作目录（会话事件记录目录切换）；补齐核查里的缺口。删除：`profile.isolation: "worktree"`（`index.ts:596` schema 及 `capability.ts` 相关字段）、`embedded-runner.ts:187` 的 worktree 拒绝、`index.ts:884-887,907,1071` 的 worktree 特判、`index.ts:1231-1311` 委派时建 worktree 与出 diff 的逻辑、`ISOLATE_FALLBACK` 配置；`worktree.ts` 改为供 `create_worktree` 使用（位置改到 `.agents/worktrees`）。
  - **已落地（2026-10-12，未提交）**，验证见文末「验证」。用户确认的取舍：
    - 「固定在原始目录 / 跟着当前目录走」按第 2.5 阶段计划分。
    - `executor` 档案直接删掉。
    - `spawn_agent` 先不加 `cwd` 参数。
    - `working_directory` 允许切到任何已存在的目录。
    - **SDK 限制**：Pi SDK 1.1.0 没有改活会话目录的接口。
      - 内置工具和扩展的 `ctx.cwd` 都在调用时现读 `extensionRunner.cwd`，原地改它就行。
      - 系统提示的 `<cwd>` 和 reload 后重建工具读私有字段 `AgentSession._cwd`，所以一起改。
      - 项目说明（AGENTS.md）只认创建时的目录：切换后在 `before_agent_start` 里用 SDK 导出的 `loadProjectContextFiles` 按当前目录重读，从下一次用户输入起生效。
      - `.pi` 里的 skills、prompt 模板、项目设置、用户的 `!` bash、`resources_discover` 仍按原始目录（已知缺口）。
    - **`extensions/_shared/session-cwd.ts`**：
      - `attachSessionCwd(session)` 按会话里最后一条 `working_directory` 记录原地恢复目录；记录的目录已经不在时，退回原始目录并记一条带 `unavailable` 的记录。然后按 sessionId 登记控制器。
      - `set()` 只接受已存在的目录，相对路径按当前目录解析，写一条 `working_directory {cwd}`。
      - 会话头的 cwd 和 `process.cwd()` 永远不变。
      - `projectCwd(ctx)` 取会话头的 cwd。
      - 两处私有字段访问只出现在 `applyCwd` 里。
    - **谁挂控制器**：
      - 主会话在 `makeGrenRuntimeFactory`（Electron agent-host、CLI、worker 进程共用）。
      - 进程内子会话在 `embedded-runner`。
      - 冷恢复的子会话在 `coldResumeAndDeliver`。
    - **新扩展 `extensions/working-directory/`**（已加进 `allExtensions`、CLI 与子会话的常驻清单）：
      - `working_directory({cd?})` 读或换目录，也是离开 worktree 的方式；ask / plan 模式的白名单里也有它。
      - `create_worktree({name?, from?})` 照 DSH 的做法：
        - 从当前目录 `rev-parse --show-toplevel`，先把 `<from|HEAD>^{commit}` 钉住，查分支和目标目录都不存在。
        - 独占建 `<仓库根>/.agents/worktrees/<name>`，只有这次建了 worktrees 目录才写 `.gitignore`（`*`）。
        - `git worktree add --no-checkout -b`，再 `reset --hard`；关掉 hooks / fsmonitor / lazy fetch / filter，清掉 `GIT_*` 选择器。
        - 都成功后才切目录。
        - 不额外授权：目标目录和 `--git-common-dir` 都必须在会话可写根（原始工作区）里且可写，否则说明是哪个目录；只读会话（`SAFETY_READONLY` 或审批档 readonly）直接拒绝；调用本身照常走工具审批。
        - 分配之后才失败的，报错里写明「已建的 checkout 和分支保留」。
    - **固定在原始目录的**（改用 `projectCwd(ctx)`）：
      - 审批（`approval/index.ts`）、模式（`agent-mode`；`.pi/plans` 返回相对路径，所以计划文件仍跟当前目录写）
      - 沙箱可写根、safety 的 `workspace` 和 `outsideWorkspace`（相对路径按当前目录解析，越界按原始工作区判）
      - 子代理注册表（`getRegistry`、`send_message`、`wait_agent` 的标签）
      - MCP 授权与状态发布（`agentHost.workspaceForCwd` 按 handle.cwd 路由）、`resource-manager` 写 MCP 配置
      - 记忆 scope、`session-memory`、`compaction-policy`、`goal`、`debug-tools` 日志、`image-gen` / `tts` 输出目录（它们返回绝对路径）
      - 进程内子代理 ALS 里的 `cwd` 也改成父会话的原始目录，和宿主主会话一致，所以审批 / 模式查询不用改。
    - **子代理继承当前目录**：进程内子会话头用父会话的原始目录（会话目录与归属不变），服务和工具用父会话的当前目录；两者不同时写一条 `working_directory`，冷恢复按它切回。worker 后端直接把当前目录当进程目录。
    - **safety 只读会话配置**：
      - 去掉了 `process.env.SAFETY_*` 优先。
      - `buildSubagentRuntimeConfig` 把父会话自己的限制叠到子代理配置上：deny 取并集，只读向下传，写白名单只能收窄（新函数 `inheritedFsLimits`）。
      - 这同时补上了进程内子代理把父会话 deny 列表整个替换掉的旧缺口。
    - **删掉的东西**：
      - `profile.isolation`（schema 和 `capability.ts`）、`executor` 档案（旧的 `profile: "executor"` 按未知名回退到 default）。
      - `spawn_agent` 里 worktree 的全部特判（并行 / chain / 后台拒绝）、委派时建 worktree 和出 diff 的逻辑、`ISOLATE_FALLBACK`。
      - `canUseEmbeddedSubagent` 里的 worktree 判断、`SubagentCapabilities.worktree`。
      - 旧的 `multi-agent/worktree.ts`（临时目录 + `--detach` + 强制删除）及其测试。
      - `docs/architecture.md` 里「worktree 隔离的子代理走独立进程」的描述。
      - 结果：在 Electron 里所有子代理都在进程内跑。worker 后端只有 CLI / worker 进程里还会走到，等第 3 阶段「设置 / 角色指定 worker」再接回来。
    - **没选的做法**：
      - 把会话 fork 到新目录再切过去（`SessionManager.forkFrom` + `switchSession`）。最强理由：SDK 原生支持，skills、设置、项目说明都会正确跟过去。没选，是因为会话 id 会变，会话头的 cwd 会变成 worktree（Pi 按会话头 cwd 把会话归到工作区，会话会从工作区里消失），而且这件事不能在工具调用里做。
      - 恢复会话时直接按记下的目录建服务。最强理由：skills / `.pi` 也会跟着恢复。没选，是因为 `runtime.cwd` 取的是服务的 cwd，之后 `newSession` / `fork` 出来的会话头会指向 worktree。
      - 审批 / 模式改按 ALS 的 `workspace` 查。最强理由：语义上就是「按工作区」。没选，是因为宿主登记审批档时用的是打开时的路径和它的 realpath 两个键，扩展在 `session_start` 只按会话头（realpath）写，改了键容易对不上；保持 ALS 的 `cwd` 就是原始目录更稳。
      - git 走沙箱 provider（DSH 用 `sandbox.confine`）。最强理由：和 bash 同一套强制执行。没选，是因为 Pi 的沙箱 provider 是为 bash 写的，git 还要写共享的 `.git` 元数据目录；「不额外授权」改由显式预检实现：目标目录和元数据目录都必须在可写根里且可写，调用本身照常走审批。
- **阶段 3：worker 改常驻 RPC。** 复用 `agentProcess/rpcPeer.ts` 风格，worker 支持 prompt / steer / interrupt / dispose / fork seed。删除：`runner.ts` 的 JSONL 解析（`absorbJsonlLine`、`extractFinalText`）和空闲 / 首字节 / 静默完成超时（`SUBAGENT_QUIET_MS` 等）、`canUseEmbeddedSubagent` 分叉、`index.ts:881`、`:885`、`:~913` 的特判。
  - **已落地（2026-10-12，未提交）**，验证见文末「验证」。没有新增需要用户拍板的决定，按第 3 节、第 6 节已确认的取舍做：只有设置 / 角色指定才走 worker；每个子代理一个进程，不做池；超出名额排队。
    - **worker 进程托管真会话，没有另写一套子代理逻辑**：
      - `pi-worker --mode subagent`（`cli/src/pi-worker.ts` → `extensions/multi-agent/worker-host.ts`）托管一个子会话。会话用和进程内后端同一份代码建（`openEmbeddedChildSession`；冷恢复用 `openResumedChildSession`）。
      - 会话操作暴露成 RPC 方法：`open` / `resume` / `prompt`（steer、followUp 都走这里）/ `abort`（= interrupt）/ `waitForIdle` / `snapshot` / `appendCustomEntry` / `sendCustomMessage` / `heartbeat` / `dispose`。会话事件和状态（isStreaming / isIdle / pendingMessageCount）随事件推回宿主。
      - RPC 用 agent-host 那套 `RpcPeer`，实现从 `electron-agent/electron/agentProcess/rpcPeer.ts` 搬到 `extensions/_shared/rpc-peer.ts`，原文件改为 re-export。
    - **宿主侧**（`worker-session.ts`）：
      - 给出一个代理会话，接口和进程内会话一样。`embedded-runner` 的 `runEmbeddedSubagent` / `startContinuableEmbedded` 多了一个参数：开会话方式（`ChildSessionOpener`）。两个后端跑同一个 runner：超时看门狗、Activation、收件箱、结算通知、`wait_agent` 登记都不分后端。
      - prompt 的 preflight 回调按 requestId 经事件回放；`waitForIdle` 的回复里带消息、transcript、结构化输出快照。
      - worker 意外退出时，会话按 `stopReason: "error"` 结束（补一条带退出原因的助手消息，唤醒等待方），Activation 照常结算，不会一直挂着。
      - 同时活着的 worker 超过 `SUBAGENT_MAX_WORKERS`（默认 2）就排队，worker 退出才放下一个；启动前就被取消的直接放弃。
      - worker 进程登记进 `subagentProcessRegistry`，关工作区时一起杀掉。
    - **能力**：两个后端都是真会话，能力一样（续聊、fork、outputSchema、工具白名单、换模型都支持）。子会话的 `subagent_meta` 记 `backend`，冷恢复时按它回到 worker。
    - **选择**：删掉了 `canUseEmbeddedSubagent`（原来按「是不是 Electron / 是不是子代理进程 / 是不是 worktree」分叉）。`selectSubagentBackend(偏好)`：调用显式给的 > 命名角色 frontmatter 的 `backend` > 设置 `SUBAGENT_BACKEND`，默认进程内，不按负载自动挪。设置页加了「子代理运行位置」「worker 进程上限」两项。
    - **CLI 里结算通知的退路**：CLI、worker 进程里的父会话没有登记宿主。原来这类父会话的后台 spawn 走的是「不能续聊」那条路，有 `pi.sendMessage` 退路；现在两个后端都能续聊，所以 Activation 的结算（含 cancel 时那条 aborted）也加上同样的退路（`deliverFallback`）。
    - **fork 继承说明**（第 5 节的要求，之前没做）：子代理继承了父会话上下文时，在任务前面加上 Codex 那段 MultiAgentUsageHint（`fork-seed.ts` 的 `FORK_INHERITANCE_NOTE`）。
      - `completedPrefix` 不改：它和 DSH（快照切到最后一个 `turn/end`）、Codex 一样，带着父会话发起这一轮的那条用户消息。
      - 实跑里 haiku 仍可能照着那条用户消息再派一个子代理。深度上限会挡住无限递归。
    - **删掉的东西**：
      - `runner.ts` 里给 worker 用的打印模式启动、stdout JSONL 解析（`absorbJsonlLine`、`extractFinalText` …）、首字节 / 静默完成 / 退出宽限超时（`SUBAGENT_QUIET_MS` 等）、`spawnPiAgent`。它们只剩 im-platforms 的受限会话在用，搬到 `im-platforms/pi-process.ts`，测试也一起搬了。
      - `index.ts` 里「fork 需要进程内」的特判。
      - `embedded-runner.test.ts`（只测 `canUseEmbeddedSubagent`）。
      - `extensions/multi-agent/README.md` 按现状重写。
    - **没选的做法**：
      - worker 里跑完整的子代理逻辑（Activation、结算都放在 worker 进程，宿主只放一个转发用的 Activation）。最强理由：宿主和 worker 之间只需要传「结果和通知」，协议更粗、往返更少。没选，是因为 Activation 的结算、收件箱、名额、`wait_agent` 登记、父等子都得在两个进程各写一套或跨进程同步，两个后端的行为会慢慢分叉。现在的做法是 worker 只当「会话服务器」，逻辑只有一份。
      - 宿主直接打开子会话 JSONL 读消息，而不是靠 `waitForIdle` 快照同步。最强理由：省掉快照传输。没选，是因为违反「每个 JSONL 只有一个持有者」（worker 正在追加），而且同步读到的可能是写到一半的状态。
      - 继续解析 `pi --mode json -p` 的 stdout。最强理由：不用新写 RPC。没选，是因为那条路不能续聊、不能 fork，还要靠空闲 / 首字节 / 静默完成多种超时兜底，正是本提案要解决的问题。
- **阶段 4：catalog 与驻留。** 父会话写子代理目录；空闲子代理卸载 / 冷恢复；合并 `registry.ts`、`subagentProcessRegistry.ts`、`reap-continuable.ts`、`restart-reap.ts` 为管理器内的一处。
  - **已落地（2026-10-12，未提交）**，验证见文末「验证」。按第 6 节、第 9 节已确认的取舍做（活跃上限 8、空闲驻留 8、超名额排队、子代理列表存父会话 JSONL），没有新的待定项。
    - **子代理目录与 `list_agents`**：
      - 父会话 JSONL 里本来就有子代理目录（`subagent_catalog`，一次性和可续聊的子代理都写），新增的 `list_agents` 从调用者自己的目录列出直接子代理，所以重启后照样列得出来。
      - 状态只报 `running` / `inactive`（照 DSH），由运行时投影：活着的 Activation、`child-runs` 登记、正在跑的前台运行。一次性子代理标明不能收消息。
      - `spawn_agent` 的 `action: "list"`（整个工作区的注册表）保留给界面与善后，不再是找子代理的推荐方式。
    - **同时活跃上限**（`active-runs.ts`，`SUBAGENT_MAX_ACTIVE`，默认 8，照 DSH `maxActiveSubagents`）：
      - 所有会话加起来同时在跑的子代理（两个后端、前台和后台都算）超过上限就排队，不拒绝。
      - 只有顶层会话派的子代理（深度 1）排队，更深的只登记不等：否则 8 个子代理各等一个孙代理的名额会互相卡死。
      - 可续聊子代理的名额占到它结算为止。冷恢复续聊不经过这里。
    - **空闲驻留**（`activation.ts`，`SUBAGENT_MAX_RESIDENT`，默认 8，设 0 关闭）：
      - 进程内的可续聊子代理结算后，会话先不销毁，留在驻留池；超出上限按最久未用销毁。续聊（`send_message` → `coldResumeAndDeliver`）先从池里取，取不到再按 JSONL 冷恢复。
      - worker 会话不驻留：结算即退出，不占 worker 名额。
      - 父会话换走 / 关掉（`drainByParent`）、工作区释放、删除子会话、拆除（`writeTornDown`，用驻留会话自己的会话管理器写 tornDown，避免两个写者）时，一并销毁对应的驻留会话。
    - **事件循环监控**：agent-host 原本每 10 秒把内存和事件循环延迟（p99 / max）报给主进程写进 `runtime-diag.jsonl`（`agent-host-sample`）。这次在同一条采样里加上 `subagents`：在跑的子代理数（进程内 / worker）、id（最多 16 个）、驻留数、worker 进程数，卡顿时能对上是谁在跑（第 3 节建议 4）。相关模块在运行时图加载之后才动态取，不进启动路径。
    - **合并**：
      - 子会话 `subagent_meta` 的读取原来有两份（`activation.ts` 和 `reap-continuable.ts`），合成 `subagent-meta.ts` 一份，冷恢复和重启回收都用它；删掉 `reap-continuable.ts`。
      - 名额与在跑清单（`active-runs.ts`）、后台子代理登记（`child-runs.ts`）、驻留池（`activation.ts`）、worker 进程（`worker-session.ts` + `subagentProcessRegistry.ts`）都由管理器入口驱动。工作区释放（`releaseSubagentControlPlane`）一次收掉：注册表、worker 进程、驻留会话。
      - 注册表（`registry.db`）保留：界面的任务托盘、Bot 菜单直接读它，`jobId` 列也照旧只读不写。
    - 设置页加了「同时运行的子代理上限」「空闲子代理驻留数」。
    - **没选的做法**：
      - 超过活跃上限直接拒绝（不排队）。最强理由：最简单，不会出现父会话在工具调用里一直等。没选，是因为用户确认的是排队（第 6 节决定 6）；拒绝会让模型在负载高时反复重试。
      - 嵌套子代理也排队。最强理由：上限严格成立。没选，是因为会死锁：名额全被子代理占着、每个都在等孙代理的名额。
      - 驻留池也放 worker 会话。最强理由：worker 续聊也能免冷启动。没选，是因为 worker 名额默认只有 2，驻留会把排队的子代理挡住。

## 决定汇总（用户确认）

- 1 worker：每子代理一个进程，不做池。
- 1a worktree：显式 `create_worktree`，照 DSH。
- 1c 崩溃隔离：照 DSH——不强制释放；不设默认步数 / 墙钟上限；崩溃后不自动恢复，收到消息时按需冷恢复。
- 2 worktree 位置：`.agents/worktrees`（固定默认，不支持移出 OneDrive）。
- 3 MCP：切换目录不重启，提醒模型。
- 4 safety：只读会话配置；审批按原工作区查。
- 5 worker：每子代理一个进程。
- 6 不按负载自动挪；超名额排队；只有设置指定才走 worker。
- 7 单个 `send_message` + 可选 `wake: false`。（已做，见 [2026-10-12-send-message-without-waking.md](../feature/2026-10-12-send-message-without-waking.md)）
- 8 过渡期保留单任务前台阻塞；最终非阻塞 + `wait_agent`。（`wait_agent` 已做；「最终全部非阻塞」改为「用户引导时转后台」，见 [2026-10-12-foreground-run-detach.md](../feature/2026-10-12-foreground-run-detach.md)）
- 9 活跃上限 8（DSH `maxActiveSubagents`）、空闲驻留 N=8、worker 上限 2，均可配置。
- 10 无人值守：等待审批，超时 60 秒，超时返回「被拒」事实。（已做，见 [2026-10-12-subagent-approvals-via-parent.md](../feature/2026-10-12-subagent-approvals-via-parent.md)）
- 11 子代理列表存父会话 JSONL。
- 12 p99 ≤ 200 ms @ 8 个并发子代理，`monitorEventLoopDelay` + `runtime-diag.jsonl`。

- `create_worktree` 权限：照 DSH，不额外授权，目标目录与 `.git/worktrees` 须本来可写，否则明确失败。
- 无人值守审批超时：60 秒（已做，`SUBAGENT_APPROVAL_TIMEOUT_MS`）。
- worktree 根不支持移出 OneDrive；固定默认 `.agents/worktrees`。
- SDK 核查：SDK 跟随每会话 cwd；工具异常在 SDK 内都转成错误结果或在整轮边界结算，漏网的只有不被 await 的异步错误与进程级故障（见第 3 节）。

## Alternatives considered

- **全部进程外**（[2026-10-11-all-subagents-out-of-process.md](../../rejected/architecture/2026-10-11-all-subagents-out-of-process.md)，已否决）：隔离最好，但两个参考系统都没有这样做，续聊 / fork 要全部重做在 RPC 上，启动和内存成本高；用户已暂停。本笔记把它降为「worker 后端」这一选项。
- **全部进程内**（Codex 本地后端的做法）：最简单，worktree 也能靠每会话 cwd 在进程内做；缺点是没有崩溃隔离，重负载时会加重 agent-host 事件循环压力，也无法给子代理不同的进程级环境。
- **维持现状双轨**：能力不对等和重复的生命周期代码会继续增加。

## Consequences

原定的验收标准都已满足，证据见「验证」：
- **一个执行入口**：`spawn_agent` 只经过管理器。`canUseEmbeddedSubagent` 及「fork 需要进程内」「worktree 不支持并行 / chain / 后台」这些特判都已删掉。
- **不论后端都能**：拿到 `agentId`（= 通知里的 `childId`）、续聊、被 `interrupt_agent` 打断、重启后从目录列出并冷恢复。第 3、4 阶段的实跑覆盖了 worker 续聊、冷恢复，以及重启后的 `list_agents` 和冷恢复。
- **`create_worktree`**：主会话和进程内子代理都能调用，调用后该会话的工具在新 checkout 里工作；`spawn_agent` 不再接受 `isolation`。fork 在 worker 后端也可用。
- **交付**：子代理结果只经结算通知或前台 `run` 返回，没有 job 收集路径。
- **事件循环**：8 个进程内子代理并发时，agent-host 事件循环 p99 148 ms（≤ 200 ms），采样写进 `runtime-diag.jsonl`。

代价与已知缺口：
- **工作目录**：切换只改这一个会话。`.pi` 下的 skills / prompt 模板 / 项目设置、用户的 `!` bash、`resources_discover` 仍按原始目录（SDK 1.1.0 限制）；已经起来的进程、终端、MCP 服务器保留各自的目录。项目说明（AGENTS.md）要到下一次用户输入才换。
- **私有字段**：原地切目录依赖 SDK 的两个私有字段（`ExtensionRunner.cwd`、`AgentSession._cwd`），只出现在 `session-cwd.ts` 的 `applyCwd`。升级 pi 时要先跑 `_shared/session-cwd.test.ts` 和第 2.5 阶段的实跑脚本。
- **fork**：继承的上下文里带着父会话发起这一轮的那条用户消息（DSH、Codex 也是这样），子代理开头加了 Codex 的继承说明。实跑里 haiku 仍可能照着那条消息再派一个子代理，深度上限会挡住递归。
- **界面看不到的**：worker 里子代理再派的孙代理，以及冷恢复 / 驻留续聊的子代理，事件不进界面的实时流（和原来冷恢复的行为一致），结果仍经通知送回。
- **worker 成本**：每个 worker 是一个完整的 pi 进程（启动约 1～2 秒、单独的模型运行时），所以默认上限 2，且不驻留。
- **stopReason**：类型已扩成 DSH 词表，但 `max-tokens` / `refusal` 还没有产出（映射没改），要不要产出留待单独决定。
- **设计里确认过、四个阶段之外的**：无人值守审批（冒泡到父窗口、限时等待、超时按被拒）已单独落地，见 [2026-10-12-subagent-approvals-via-parent.md](../feature/2026-10-12-subagent-approvals-via-parent.md)。`send_message` 的 `wake: false` 也已单独落地，见 [2026-10-12-send-message-without-waking.md](../feature/2026-10-12-send-message-without-waking.md)。决定 8 的「最终全部非阻塞」改为「前台等待时用户引导就转后台」，见 [2026-10-12-foreground-run-detach.md](../feature/2026-10-12-foreground-run-detach.md)。把 agent-host 的漏网错误归到具体子代理、释放边界逐个 try/catch（第 3 节建议 1、2）也已单独落地，见 [2026-10-12-subagent-leaked-errors-and-teardown.md](../feature/2026-10-12-subagent-leaked-errors-and-teardown.md)。SDK `onUpdate` 的进度事件被拒会让这次工具调用的结果丢掉、本轮以 error 结束（`agent-loop.js:587`），防护也已单独落地，防在 Pi 挂在会话上的监听方，不是工具一侧，见 [2026-10-12-session-listener-guard.md](../feature/2026-10-12-session-listener-guard.md)。这几项都落地后，跟踪它们的后续笔记已关闭。
- **范围外**：取消可续聊子代理不归还单会话名额的旧 bug 在另一任务里修。

风险（原提案所列）的现状：
- 交付方式变更：提示词和工具说明已同步（`spawn_agent`、`wait_agent`、`job_output`、Fable delegation）。
- 常驻 worker 的内存和孤儿进程：worker 登记进 `subagentProcessRegistry`，关工作区时杀掉；agent-host 崩溃由已有的进程树守卫清理。
- 「每个 JSONL 只有一个持有者」：宿主不直接写 worker 子会话的 JSONL（追加经 RPC 进 worker）；驻留会话拆除时用它自己的会话管理器写。
- 卸载中收到消息：驻留池在取出时先摘掉，续聊总是新装一个 Activation；收件箱关闭期间的投递照旧报 `ACTIVATION_CLOSING`。

## 验证

仓库里没有 `verify-*` skill，每个阶段都用三样东西作证据：vitest、agent-host 冒烟，以及真实 agent-host 加真实模型的实跑。

**第 1 阶段（2026-10-11）：通过。** 证据在 `.agents/evidence/2026-10-11-subagent-redesign/`，说明见该目录的 `README.md`。
- `cd extensions && npx vitest run multi-agent`：通过，424 个用例通过 / 2 个跳过。基线是 414，多出来的 10 个是新增的 `manager.test.ts`；`index.test.ts`、`embedded-runner*.test.ts` 等现有测试一行没改，全部通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/vitest-multi-agent.txt`。
- `cd extensions && npx vitest run`（全量）：1811 个通过，1 个失败，失败的是 `_shared/sandbox/windows/deleteSemantics.test.ts`。在 HEAD 上跑同样失败，单独跑则通过，和本次改动无关。日志：`.agents/evidence/2026-10-11-subagent-redesign/vitest-extensions-full.txt`、`.agents/evidence/2026-10-11-subagent-redesign/vitest-extensions-full-HEAD.txt`。
- `npx tsc -p electron-agent/tsconfig.node.json --noEmit`：和 HEAD 一样都是 155 条既有报错，逐条比对没有差异，新文件 0 条。记录：`.agents/evidence/2026-10-11-subagent-redesign/tsc-compare.txt`。
- `electron-agent/scripts/agent-host-smoke.mjs`（入口用 `out/subagent-p1` 的构建产物）：15 项检查全部通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/agent-host-smoke.txt`。
- 实跑 `.agents/evidence/2026-10-11-subagent-redesign/real-subagent-run.mjs`，用 `custom-muqywnc8/claude-haiku-5-5`：18 项检查全部通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/real-subagent-run.txt`。三个用例都由父会话调 `spawn_agent` 发起：
  - 进程内一次性：结果正文 `OK`，带子会话 `sessionPath`。
  - 进程内可续聊：结果经 `subagent-settled` 通知交回父会话，stopReason 是 completed。
  - worker（executor 档案，worktree）：起了 `pi-worker.js` 进程，结果正文 `OK` 加 diff 段，`isolated: true`。

**第 2 阶段（2026-10-12）：通过。** 证据在同一目录，文件以 `stage2-` 开头，另有 `real-run-stage2.*`，说明见该目录 `README.md` 的第 2 阶段一节。
- `cd extensions && npx vitest run multi-agent jobs prompt-metadata fable-behavior`：通过，525 个用例通过 / 2 个跳过。
  - 被删除的行为对应的测试改写成新行为的测试：one-shot、`action:"wait"`、jobs 的终值结果、`setJobId`。
  - 新增：`wait-agent.test.ts`；`manager.test.ts` 的 `startBackgroundRun`；`activation.test.ts` 的「worker 孙代理在跑时不结算」、announce / settle / cancel / rollback 的登记；`index.test.ts` 的 background delivery 一组；`parent-host` / `settlement-notice` 的新分支。
  - 日志：`.agents/evidence/2026-10-11-subagent-redesign/stage2-vitest-multi-agent-jobs.txt`。
- `cd extensions && npx vitest run`（全量）：1829 个通过，1 个失败，仍是 `deleteSemantics.test.ts`，和本次改动无关。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage2-vitest-extensions-full.txt`。
- `cd electron-agent && npx vitest run electron`：16 个失败。在 HEAD 上跑同样这些文件，失败 15 个；唯一多出来的是 gitService 的临时目录 EBUSY，单独复跑通过。没有一个与子代理交付有关。对比：`.agents/evidence/2026-10-11-subagent-redesign/stage2-electron-main-compare.txt`。
- `npx tsc -p electron-agent/tsconfig.node.json --noEmit`：155 条，与第 1 阶段逐条一致。第一次跑出的 10 条新报错已修掉。记录：`.agents/evidence/2026-10-11-subagent-redesign/stage2-tsc-compare.txt`。
- agent-host 冒烟：15 项全部通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage2-agent-host-smoke.txt`。
- 实跑 `.agents/evidence/2026-10-11-subagent-redesign/real-run-stage2.mjs`，用 `custom-muqywnc8/claude-haiku-5-5`：25 项全部通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/real-run-stage2.txt`。
  - 父会话一轮里派出两个后台子代理再调 `wait_agent`：回执没有 `jobId`；`wait_agent` 返回 settled 摘要，不带正文；两条 `subagent-settled` 都到了（completed，正文 OK）；`wait_agent` 报告的那个子代理，它的通知排在 `wait_agent` 结果之后；没有 `job-done`。
  - 前台 run（进程内、worker）回归通过。
  - 第一次实跑有 1 项检查本身写错了（标签里本来就含 OK），改正后重跑全部通过。
- 未实跑：worker 后台运行（`startBackgroundRun`）。在 Electron 里走不到这条路径，用户选了只做单元测试。

**第 2.5 阶段（2026-10-12）：通过。** 证据在同一目录，文件以 `stage25-` 开头，另有 `real-run-stage25.*`，说明见该目录 `README.md` 的第 2.5 阶段一节。
- `cd extensions && npx vitest run`（全量）：1860 个通过 / 4 个跳过，没有失败，连跑两次都全绿。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage25-vitest-extensions-full.txt`。
  - 新增 `_shared/session-cwd.test.ts`。
  - 新增 `working-directory/worktree.test.ts`（真 git：钉住提交、只在首次建 worktrees 目录时写 `.gitignore`、源 checkout 的未提交改动不动、分支名 / 目标目录 / 名字 / 修订号非法、非仓库、无提交、可写根之外、从 linked checkout 再建）。
  - 新增 `working-directory/index.test.ts`（工具、只读拒绝、AGENTS.md 重读）。
  - 补了子会话头 / 当前目录、限制下传、safety 只读会话配置的测试。
- `cd extensions && npx vitest run working-directory _shared/session-cwd multi-agent safety memory jobs prompt-metadata`：662 个用例通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage25-vitest-targeted.txt`。
- `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts`：12/12 通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage25-cli-tests.txt`。
- `cd electron-agent && npx vitest run electron`：15 个失败，和 HEAD 的失败集合一致，没有新增。记录：`.agents/evidence/2026-10-11-subagent-redesign/stage25-electron-main.txt`。
- `npx tsc -p electron-agent/tsconfig.node.json --noEmit`：155 条，与第 2 阶段逐条一致。记录：`.agents/evidence/2026-10-11-subagent-redesign/stage25-tsc-compare.txt`。
- agent-host 冒烟：15 项全部通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage25-agent-host-smoke.txt`。
- 实跑 `.agents/evidence/2026-10-11-subagent-redesign/real-run-stage25.mjs`，用 haiku：18 项全部通过，1 项跳过（新会话的头要等第一条消息才落盘）。日志：`.agents/evidence/2026-10-11-subagent-redesign/real-run-stage25.txt`。
  - `create_worktree` 之后，`write` 的相对路径落在 worktree 里；父会话头仍是原工作区。
  - 子代理写在 worktree 里，子会话头和会话目录仍是原工作区。
  - 新建会话再切回，目录恢复为 worktree。
  - `working_directory` 回到原工作区后，checkout 和分支都保留。
- 未实跑：子代理自己调用 `create_worktree`（控制器已经挂在子会话上，工具路径和主会话相同）。

**第 3 阶段（2026-10-12）：通过。** 证据在同一目录，文件以 `stage3-` 开头，另有 `real-run-stage3.*`，说明见该目录 `README.md` 的第 3 阶段一节。
- `cd extensions && npx vitest run multi-agent im-platforms working-directory _shared/session-cwd jobs prompt-metadata`：556 个用例通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage3-vitest-targeted.txt`。
  - 新增 `worker-session.test.ts`（假 worker 进程：起进程参数、open 参数、事件 / 状态镜像、preflight 先于 prompt 结束、waitForIdle 快照、worker 崩溃按 error 结算、名额排队、dispose 后超时强杀）。
  - `manager.test.ts` 改为测后端选择与共用 runner。
  - `index.test.ts` 改为测 worker 也能续聊、fork、写目录，以及结算退路。
  - `fork-seed.test.ts` 新增继承说明的测试。
- `cd extensions && npx vitest run`（全量）：1857 个通过，1 个失败，是已知的 `deleteSemantics`。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage3-vitest-extensions-full.txt`。
- `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts`：16/16 通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage3-cli-tests.txt`。
- `cd electron-agent && npx vitest run electron`：HEAD 的 15 个失败照旧，另外两个是负载下超时，单独复跑通过。记录：`.agents/evidence/2026-10-11-subagent-redesign/stage3-electron-main.txt`。
- `npx tsc -p electron-agent/tsconfig.node.json --noEmit`：155 条，与第 2.5 阶段逐条一致。记录：`.agents/evidence/2026-10-11-subagent-redesign/stage3-tsc-compare.txt`。
- agent-host 冒烟（最终构建）：15 项全部通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage3-agent-host-smoke.txt`。
- 实跑 `.agents/evidence/2026-10-11-subagent-redesign/real-run-stage3.mjs`（`SUBAGENT_BACKEND=worker`，haiku）：14 项全部通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/real-run-stage3.txt`。
  - 一次性 run 起了 `pi-worker --mode subagent` 进程，子会话 meta 是 `backend: worker`。
  - 后台 spawn 可续聊：结算后 `send_message` 冷恢复到新的 worker 进程，带回第二条通知。
  - fork 继承了 15 条事件，任务前面有继承说明。
  - haiku 会不会遵守继承说明因次而异，所以只查机制，回复只记录。

**第 4 阶段（2026-10-12）：通过。** 证据在同一目录，文件以 `stage4-` 开头，另有 `real-run-stage4.*`，说明见该目录 `README.md` 的第 4 阶段一节。
- `cd extensions && npx vitest run multi-agent working-directory _shared/session-cwd jobs im-platforms prompt-metadata`：571 个用例通过 / 2 个跳过。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage4-vitest-targeted.txt`。
  - 新增 `active-runs.test.ts`：默认 8 且读设置；超限排队，释放后放行下一个；嵌套子代理只计数不等待；被取消的等待者放弃。
  - 新增 `list-agents.test.ts`：只列调用者目录里的子代理，running / inactive 由运行时状态投影；没有子代理时的提示；工具带 snippet 和点名的 guideline。
  - `activation.test.ts` 新增驻留：结算后保留会话，下一条消息直接复用、不重开日志；worker 会话结算即销毁；超过 `SUBAGENT_MAX_RESIDENT` 按最久未用销毁；父会话收尾时销毁驻留会话，拆除用驻留会话自己的日志句柄写。
  - `manager.test.ts` 新增活跃名额：前台 run 只在运行期间占名额；可续聊子代理占到结算；启动失败归还名额。
- `cd extensions && npx vitest run`（全量）：1872 个通过，1 个失败，是已知的 `deleteSemantics`。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage4-vitest-extensions-full.txt`。
- `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts`：16/16 通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage4-cli-tests.txt`。
- `cd electron-agent && npx vitest run electron`：15 个失败，和 HEAD 的失败集合一致，没有新增。记录：`.agents/evidence/2026-10-11-subagent-redesign/stage4-electron-main.txt`。
- `npx tsc -p electron-agent/tsconfig.node.json --noEmit`：154 条，比第 3 阶段少 1 条（`activation.ts` 冷恢复里 `poke` 的参数类型），新增 0 条。记录：`.agents/evidence/2026-10-11-subagent-redesign/stage4-tsc-compare.txt`。
- agent-host 冒烟：15 项全部通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/stage4-agent-host-smoke.txt`。
- 实跑 `.agents/evidence/2026-10-11-subagent-redesign/real-run-stage4.mjs`（进程内后端，haiku）：14 项全部通过。日志：`.agents/evidence/2026-10-11-subagent-redesign/real-run-stage4.txt`。
  - 一次 `spawn_agent` 派 8 个任务（各写 1～400 的英文，持续推流）：8 个结果都回来了。agent-host 诊断采样里有一个窗口 `active: 8`，8 个 id 都记下，事件循环 p99 148 ms、max 281 ms，验收线 p99 ≤ 200 ms；其余窗口 p99 34～35 ms。
  - 后台可续聊子代理结算后，采样里 `resident: 1`；`send_message` 从驻留池续聊，第二条通知带回 `AGAIN`。
  - 重启 agent-host 后切回原父会话：`list_agents` 列出 9 个子代理（8 个一次性，标明不能收消息；1 个可续聊），都是 `inactive`；`send_message` 按 JSONL 冷恢复，通知带回 `RESUMED`。
