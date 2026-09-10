# Electron 内嵌 Pi SDK 宿主

## 已确认边界

2026-09-09 对话确认；同日晚经 4 个只读子代理分域审查（`2026-09-09-electron-pi-sdk-host-design-review.md`）后按第五节决策修订。以下全部以代码为依据，行号已核实。

- **混合模型**：交互主 Agent 在 Electron 主进程内嵌 `@earendil-works/pi-coding-agent@0.85.1`；**Goal 按「每 jsonl 单持有者」路由（Q1-A）**——命中可见 session 则在交互 handle 上串行执行，否则 `GoalHost` 为该 jsonl 开独立 handle；oneshot / probe / 后台任务（原 system worker 三类）改为 **`ModelRuntime` 直接调用（Q4）**；子代理仍为独立进程。
- 子进程用 `ELECTRON_RUN_AS_NODE=1` spawn 同一份 Electron 可执行文件跑 `pi-worker`。不编 `pi.exe`。不用 `utilityProcess.fork`：它支持 `env / cwd / execArgv / stdio:"pipe"`，唯一实质差别是只能在 app ready 后的主进程调用、不是普通可执行文件；收益不足以换掉现有 spawn / killTree 代码。（「丢 stdout」「不支持 cwd/env」都不是理由。）
- 不同项目不共用主 Agent。同项目多会话继续 `switchSession`，本期不做每会话真并发。
- 渲染层 `agent_*` IPC、`pi://event` / `pi://ui-request` / `pi://exit` 信封、**事件载荷**、**UI 请求线协议字段名**、`get_state` / `get_commands` 等读命令的返回形状全部冻结。
- 无双栈：`PiClient` JSONL、`runRpcMode` 桌面路径、`resources/pi`、`systemWorkerManager` 一并删除。实现计划分份只服务审查粒度，合入主线一次切完。
- 不迁 `tauri-agent/`（已冻结）。不改渲染控件。Agent Data loopback 保留，fork 子进程继续用它做审批 TCP。
- **`PI_RUNTIME_CONFIG` 全局单份**，主进程启动期设进 `process.env` 并在任何 ALS `run()` 之前初始化 runtime-config（Q2-A）。
- **IM 平台随主进程加载**（`CORE_ALWAYS_ON`），进程内只有一份 IM 绑定（Q3）。

## 目标进程模型

```text
GrenAgent.exe 主进程
  ├─ AgentHost          Map<workspace, WorkspaceHandle>   交互回合；Goal 回合命中可见 session 时也在此执行
  ├─ GoalHost           Map<workspace\0sessionId, WorkspaceHandle>   仅 Goal 的 session ≠ 可见 session 时开
  ├─ ModelRuntimeHost   进程内一份 ModelRuntime；resolveDefaultModel / describeModel
  │    └─ ShortCallQueue  串行短调用：memory_extract / goal_judge / wiki_page_generate
  ├─ SessionUiAdapter   每 handle 一个；Goal 回合的 UI 请求即时取消
  ├─ ImBinding          进程级单份 (workspace, sessionId)
  └─ SubagentRegistry   cwd → child；spawn(execPath, [pi-worker.js, --mode json, ...])
                          env: ELECTRON_RUN_AS_NODE=1, PI_IS_SUBAGENT=1

渲染层 ── agent_* IPC ──▶ PiRuntimeService ──▶ WorkspaceHandle / ModelRuntimeHost
fork 子进程 ── Agent Data TCP ──▶ ToolDecisionService
```

没有全局单例主 Agent。`cwd`、`.pi/`、权限、session 目录按 workspace 隔离。`AgentSessionRuntime` 同一时刻一个活跃会话，同项目多份 jsonl 共用该项目的一个 handle，切换走 `runtime.switchSession`。

**Goal 不再无条件是第二套 runtime。** 审查确认今日「Goal worker 与交互 worker 共享同一 jsonl」从未落地：`electron/pi/manager.ts:112` 传的 `--session <path>` 被 `cli/src/runtime.ts:102-112` 的 rpc 分支丢弃，Goal worker 固定新建会话；且 session 写入是无锁 `appendFileSync`（`session-manager.js:620-640,739-767`），两个 runtime 持同一 jsonl 必然树分叉。真正的不变量是**每个 jsonl 同一时刻只有一个持有者**：Goal 的 session 就是可见 session 时，Goal 回合以 `origin:"goal"` 在交互 handle 上串行执行；否则 `GoalHost` 为该 jsonl 开独立 handle。两种情形都不会出现双持有，见「Goal 回合」。

## 模块与文件

共享代码放 `cli/` 与 `extensions/_shared/`，Electron 与 worker 都 import，不新建第三包。

| 模块 | 路径 | 职责 |
| --- | --- | --- |
| `toJsonEvent` 抄本 | `cli/src/json-event.ts` | 事件降级层，见下。 |
| workspace 上下文 | `extensions/_shared/workspace-context.ts` | `AsyncLocalStorage` 存储 `{origin, workspace, cwd, config}`；`runInWorkspace` / `currentWorkspaceContext` / `currentCwd` / `resolveToolOrigin`。 |
| `createGrenRuntime` | `cli/src/gren-runtime.ts` | 从 `runtime.ts:49-77` 抽出的 factory **工厂**：`createGrenRuntime({ modelRuntime, allowedExtensionIds })` 返回 `CreateAgentSessionRuntimeFactory`。转发 `modelRuntime`（否则每次 new/switch/fork 重建 `ModelRuntime`，`agent-session-services.js:56-61`）。不带入 `runtime.ts:22-28` 的 `process.on` 钩子。 |
| `pi-worker` | `cli/src/pi-worker.ts` | 子代理入口，仅 `--mode json` / print 路径（官方 `main()`）。 |
| `AgentHost` | `electron-agent/electron/agent/agentHost.ts` | 每 workspace 一个交互 handle；watch `PI_RELOAD_REV` → 各 handle `reload()`。 |
| `GoalHost` | `electron-agent/electron/agent/goalHost.ts` | `Map<workspace\0sessionId, WorkspaceHandle>`；仅当 Goal 的 session ≠ 可见 session 时以 `SessionManager.open(sessionPath)` 开独立 handle；`ownsFile(path)` 供驱逐判定。 |
| `WorkspaceHandle` | `electron-agent/electron/agent/workspaceHandle.ts` | 持 `AgentSessionRuntime`；所有构造 / new / switch / fork / reload / prompt 入口都在 `runInWorkspace()` 内；subscribe → `toJsonEvent` → `onEvent`；`setRebindSession` 重绑；`currentTurnOrigin`。 |
| `ModelRuntimeHost` | `electron-agent/electron/agent/modelRuntimeHost.ts` | `ModelRuntime.create` 一次；`resolveDefaultModel()`、`describeModel(): Promise<string>`。 |
| `ShortCallQueue` | `electron-agent/electron/agent/shortCall.ts` | 串行队列 + per-kind `AbortSignal` 超时 → `completeSimple`。 |
| `SessionUiAdapter` | `electron-agent/electron/agent/sessionUiAdapter.ts` | 实现 `ExtensionUIContext` 全部 28 项。 |
| `ImBinding` | `extensions/_shared/im-binding.ts` | 进程级单份绑定。 |
| `SubagentRegistry` | `extensions/multi-agent/runner.ts` | cwd → child 登记；`killSubagentsFor(cwd)` / `killAllSubagents()`。 |
| `desktopControl` 安装 | `electron-agent/electron/agent/desktopControlInstall.ts` | 主进程 in-process port；fork 不安装。 |

`PiRuntimeService` 仍是唯一 IPC 门面（命令表、Goal 排队与 11 条规则、`SESSION_BUSY`、审批伪命令、context exclusion）。删除对 `PiClient.send(JSONL)` 的依赖，直接调 `WorkspaceHandle` / `ModelRuntimeHost` 具名方法。不为 JSONL 保留 `AgentPort` 抽象。

`electron/pi/client.ts`、`jsonl.ts`、`manager.ts`、`systemWorkerManager.ts` 删除。`electron/pi/eventAdapter.ts` 保留（sqlite 落盘投影）。

## IPC 与会话操作映射

渲染层命令名不变。宿主侧对应 SDK 方法（签名已核实 `agent-session.d.ts`）：

| IPC | 宿主 |
| --- | --- |
| `agent_prompt` | `session.prompt(text, { images, streamingBehavior, source:"rpc", preflightResult })`。**不 await 整个回合**：`preflightResult(true)` 触发即返回 success；`false` 后 SDK 会 throw，由 `.catch` 转成 IPC 错误；preflight 成功后的回合内错误只走事件流。与 `rpc-mode.js:298-320` 逐字一致。（`SESSION_BUSY` **不**依赖此时序——`activeTurns` 在 `prepareTurn` 于发送前登记、由 `agent_end` 清除。不 await 的真实理由是延迟与 IPC 处理器不被整回合阻塞。） |
| `agent_steer` / `follow_up` / `abort` | `session.steer(text, images)` / `followUp(text, images)` / `abort()` |
| `agent_set_model` | 由 `args.provider / id` 在 `modelRuntime.getAvailableSnapshot()` 查 `Model` 对象 → `session.setModel(model)`（`setModel` 收对象，`rpc-mode.js:361-366`） |
| `agent_cycle_model` / `get_available_models` | `session.cycleModel(direction)` / `modelRuntime.getAvailableSnapshot()` |
| `agent_set_thinking_level` / `cycle_thinking_level` | `session.setThinkingLevel(level)` / `cycleThinkingLevel()`（同步） |
| `agent_compact` | `session.compact(...)` |
| `agent_abort_retry` | `session.abortRetry()`（今日就是 RPC 命令，非主进程写 settings） |
| `agent_set_auto_compaction` | `session.setAutoCompactionEnabled(enabled)`（内部写 settingsManager） |
| `agent_get_state` / `get_messages` / `get_session_stats` / `get_commands` | 从 `session` / `extensionRunner` 同步读取；**返回形状逐字段复制 `rpc-mode.js` 对应 `case`**（`get_state` 346-359、`get_commands` 543-568），渲染层 `lib/pi.ts` 依赖这些键名 |
| `agent_new_session` / `switch_session` / `fork` / `clone` | `handle.newSession(options)` / `switchSession(path, options)` / `fork(entryId, options)`（内部 `runtime.*`，在 ALS 内） |
| `agent_get_fork_messages` | `session.getUserMessagesForForking()` |
| `agent_set_session_name` | `session.setSessionName(name)` |
| `agent_rewind_to` | `handle.session` 取 `sessionFile` → `findEntryIdByTimestamp` → `handle.fork(entryId)`。后续 `refreshCurrentSession` / `syncSessionFork` / `migrateLegacyGoal` 一个不少（今日 `commandTypes` 里本就是 `'fork'`，差别只是不经 JSONL） |
| `agent_set_mode` | 继续 `session.prompt("/mode …")`（扩展命令） |
| `agent_set_approval` / `exclude_entry` / `restore_entry` | 继续主进程写 settings，不进 AgentSession |

## 事件降级层

`session.subscribe` 直出的 `AgentSessionEvent` 与今日渲染层收到的**不是同一形状**。`rpc-mode.js:265-266` 在 subscribe 回调里 `output(toJsonEvent(event))`。

`toJsonEvent`（`dist/modes/json-event.js`）：

- `message_update`：`{type, message, assistantMessageEvent}` → `{type, usage: message.usage, assistantMessageEvent}`，**`message` 整个删除**；`message.role !== "assistant"` 抛错。
- `assistantMessageEvent` 里**所有**带 `partial` 的事件都删 `partial`（不止 `toolcall_start`）；`toolcall_start` 另补 `id` / `toolName`。

不降级的后果：每 token 一次全量 `AgentMessage` 快照 → 单条消息 O(n²) IPC 结构化克隆；`agentReducer.ts:383` 的 `text || cur.text + textDelta` 从 delta 分支翻到从未被真实数据验证过的快照分支（L364-365 注释「2532/2532 条无 message 字段」描述的正是降级后形状）。

**决定：宿主自持降级层。** `cli/src/json-event.ts` 抄写等价实现——`toJsonEvent` 未从包根导出，`exports` 只暴露 `.` / `./rpc-entry` / `./client` / `./experimental/plugin`，深路径 import 得 `ERR_PACKAGE_PATH_NOT_EXPORTED`（探针实测）。类型 `JsonAgentSessionEvent` **已**导出（`index.d.ts:27`），用它约束抄本返回类型。文件头标注对应上游版本；依赖升级检查清单列为必查。

`extension_error`：`bindExtensions.onError` 回调以 `{type:"extension_error", extensionPath, event, error}` 进同一条事件流（`rpc-mode.js:258-260`）；`agentReducer.ts:465` 依赖它。

## 广播接线

保留今日 `main.ts:166-178` 的顺序与理由：`piRuntime.eventEnvelope(workspace, event, meta)` → `broadcastPiEvent('pi://event')` → `void piRuntime.handlePiEvent(...)`（先转发再落盘，sqlite 同步写不得阻塞本帧 `webContents.send`）。`AgentHost.createHandle` 的 `onEvent(event, meta)` 直接接这个回调体。`handlePiEvent` 无活跃 turn 即丢弃（`PRS:374-376`）是**投影层**行为，与广播无关——不要把 subscribe 只接进 `handlePiEvent`。`meta.source` 由 handle 的 `currentTurnOrigin` 决定（`goal` / `interactive`）。

## SessionUiAdapter

通过 `session.bindExtensions(bindings)` 注入，**await 它**（async，内部 emit `session_start` / `resources_discover`）。`bindings` 全量对齐 `rpc-mode.js:228-262`：

```text
{ uiContext, mode: "rpc",
  commandContextActions: { waitForIdle, newSession, fork, navigateTree, switchSession, reload },
  shutdownHandler, onError }
```

不传 `commandContextActions` 则扩展的 `ctx.newSession / fork / switchSession / reload` 变成返回 `{cancelled:false}` 的空操作（`runner.js:141-146`）；不传 `onError` 则 `extension_error` 消失。`runtime.setRebindSession(() => handle.rebind())` 必须注册——扩展经 `commandContextActions` 替换 session 时宿主才能重绑。

`ExtensionUIContext`（`types.d.ts:68-192`）**28 项全部实现**（清单见 review 附录 B）。硬约束：

- `hasUI` / `mode` **不在**该接口（在 `ExtensionContext`，runner 由 `uiContext !== noOp` 推得）。
- 成员必须是**自有可枚举属性**：runner 以 `{...ui}` 展开包装（`runner.js:273-282`）；用对象字面量，不用类原型方法。
- `select(title, options, opts?)`、`confirm(title, message, opts?)`、`input(title, placeholder?, opts?)` 收第三参 `{signal?, timeout?}`；`editor(title, prefill?)` **无** opts。`custom()` 必须 `async` 返回 `undefined`（runner 对返回值调 `.finally`）。`theme` 给 stub（本仓库扩展未读它）。
- `signal` 语义同 `createDialogPromise`（`rpc-mode.js:47-79`）：已 aborted 立即默认值；abort 事件 → 默认值；超时 → 默认值。`agent-mode/index.ts:250`、`visual-companion/index.ts:71` 在传 `signal`。
- **线协议字段冻结**：请求对象 `{ type:"extension_ui_request", id, method, ... }`，字段与 `rpc-mode.js:83-193` 完全一致——`select: title/options/timeout`、`confirm: title/message/timeout`、`input: title/placeholder/timeout`、`editor: title/prefill`、`notify: message/notifyType`、`setStatus: statusKey/statusText`、`setWidget: widgetKey/widgetLines/widgetPlacement`、`setTitle: title`、`set_editor_text: text`。信封 `{workspace, request, sessionId?, source}`（`main.ts:190-195`）。消费点 `ExtensionUiHost.tsx:157-236`、`PromptRequestCard.tsx:133-203`、`lib/pi.ts:62-72`。
- 回包 `value / confirmed / cancelled`，解析规则同 rpc：`cancelled` → 默认值；`select/input` 取 `value`，`confirm` 取 `confirmed`。
- **Goal 回合**：`isGoalTurn()` 为真时对话请求**不广播**，直接 resolve 默认值——对齐今日 `main.ts:184-188` → `rejectUiRequest`；渲染层本就丢弃 `source==='goal'`。
- 挂起表按 `id`；`abort`、关工作区、session 替换前 `cancelAll()`。

## Goal 回合（每 jsonl 单持有者）

Q1-A 的精确表述：**一个 session 文件同一时刻只被一个 `AgentSessionRuntime` 持有**。「一个 workspace 一个 runtime」不够——Goal 的 `sessionId` 与用户当前可见 session 不同时，在交互 handle 上跑 Goal 回合要么切走可见会话、要么把 Goal 转录写进错误的 session。因此：

- **Goal 的 session 即当前可见 session** → 在交互 handle 上以 `origin:"goal"` 执行：`handle.prompt(goalPrompt(condition), opts, { origin:"goal", config: turnConfig(workspace, cwd, "goal") })`。无文件冲突。
- **Goal 的 session 不是可见 session** → `GoalHost.open(workspace, sessionId, sessionPath)` 以 `SessionManager.open(sessionPath)` 打开该 jsonl 的独立 handle（`origin:"goal"`，不挂 UI 请求广播）。此时交互 handle 不持有该文件，同样无冲突。这保留了 Goal 的后台性质。
- **交互 `switchSession(S)` / `fork` 目标命中 Goal handle 持有的 S** → 先 `goalHandle.dispose()`（abort 当前 Goal 回合，走现有 `agent_end(aborted)` 失败上报，`GoalCoordinator` 重排），再切换。切换后该 Goal 的后续回合落到第一种情形。
- Goal handle 生命周期：随 `unbindGoalSession` / 关 workspace / 上述驱逐而 dispose；空闲不主动关（今日 goal worker 也常驻）。

`turnConfig` 即今日 `workerEnv()` 去掉进程级键（`PI_PACKAGE_DIR` / `PI_RUNTIME_CONFIG` / `PI_GOAL_WORKER` / `PI_ALLOWED_EXTENSIONS`）后的 per-(workspace, source) 配置，进 ALS 而非 env。

今日 11 条 Goal 规则（review 附录 A）**全部保留**在 `PiRuntimeService`：goal 源禁 `SESSION_REPLACING_COMMANDS`；必须自报 sessionId / sessionPath 且校验归属；同 stateKey 活跃则 `queueGoalTurnFromArgs`、`followUp` 拒绝；`goalId / idempotencyKey / revision / nextRound` 校验；`get_state` 不移动可见指针；失败时 `failQueuedGoalTurns` / `drainGoalTurn` 排空；固定 `goalPrompt`、profile `automation`；`migrateLegacyGoal` / `onSessionForked`；UI 请求一律取消；`bind / unbindGoalSession`；身份由 ALS 而非 env。

单持有者带来的**新规则**：

- **交互优先（同 handle 情形）。** 交互 `agent_prompt` 或任何 `SESSION_REPLACING_COMMANDS` 到达交互 handle 时若 `currentTurnOrigin === "goal"`：先 `session.abort()` + `waitForIdle()`，让 Goal 回合以 `stopReason:"aborted"` 的 `agent_end` 走现有失败上报路径（`GoalCoordinator` 负责重排），再执行交互命令。用户可见会话永不被 Goal 阻塞。
- **交互优先（驱逐情形）。** 见上：切换目标命中 Goal handle 持有的文件时先 dispose 它。
- Goal 回合排队与排空沿用今日：同 stateKey 有活跃回合 → `queueGoalTurnFromArgs`；`agent_end` → `drainGoalTurn`。stateKey 仍是 `workspace\0sessionId`，两种情形共用同一套排队表。
- `PI_HUMAN_ORIGIN_TOKEN` 只存在于 ALS config：交互 `'1'`、Goal `'0'`。`PI_GOAL_WORKER` 废止，`origin` 替代。
- `goal/tools.ts:13 currentInput` 模块单例按 workspace 分键（今日注释「一 sidecar 一 session」的前提已破；A 的 `agent_end` 清空后 B 可跳过 `GOAL_CREATE_INTENT_REQUIRED`，安全回归）。
- Goal 工具直接 `new MemoryClient()`（`goal/index.ts:40`）走 Agent Data TCP、不经 in-process port；ALS 提供正确 `AGENT_DATA_ENDPOINT` 后可用，接受。

## 短调用（oneshot / probe / 后台任务）

**Q4 决定：不保留 system worker 形态，直接用 `ModelRuntime.completeSimple / streamSimple`**（`model-runtime.d.ts:89-90`；`oneshot.ts:59-84` 今日已用同一 API）。

- `ModelRuntimeHost.ensure()` 单例；`refresh()` → `modelRuntime.refresh()`（`models.json` 重读；不再对每 session 发 `switch_session`）。
- `resolveDefaultModel()`：`SettingsManager.create(userDataCwd, agentDir).getDefaultProvider() / getDefaultModel()` → `modelRuntime.getModel(provider, id)` 且 `hasConfiguredAuth(provider)` → 否则 `getAvailableSnapshot()` 首个。约 25 行（`findInitialModel` 未导出）。cwd 用 userData 与今日 system worker 一致（`SWM:132`）。
- `describeModel(): Promise<string>` 返回 **`provider/id` 字符串**——`agentData/runtime.ts:63 wikiModelLabel: () => Promise<string>` 与 `expectedModel` 相等比较 → `MODEL_CHANGED` 都依赖这个格式，不改。
- `ShortCallQueue`：串行（今日 `tail`）；per-kind 超时 `goal_judge 60s / wiki_page_generate 60s / memory_extract 30s` 经 `AbortSignal`（`ProviderRequestOptions.signal` 受支持）→ `completeSimple(model, { systemPrompt, messages:[{ role:"user", content, timestamp }] }, { signal })` → 文本取 `content[]`（复用 `oneshot.ts` 的 `formatNonStream`）。
- **语义变化（已接受）**：三类任务不再是带内置工具与 pi 系统提示的 agent 回合。实施前必须核对三个 prompt 构造器只期待文本答复；若任一依赖工具读文件，把内容显式塞进 prompt。`wiki_page_generate` 的 `expectedModel` 检查保留（执行前 `describeModel()` 比对）。
- oneshot（`fixMermaid / diagnose`）：`getModel(provider, modelId)` + `completeSimple / streamSimple`，流式行 `{type:"delta"|"done"|"error"}` 保留给 `onLine`；`activeModel(workspace)` → `agentHost.get(workspace).session.model`（`get model(): Model | undefined`，d.ts:291）。`diagnose` 读的 `usage.completion_tokens / prompt_tokens` 与 pi-ai `Usage {input, output, cacheRead, cacheWrite}` 不符，今日就恒 null——本期不修，记 TODO。
- probe：`runModelProbe / runProbeCli` 是 stdout 包装器，不能当纯函数 import；改 import `collectModels(new ModelRegistry(modelRuntime))` 与 `probeServer + writeToolsCacheEntry`。缓存文件 `~/.pi/mcp-tools-cache.json` 必须继续写（`McpPolicyService.readToolsCache` 读它）。MCP probe 子进程挂主进程下，超时必须 killTree 而非只 `client.close()`。
- 共享 `ModelRuntime` 后各 workspace 扩展的 `registerProvider` 落同一实例——接受（provider 配置本就是全局 `models.json` 语义）。

## Fork 子进程

调用方 `multi-agent/index.ts:371,421,479,564`、`im-platforms/index.ts:284`，签名 `spawnPiAgent(cwd, task, opts)`（`runner.ts:193-208`）不变。

```text
spawn(process.execPath, [workerEntry, ...jsonModeArgs], {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,                          // 全局：PI_RUNTIME_CONFIG、PI_WORKER_ENTRY（宿主启动期设）
    ...currentWorkspaceContext()?.config,    // per-workspace：AGENT_DATA_ENDPOINT / PI_PERMISSION_PROFILE / PI_MCP_CONFIG …
    ...rc.env,                               // profile + memory-off + deny + MCP_SERVERS
    ...(rc.path ? { PI_RUNTIME_CONFIG: rc.path } : {}),
    NODE_NO_WARNINGS: "1",                   // node:sqlite ExperimentalWarning 会混进 stderr 错误文本
    ELECTRON_RUN_AS_NODE: "1",
    PI_IS_SUBAGENT: "1",                     // 末位，不可覆盖
  },
})
```

**env 装配是新工作**：今日 `runner.ts:284` 的 `...process.env` 继承的是 sidecar 的 per-workspace env；主进程没有这些值，必须从 ALS 显式并入。`buildSubagentRuntimeConfig` 读 `process.env.PI_RUNTIME_CONFIG`（`runner.ts:144`）由 Q2-A 保证有值。

**必须逐字保持**：`jsonModeArgs`（`--skill` 在 `--mode` 前、task 末位，`runner.ts:215-239`）；stdout JSONL、`extractFinalText`、`isAgentEndLine`；`onUpdate` 150ms 节流；idle 300s / startup max(2×idle, 300s) / quiet 60s / hard idle×10 / exit-grace 100ms；`killTree`；并发上限 4（`index.ts:21`，`limits.maxConcurrency` 可覆盖）与 `SUBAGENT_MAX_PER_SESSION` 6；`cancel-requests.jsonl`；deny `spawn_agent` + `explore_context`；memory-off 4 键；rc 文件 0o600；`SUBAGENT_MODE=inherit`；子代理用 `allExtensions`（`main()` 路径，`runtime.ts:153`）。**不加** `windowsHide`（今日 runner 无此项；Electron 是 GUI 子系统二进制，不会弹控制台）。

**新增**：`SubagentRegistry`（cwd → child）——今日子代理是被 sidecar 进程树顺带 `killTree` 的（`manager.ts:69-82`、`shutdown.ts:20`），sidecar 消失后无人回收。`WorkspaceHandle.dispose` → `killSubagentsFor(cwd)`；app quit → `killAllSubagents()`。POSIX `killTree` 今日只 `child.kill()` 单进程（`runner.ts:360`）无法收 MCP 孙进程；改 `detached:true` + `process.kill(-pid, "SIGKILL")` 进程组杀（mac/linux 是打包目标，行为变更已知）。

`resolvePiCommand` 读 **`process.env.PI_WORKER_ENTRY`**（宿主启动期设，非用户配置项，不走 `getConfig`），返回 `{ command: process.execPath, args: [entry] }`。`PI_BIN` 只存在于 `runner.ts:58`，删除。

## 打包

**沿用 bundle 策略**：今日 `build-sidecar.mjs:30` 用 `bun build --compile` 把 cli/src + extensions + 两处 node_modules + SDK 全部打进单文件 `pi.exe`，electron-vite bundle 是同一思路，不是新路径。真正的工作：

1. **单份 SDK**：`cli/node_modules/@earendil-works` 只有 pi-coding-agent（pi-ai / pi-agent-core 嵌套其下）；`extensions/node_modules/@earendil-works` 顶层三包。extensions 源码静态 import pi-ai×6、pi-agent-core×1。两份 pi-ai 会造成进程级注册表分裂（`resetApiProviders` / `registerProvider`）。把三包加为 `electron-agent` 依赖，vite `resolve.dedupe` 三包，所有 import 解析到同一份。
2. **external + asarUnpack**：`electron`、`@ast-grep/napi`（须加为 electron-agent 依赖）、`node:*`。**追加**到已有 `asar: true` / `asarUnpack: node_modules/@colbymchenry/**` / `afterPack: package-codegraph.cjs`（`electron-builder.yml:9-12`），不覆盖——`package-codegraph.cjs:13-15` 依赖 unpacked 路径。
3. **`import.meta.url` 相邻资源**：`code-exec/index.ts:16-17`（`runner.py` / `.mjs`）、`fable-behavior/loader.ts:7`（`prompts/`）。bundle 后 `import.meta.url` 指向 `out/main/`，须把这些文件复制到 `out/main/` 对应相对位置。10 处动态 import 全为静态字面量，不阻碍 bundle。
4. `pi-worker` 独立 chunk，asarUnpack，`resolveWorkerEntry()` 打包分支指向 `app.asar.unpacked/out/main/pi-worker.js`。

原生模块实测（Electron 38.8.6 / Node 22.22.0）：`node:sqlite` 与 `@ast-grep/napi` 在主进程与 `ELECTRON_RUN_AS_NODE=1` 均可加载；clipboard 是未安装的 optionalDependency。风险等级：打包后回归验证。

## desktop-control 与身份

`DesktopControlPort` 与 `evaluateToolCall / rememberToolRule / settleToolCall / authorizeDesktopOperation` 签名不变。主进程 `installDesktopControl(inProcessPort)` 直接调 `ToolDecisionService`；通道异常 → `deny`。fork 子进程不安装，继续 Agent Data TCP；`hasUI === false`。

`workspace` 由宿主绑定，扩展不能自报——今日 `mcp/index.ts:59`、`web-search/index.ts:527` 正是把 `process.cwd()` 当 workspace 上报，见下节改造。

`resolveToolOrigin()`：ALS `origin` → 无 ALS 且 `PI_IS_SUBAGENT=1` 为 `subagent` → 否则 `main`。`desktop-control.ts:76` 今日直读 `process.env.PI_GOAL_WORKER`，改读 ALS。

## workspace 上下文传播

**这是本次迁移爆炸半径最大、唯一含安全回归的一块。** 今日全部隔离建立在「一 workspace 一 pi 进程」上。

### ALS 存储与可行性

`extensions/_shared/workspace-context.ts`：`AsyncLocalStorage<{ origin:"main"|"goal", workspace, cwd, config }>`。

**审查已验证（高置信）**：工具执行、`pi.on` 钩子、`steer / followUp` 排队、自动压缩、重试均在 `prompt()` 的 promise 链内（`agent-session.js:821→775` → `agent.js:271` → `agent-loop.js:139/412` → `runner.js:632 await handler`；三文件无 `setTimeout / setImmediate`）。**构造期读取同样可行**：`createRuntime` 内同步 await 求值，只要 `createGrenRuntime` 与 `AgentSessionRuntime` 的 new / switch / fork / reload 都在 `run()` 内调用（`agent-session-runtime.js:137,161,207,225,242,287` 内调 `createRuntime`）。**宿主必须把这些入口全部包进 `run()`。**

**切断点**（回调不在 prompt 的 ALS 内，须闭包绑定 workspace，不能靠 ALS）：`runtime-config.ts:39` fs.watch；`mcp/manager.ts:119 watchMcpConfigFiles`；`im-gateway startGateway` 的 HTTP server；`im-platforms lockTimer / lockHeartbeat`（413,464）与长轮询；`runtime.ts:139-145` 式的 reload 触发；宿主任何未包裹的 IPC / 定时器。

**fs.watch 绑错陷阱**：`ensureStarted()` 在首次 `getConfig` 时惰性创建 watcher（`runtime-config.ts:31-39`）。若首次调用落在某 workspace 的 `run()` 内，此后所有 watch 回调**永久继承该 store**（探针实测）。因此 Q2-A：主进程启动期 `process.env.PI_RUNTIME_CONFIG = runtimeConfigPath` 后立即 `refreshConfig()`（它调 `ensureStarted`），**必须在任何 `run()` 之前**。

### A. per-workspace 配置

今日 `workerEnv()`（`PRS:685-704`）注入：`AGENT_DATA_ENDPOINT`（每 workspace 独立 token，`agentData/runtime.ts:201-211`——**安全**）、`PI_HUMAN_ORIGIN_TOKEN`（**Goal 提权**）、`PI_PERMISSION_PROFILE`（只有 `__system__` 才 `automation`；system worker 删除后恒 `workspace`，键保留）、`PI_MCP_CONFIG`（内联 JSON）、`PI_GOAL_WORKER`（废止）、`PI_ALLOWED_EXTENSIONS`（`allowedPluginIds()` 无 workspace 参数，**本就全局**，改 `createGrenRuntime` 显式入参）、`PI_PACKAGE_DIR`（SDK 仅主题查找，废止）、`PI_RUNTIME_CONFIG`（全局，Q2-A）。

`getConfig(key)`（签名不变，41 个扩展在调）：**ALS config → 落盘文件缓存 → `process.env`**。

**直读 `process.env` 且 per-workspace 的点**（改 `getConfig` 修不到，必须单改）：`goal/tools.ts:34` `PI_GOAL_WORKER`、`:39` `PI_HUMAN_ORIGIN_TOKEN`、`_shared/desktop-control.ts:76` `PI_GOAL_WORKER`。其余 10 处直读为全局或仅子进程变量，不是塌缩点。

### B. `process.cwd()`

7 文件 12 行，分三类：

| 类 | 位置 | 处理 |
| --- | --- | --- |
| 有 `ctx` | `approval/index.ts:53,71`；`mcp/index.ts:59`（execute 第 5 参）；`web-search/index.ts:527` | `ctx.cwd`（`mcp/index.ts:96` 已这么写） |
| watch 回调、无 `ctx` | `approval/index.ts:39`（watchConfig）；`compaction-policy/index.ts:51`（`consumeDesktopPulse`，由 watchConfig:58 调）；`mcp/manager.ts:89,95`（`defaultReadServers`，由 init 与 fs.watch `onConfigChange:181` 调） | 扩展工厂签名 `(pi: ExtensionAPI)` **无 ctx**，`ctx.cwd` 首见 `session_start`（`approval/index.ts:60`）。在 `session_start` 赋 `let cwd`，回调用它；`McpManager` 实例持有 `workspace` 字段 |
| 共享函数、无 `ctx` | `_shared/approval.ts:12 getApprovalPolicy()`（被 `safety:123,165`、`mcp-policy:86`、`multi-agent:311`、`im-platforms:280` 调）；`mcp/manager.ts:119`；`im-platforms/index.ts:114` | 加 `cwd?` 参数，有 ctx 的调用方传 `ctx.cwd`；回退 `currentCwd()`（ALS；这些调用都在工具/钩子链内） |

`writeApprovalPolicy`（`PRS:656-669`）写 workspace 键与 resolved 键到全局 `runtime-settings.json`；今日 sidecar `cwd = resolved` 故键匹配。内嵌后若扩展仍用 `process.cwd()`，`agent_set_approval` 写入的键读不到，`project_trust`（`safety:165`）、`mcp-policy:86` 判错。B 节改造完成即恢复。

### C. 进程级单例与信号钩子

| 位置 | 问题 | 处理 |
| --- | --- | --- |
| `mcp/manager.ts:225` `getMcpManager()` globalThis 单例；`:230-232` `process.on('exit'/'SIGTERM'/'SIGINT')` | 注释明写依赖单进程；每次 new/switch/fork 重建扩展 → 监听器泄漏 | `Map<workspace, McpManager>`，键取 ALS workspace（工厂期在 `run()` 内）；删 `process.on`，`WorkspaceHandle.dispose → disposeMcpManager(workspace)` |
| `goal/tools.ts:13 currentInput` | 模块级；安全回归 | `Map<workspace, GoalInputContext>` |
| `_shared/approval.ts:7 current` | 模块级回退值 | `Map<cwd, ApprovalPolicy>` |
| `_shared/resource-reload.ts:2 listeners` | 模块级 | 广播语义：`requestResourceReload()` 触发所有 handle reload。接受（reload 幂等）。 |
| `im-gateway:26` / `im-platforms:111,421` | 账号级单实例，**不能按 workspace 分键** | `ImBinding`，见下节 |

### D. worker 入口注入

`process.env.PI_WORKER_ENTRY` 由宿主启动期设，`resolvePiCommand` 直读 env。不走 `getConfig`——它优先读落盘文件，用户可写的文件不该能改宿主二进制路径。

### E. reload 的跨 workspace 影响（未核实，列风险）

`session.reload()`（`agent-session.js:2217-2240`）调 `resetApiProviders()` 重置 pi-ai **进程级**注册表。对其他 workspace 在飞请求的影响未核实。处理：reload 只在本 handle `waitForIdle()` 后执行；e2e 观察项「A reload 期间 B 流式回合不中断」。

## IM 绑定（Q3）

`im-gateway`、`im-platforms` 在 `CORE_ALWAYS_ON`（`extension-profile.ts:40-41,69`），随每个交互 session 加载。微信长轮询、锁、状态是**账号级单实例**，进程内只能一份。今日 `gwState().sendUserMessage` / `imState.cwd` 被最后一次 `session_start` 覆盖（`im-gateway:120`；`im-platforms:548`）。

**决定（用户：「独一份会话」）**：`extensions/_shared/im-binding.ts` 进程级单份 `{ workspace, sessionId }`。

- 首个到达的 IM 扩展 `session_start` 声明绑定；同 workspace 后续 `session_start`（切会话）跟随更新 `sessionId` 与 `sendUserMessage`。
- 其他 workspace 的 `session_start` **不覆盖**路由；`ctx.ui.notify("IM 已绑定到 <workspace>", "warning")`。
- owner workspace 关闭 → `releaseImBinding(workspace)`，下一个 `session_start` 可声明。
- gateway HTTP server 只起一次（`gwState().watching`）；无 token 强制 `127.0.0.1`（`im-gateway:50-59`）不变。

解读说明：若「独一份会话」的本意是「IM 拥有独立于任何项目的专属会话」，只需改 `ImBinding` 的声明来源（由宿主创建专属 handle 后声明），其余不变。

## 失败与生命周期

- `WorkspaceHandle.dispose`：`cancelAll` UI → `session.abort()` → 停 subscribe → `disposeMcpManager(workspace)` → `releaseImBinding(workspace)` → `killSubagentsFor(cwd)`。
- 关项目：拆该 workspace 的 handle；Goal 回合随之 aborted，走现有失败上报。
- `AgentSession` 抛错不得打崩主进程；广播 `pi://exit` `{workspace, code, sessionId?, source?}`（`main.ts:197-202`），渲染层按今日 sidecar 退出处理。
- app quit：`agentHost.closeAll()` + `killAllSubagents()`。MCP 不再依赖 `process.on`。
- 短调用失败以 Promise 进入现有 `providerService` / 任务队列错误路径。

## 验证

不打真实 LLM。

宿主骨架：
- 每 workspace 一个 handle；跨项目 session 文件仍 `SESSION_WORKSPACE_MISMATCH`。
- 同项目 `switchSession` 只换 jsonl，不新建 handle；`setRebindSession` 触发重绑（扩展经 `commandContextActions.newSession` 替换 session 后事件仍流出）。
- `bindExtensions` 被 await；`onError` 产出 `extension_error` 事件；`commandContextActions` 六项映射到 runtime / session。
- `message_update` 载荷无 `message` 含 `usage`；≥500 token 流式回放总字节 O(n)。
- `agent_prompt`：`preflightResult(true)` 即返回；`preflightResult(false)` + throw → IPC 错误；preflight 后回合错误不影响返回值；`images / streamingBehavior / source:"rpc"` 转发。
- `agent_set_model` 用 Model 对象；`get_state` / `get_commands` 键集与 `rpc-mode.js` 一致。

SessionUiAdapter：
- 28 项全部存在且为自有可枚举属性；`custom()` 返回 Promise。
- 请求对象字段与 rpc 一致；`select` 在 `respond` 后 resolve；`cancelled` 回默认值；`signal` abort / 超时回默认值；`editor` 无 timeout。
- Goal 回合期间对话请求不广播、立即默认值。

Goal 每-jsonl 单持有者：
- Goal 的 session = 可见 session：回合在交互 handle 执行，`GoalHost` 不开 handle。
- Goal 的 session ≠ 可见 session：`GoalHost` 开独立 handle；交互 handle 不持有该文件。
- 同 handle 情形下 Goal 回合期间交互 `agent_prompt` → Goal 被 abort、`agent_end(aborted)` 上报、交互回合执行。
- 交互 `switchSession` 命中 Goal handle 持有的文件 → 该 handle 先 dispose，再切换；切换后同一 Goal 的下一回合落到交互 handle。
- 交互回合活跃时 Goal 入队，`agent_end` 后排空（stateKey 仍为 `workspace\0sessionId`）。
- Goal 回合内 `resolveToolOrigin() === "goal"`、`PI_HUMAN_ORIGIN_TOKEN === "0"`；`GOAL_CREATE_FORBIDDEN` 生效；事件 `source:"goal"`。
- A 的 `agent_end` 不清空 B 的 `currentInput`。

workspace 上下文：
- 启动后 `process.env.PI_RUNTIME_CONFIG` 已设且 watcher 在 ALS 外创建（watch 回调内 `currentWorkspaceContext()` 为 undefined）。
- A / B token 不同；`PI_MCP_CONFIG` 互不可见；`__system__` 不再存在。
- 12 处 `process.cwd()` 改造后读到 `ctx.cwd` / ALS cwd；`getApprovalPolicy(cwd)` 与 `writeApprovalPolicy` 键匹配。
- `getMcpManager()` 按 workspace 分键，`onConfigChange` 用实例持有的 workspace；关 A 不影响 B；无 `process.on`。
- ImBinding：第二 workspace 不覆盖路由；owner 关闭后可重新声明。

短调用：
- `describeModel()` 返回 `provider/id`；`MODEL_CHANGED` 检查保留；三类任务经 `completeSimple`，超时 abort。
- oneshot 流式行形状不变；`activeModel` 来自 `session.model`。
- probe 不 spawn；MCP 缓存文件仍写入。

Fork：
- command 为 `process.execPath`，args 含 worker 与 `--mode json`，env 含 `ELECTRON_RUN_AS_NODE / PI_IS_SUBAGENT / AGENT_DATA_ENDPOINT / PI_RUNTIME_CONFIG`；不含 `pi.exe`。
- 关 workspace 后该 cwd 的子代理被 kill；app quit 全部 kill。

打包：
- 产物不含 `resources/pi`；`asarUnpack` 仍含 `@colbymchenry/**`；`pi-worker.js` 可 spawn；`code-exec/runner.py`、`fable-behavior/prompts` 在 `out/main` 可达；`@earendil-works/pi-ai` 单实例（`require.resolve` 两处一致）。

## 不在范围内

- `tauri-agent/` 任何改动；渲染层控件、IPC 重命名。
- 同项目多会话真并发；Goal 与可见 session 同文件时的并行执行（单持有者下必然串行）；子代理进程内化。
- `utilityProcess.fork`、MessagePort 审批通道；OS 沙箱；fork Pi 上游。
- Agent Data 协议重做；`diagnose` usage 字段修复（TODO）。
- IM 专属会话（若 Q3 解读有误再议）。

## 实现计划拆分

五份只服务执行顺序与审查粒度，不对应可发布产品：

1. **宿主骨架**：`json-event.ts`、`workspace-context.ts`（ALS 存储）、`createGrenRuntime`、`ModelRuntimeHost`（单例）、`SessionUiAdapter`、`WorkspaceHandle`、`AgentHost`、`PiRuntimeService` 交互路径、主进程启动期 Q2-A。
2. **workspace 上下文消费点**：`getConfig` 接 ALS、3 处直读 env、12 处 `process.cwd()`、MCP 分键、`goal/tools` / `approval` 单例、`ImBinding`、隔离回归。
3. **Goal 每-jsonl 单持有者与短调用**：Goal 路由（命中可见 session → 交互 handle；否则 `GoalHost`）+ 交互优先 + 驱逐；`resolveDefaultModel / describeModel`；`ShortCallQueue` 替代 system worker；oneshot / probe 进程内。
4. **pi-worker 与 fork**：worker 入口、spawn env 装配、`SubagentRegistry`、POSIX 进程组、`PI_WORKER_ENTRY`。
5. **删除与打包**：删 sidecar / JSONL / SWM；bundle + dedupe + asarUnpack 追加 + 资源复制；打包冒烟；文档。

第 2 份必须先于第 3、4 份（身份判定依赖 ALS 消费点就位）。第 5 份未完成前主线不合并。