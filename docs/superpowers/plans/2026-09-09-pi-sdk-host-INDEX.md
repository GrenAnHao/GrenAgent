# Pi SDK 宿主迁移 · 计划索引

**规格：** `docs/superpowers/specs/2026-09-09-electron-pi-sdk-host-design.md`（2026-09-10 按审查定稿）

**审查：** `docs/superpowers/specs/2026-09-09-electron-pi-sdk-host-design-review.md`

五份计划只服务执行顺序与审查粒度，**不对应可发布的中间产品**。规格明确禁止双栈：不允许发布「主 Agent 已 SDK、子代理仍 sidecar」的中间态。

本索引已按审查第四节与定稿规格修订。旧 INDEX 里「ALS 建在第 2 份」「Goal 必须双 runtime」「三条进包阻断项」等说法作废。

## 执行顺序

| # | 计划 | 核心产出 | 依赖 |
| --- | --- | --- | --- |
| 1 | [宿主骨架与事件降级层](./2026-09-09-pi-sdk-host-1-foundation.md) | `cli/src/pi-sdk.ts`、`json-event.ts`、`createGrenRuntime`（转发 `modelRuntime` + `allowedExtensionsJson`）、ALS **存储**、`ModelRuntimeHost`、`SessionUiAdapter`（28 项）、`WorkspaceHandle` / `AgentHost`、Q2-A `runtimeConfigBootstrap`、`PiRuntimeService` 交互路径 | — |
| 2 | [workspace 上下文消费点](./2026-09-09-pi-sdk-host-2-workspace-context.md) | **不重建 ALS**；`getConfig` 接 ALS；3 处直读 env；**12 处** `process.cwd()`（7 文件）；MCP / approval / `currentInput` 分键；进程级 `ImBinding`；`onDispose` 接 MCP / IM | 1 |
| 3 | [Goal 每-jsonl 单持有者与短调用](./2026-09-09-pi-sdk-host-3-goal-and-short-calls.md) | Q1-A：命中可见 session → 交互 handle + `origin:"goal"`，否则 `GoalHost` + `SessionManager.open`；交互优先 + 驱逐；Q4：`completeSimple` / `streamSimple`（**不是**第三套 runtime）；`describeModel()` 返回 `provider/id` | 1, 2 |
| 4 | [pi-worker 与 fork 子进程](./2026-09-09-pi-sdk-host-4-fork-worker.md) | `pi-worker.ts`（只跑 `main()` json/print）；`resolvePiCommand` 读 `PI_WORKER_ENTRY`；ALS config 并入 spawn env；`subagentProcessRegistry`（cwd→child，**不是** SQLite `SubAgentRegistry`）；POSIX 进程组杀 | 2（建议在 3 之后） |
| 5 | [sidecar 删除与打包清单](./2026-09-09-pi-sdk-host-5-cleanup-and-packaging.md) | 删 `PiClient` / `manager` / `build-sidecar` / `resources/pi`；三包 SDK `dedupe` + bundle；`@ast-grep/napi` 依赖 + asarUnpack **追加**；复制 `import.meta.url` 资源；打包冒烟 | 1–4 |

**第 2 份必须先于第 3、4 份。** Goal 与子代理的身份判定都依赖 ALS **消费点**就位（存储本身在第 1 份）。

**第 3、4 份无强依赖**，建议第 3 份先做（短调用先离开 sidecar），再做 fork。

**第 5 份完成前主线不合并。**

## 三个止损检查点

失败就停，不要绕过：

1. **第 1 份任务 3** —— ALS 若无法穿透 `setTimeout`，整个方案前提不成立。（旧 INDEX 误写在第 2 份任务 1。）
2. **第 1 份任务 7** —— ALS 若无法穿透 SDK 构造链 / `session.prompt`，方案退化为「handle 入参显式透传」，须重写第 2 份消费点。（旧 INDEX 误写在第 2 份任务 2。）
3. **第 5 份任务 5** —— 打包冒烟失败时不得通过恢复 sidecar 来「先发一版」。也不得改走「复制 `../extensions` + 其 `node_modules`」。

## 三个包，三套测试运行器

| 包 | 运行器 | 命令 |
| --- | --- | --- |
| `cli/` | `node --test` + tsx | `cd cli && node --import tsx --test "src/**/*.test.ts"` |
| `electron-agent/` | vitest（projects: main / renderer） | `cd electron-agent && npx vitest run --project main` |
| `extensions/` | vitest（package.json 无 scripts） | `cd extensions && npx vitest run` |

类型检查门槛（第 1 份已改）：`cd electron-agent && npx tsc -p tsconfig.node.json --noEmit`。`tsc -p tsconfig.json` 是 solution-style 空转，不要当验收。

## 规格已裁定、计划必须遵守的决策

| 编号 | 裁定 | 落点 |
| --- | --- | --- |
| Q1-A | 每 jsonl 单持有者。Goal = 可见 session → 交互 handle + `origin:"goal"`；≠ → `GoalHost`。交互优先：同 handle 上 Goal 占用则 `abort` + `waitForIdle`；`switchSession` / `fork` 命中 Goal 文件先 dispose | 第 3 份 |
| Q2-A | 启动期设 `process.env.PI_RUNTIME_CONFIG`，任何 ALS `run()` 前 `refreshConfig()` / `ensureStarted()` | 第 1 份任务 9 |
| Q3 | IM 是账号级单实例，**不能**按 workspace 分 Map。进程级一份 `{workspace, sessionId}`；首个 `session_start` 声明；他 workspace 不覆盖并 `notify`；owner 关闭后可再声明 | 第 2 份任务 8 |
| Q4 | 短调用用 `ModelRuntime.completeSimple` / `streamSimple`，不要第三套 `AgentSessionRuntime`。`describeModel()` 必须返回 `provider/id` 字符串 | 第 3 份 |

## 各份禁止再写的错误（审查第四节摘要）

### 第 1 份

- `createGrenRuntime` 不得带入 `runtime.ts` 的 `process.on` 静默吞错；必须转发 `modelRuntime`。
- `SessionUiAdapter` 必须 28 项自有可枚举；线协议是 `method / title / options / statusKey…`；`custom` 必须 async；Goal 回合立即默认值。
- `bindExtensions` 必须 await；只注册 `setRebindSession`，**绝不二次 rebind**。
- `preflightResult` 仅 `true` 时 resolve；转发 `images` / `streamingBehavior` / `source:"rpc"`。
- Electron 侧只经 `cli/src/pi-sdk.ts` 取 SDK。第 1 份不加 electron-agent 的 SDK 依赖（第 5 份才 `dedupe`）。

### 第 2 份

- **禁止重建 ALS。**
- 「activate 闭包捕获 `ctx.cwd`」不成立（工厂签名无 ctx）。正确：`let workspaceCwd`，`session_start` 赋值。
- IM 不按 workspace 分 Map。
- `PI_ALLOWED_EXTENSIONS` 不走 ALS（第 1 份已显式入参）。
- cwd 是 **12 处 / 7 文件**，不是 6 处。

### 第 3 份

- 禁止「Goal 与交互共享同一 jsonl，必须双 runtime」。
- 禁止假 API：`complete({prompt, model:string})`、`result.text`、`snapshot.models`、`displayName`、`resolveModelId(): string`。
- 禁止把 `describeModel` 改成 `{id, displayName}`。
- 禁止把 `runModelProbe` / `runProbeCli`（写 stdout、返回 void）当纯函数 import。
- 11 条 Goal 规则全部留在 `PiRuntimeService`。

### 第 4 份

- 真实签名是 `spawnPiAgent(cwd, task, opts)`，不是 `({prompt, cwd}, {spawn})`。
- **不加** `windowsHide`。
- 必须保持：`--skill` 在 `--mode` 前、task 末位、`explore_context` deny、hard idle×10、exit-grace 100ms、`partial`、`SUBAGENT_MODE=inherit`、`PI_IS_SUBAGENT` 末位不可覆盖。
- env 必须并入 `currentWorkspaceContext()?.config`。
- 必须有 cwd→child 登记与关项目 / 退出回收；POSIX `killTree` 用进程组。
- 新登记表不要复用 SQLite `SubAgentRegistry`（`registry.ts`）。

### 第 5 份

- 没有 `electron/app/runtimePaths.ts`；没有 electron-agent 的 `PI_BIN` 设置项。
- 不要 external 嵌套的 `cli` 树 `pi-ai`；不要覆盖 `@colbymchenry` / `afterPack`；不要复制 `../extensions`。
- 工作是：沿用 bundle，处理两套 SDK 副本 + `import.meta.url` 资源 + `@ast-grep/napi` 依赖。
- 产物目录是 `electron-agent/release/`，不是 `dist/`。

## 已处理的低估点（不必再当遗留）

写计划时的代码调研曾标成「规格未覆盖 / 待验证」，现已有结论：

| 旧说法 | 结论 | 落点 |
| --- | --- | --- |
| `goal/tools.ts` 直读 `process.env` | 只改 `getConfig` 修不到；改 ALS + sidecar 期 env 回退 | 第 2 份任务 2 |
| `approval` watch 回调无 `ctx` | `session_start` 赋 `let cwd`，不是 activate 捕获 | 第 2 份任务 5 |
| `PI_ALLOWED_EXTENSIONS` 构造期 ALS 可能未建立 | 显式入参，不走 ALS | 第 1 份 `createGrenRuntime` |
| `ModelRuntime.complete` 是否支持 `signal` | 支持（`completeSimple` 第三参） | 第 3 份 |
| probe 是否带 CLI 副作用 | 写 stdout、返回 void；用 `collectModels` / `probeServer` + `writeToolsCacheEntry` | 第 3 份 |
| ALS 穿透 `setTimeout` / SDK 构造链 | 第 1 份止损探针，不是第 2 份 | 第 1 份任务 3 / 7 |

## 跨计划必须一致的标识符

实施时名称以各份正文为准，索引只防写岔：

| 标识符 | 含义 |
| --- | --- |
| `runInWorkspace` / `currentWorkspaceContext` / `currentCwd` | 第 1 份创建，第 2 份消费 |
| `WorkspaceHandle.prompt(text, options, origin)` / `currentTurnOrigin` | 第 1 份；第 3 份 Goal 复用 |
| `turnConfig` | 不含 `PI_PACKAGE_DIR` / `PI_RUNTIME_CONFIG` / `PI_GOAL_WORKER` / `PI_ALLOWED_EXTENSIONS` |
| `describeModel()` | 返回 `` `${provider}/${id}` `` |
| `completeSimple` / `streamSimple` | 短调用唯一 API |
| `PI_WORKER_ENTRY` | 宿主启动期 env，不走 `getConfig` |
| `resolvePiCommand()` | `{ cmd: process.execPath, baseArgs: [entry] }` |
| `buildSubagentLaunch(cwd, task, opts)` | 第 4 份抽出的纯函数；`spawnPiAgent` 签名不变 |
| `registerSubagentProcess` / `killSubagentsFor` / `killAllSubagents` | 第 4 份进程表 |
| `copyPiAdjacentAssets` | 第 5 份复制 `runner.py` / `runner.mjs` / `prompts/` |
| `onDispose(workspace, cwd)` | 第 2 份接 MCP / IM；第 4 份接 `killSubagentsFor(cwd)` |

## 实现前工作树提醒

当前仓库已有大量未提交改动（与本迁移并行）。**开始执行第 1 份之前**必须另议这些改动的去向（另开分支 / 先提交 / stash），不要把五份计划的提交和无关 diff 混在一起。
