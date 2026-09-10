# Electron 内嵌 Pi SDK 规格 · 子代理审查报告

**审查对象：** `2026-09-09-electron-pi-sdk-host-design.md`（303 行）及 `plans/2026-09-09-pi-sdk-host-{1..5}-*.md`  
**审查方式：** 4 个只读子代理按章节分域，以代码为唯一依据独立核实，不信任规格与计划文本。每条结论带 `file:line`（行号均已在实际文件中重新定位）。  
**SDK 版本：** `@earendil-works/pi-coding-agent@0.85.1`。pi-ai / pi-agent-core 嵌套在 `cli/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/` 下。

缩写：`PRS` = `electron-agent/electron/app/piRuntimeService.ts`；`SWM` = `electron-agent/electron/pi/systemWorkerManager.ts`；`MAIN` = `electron-agent/electron/main.ts`；`SDK` = `cli/node_modules/@earendil-works/pi-coding-agent/dist`。

---

## 一、推翻规格前提的发现（10 项，实施前必须改规格）

### 1. 「Goal 与交互共享同一 jsonl」从未落地

- `electron-agent/electron/pi/manager.ts:112` 给 Goal worker 拼 `--session <path>`，但 `cli/src/runtime.ts:102-112` 的 rpc 分支不解析 argv，固定 `SessionManager.create(cwd)` 新建会话；`runRpcMode(runtimeHost)` 不收 argv（`SDK/modes/rpc/rpc-mode.d.ts:19`）。全仓无其他消费者。按 `PRS:557-561` 应抛 `GOAL_WORKER_SESSION_MISMATCH`（未实测）。
- 后果：规格《目标进程模型》「Goal 必须是第二套 runtime」建立在一个不存在的基线上。Goal 双 worker 路径可能从未真机跑通，**不能以「保持今日行为」作验收**。
- 叠加：session 写入是无锁 `appendFileSync`，首刷 `openSync('wx')` 独占创建，打开时加载一次不监听（`SDK/core/session-manager.js:620-640,739-767`）。两个进程内 runtime 持同一 jsonl 各按自己 `leafId` 追加 → 树分叉、内存与磁盘失同步；交互 runtime 看不到 Goal 回合直到 `switchSession`/`reload`。
- **需决策**（见第五节 Q1）。

### 2. 主进程自身没有 `PI_RUNTIME_CONFIG`，runtime-config 文件层整体失效

- `MAIN:88,225` 只把 `runtimeConfigPath` 传给子进程 env；主进程 `process.env` 无此变量 → 内嵌后 `runtime-config.ts:15-22` 的 `configPath()` 为空。
- 后果：审批档位、context exclusion 脉冲、`SKILLS_DISABLED`、`PI_RELOAD_REV` 全断；`runner.ts:144-170` 派生子代理配置也丢。规格 D 节「落盘文件赢过 env」的前提在主进程内不成立。
- 叠加（更危险）：`fs.watch` 在首次 `getConfig` 时惰性创建（`runtime-config.ts:31-39`）。若首次调用落在某 workspace 的 ALS `run()` 内，此后所有 watch 回调**永久继承该 store**——探针实测：A 内建 net server，B 触发，回调读到 A。`watchConfig` 订阅者会静默读到「第一个 workspace」的配置，比读不到更危险。`im-gateway` 的 HTTP server 同理。
- 文件本身是全局单份、键已按 workspace 命名空间化（`settingsService.ts:4-11` ≡ `_shared/approval.ts:22-24`），缓存不塌缩。
- **需决策**（Q2）。

### 3. 子代理 env 链断裂——「环境派生与现在相同」不成立

- `runner.ts:284-298`：子进程 env = `...process.env` + rc.env。今日 `AGENT_DATA_ENDPOINT / PI_RUNTIME_CONFIG / PI_PACKAGE_DIR / PI_MCP_CONFIG / PI_ALLOWED_EXTENSIONS / PI_PERMISSION_PROFILE` 全靠 sidecar 自身 env 继承（`PRS:686-702`）。
- 内嵌后 Electron `process.env` 没有这些值（`electron/` 下无 `process.env.X =` 赋值），`buildSubagentRuntimeConfig` 直读 `process.env.PI_RUNTIME_CONFIG`（`runner.ts:144`）→ 不派生文件、丢 MCP token、审批 TCP 连不上。
- 规格与第 4 份计划均无任务覆盖。必须从 ALS / `workerEnv` 显式装配子进程 env。

### 4. 无人回收子代理

- `processRegistry` 只登记 sidecar（`manager.ts:120`）；`closeWorkspace`（`PRS:192-262`）→ `manager.close` → `registry.killTree(sidecar pid)`（`manager.ts:69-82`），子代理是被 sidecar 进程树顺带收掉的；`shutdown.ts:20 killAll` 同理。
- sidecar 消失后子代理成主进程直接子进程。规格 L242「对该 cwd 仍在跑的 fork 子代理 killTree」今日是副产品，须新建 cwd→pid 登记，否则退出/关项目泄漏子代理与 MCP 孙进程。
- 另：`killTree` 仅 win32 走 `taskkill /F /T`（`runner.ts:351-353`），POSIX 为 `child.kill()` 单进程无进程组（`:360`）；mac/linux 是打包目标（`electron-builder.yml:19-22`）。

### 5. `bindExtensions` 只传 `{uiContext, mode}` 会丢三样

- `ExtensionBindings`（`SDK/core/agent-session.d.ts:140-147`）；官方 rpc 全传（`rpc-mode.js:230-262`）。
- `onError` 不传 → `runner.emitError` 无监听（`runner.js:411-415`）→ 渲染层依赖的 `extension_error`（`agentReducer.ts:465`）消失。
- `commandContextActions` 不传 → `ctx.newSession / fork / switchSession / reload` 变成返回 `{cancelled:false}` 的空操作（`runner.js:141-146`）。
- `shutdownHandler` 不传。
- 且 `bindExtensions` 是 **async**，内部 emit `session_start` / `resources_discover`（`agent-session.js:1906-1928`），必须 await。第 1 份任务 5 未 await。

### 6. 广播链路接线错误

- 规格 L41 说 `subscribe → onEvent → adaptPiEvent → broadcastPiEvent`。实际：`pi://event` 广播由 `PiManager.onEvent` 在 `MAIN:166-178` 直接 `broadcastPiEvent`，**先于** `handlePiEvent`；`adaptPiEvent` 只做 sqlite 落盘投影不外发（`PRS:383-386`）；`handlePiEvent` 无活跃 turn 即丢弃（`PRS:374-376`）。
- 后果：若新宿主只把 subscribe 接进 `handlePiEvent`，回合外事件（`session_info_changed`、`queue_update` 等）到不了渲染层。

### 7. IM 平台随主进程加载，与规格 L7 矛盾

- `im-gateway`、`im-platforms` 在 `CORE_ALWAYS_ON`（`extension-profile.ts:40-41,69`），随每个交互 session 加载，仅子代理跳过（`im-gateway:116`；`im-platforms:542`）。独立的只是每轮 `spawnPiAgent`（`im-platforms:284`）。
- 后果：微信长轮询、锁（`lockTimer / lockHeartbeat` :413,464）、状态全进主进程；`globalThis.__grenImGateway` 的 `sendUserMessage` / `cwd` 被最后一次 `session_start` 覆盖（`im-gateway:120`；`im-platforms:548`）→ 消息路由到「最后启动」的会话。
- 第 2 份任务 8「im-* Map 分键」**方向错**：微信连接是账号级单实例，不能按 workspace 复制。
- **需决策**（Q3）。

### 8. System worker 今日是完整 agent 回合，`completeSimple` 会改语义

- 每任务 `new_session`（`SWM:93`）、pi 系统提示、内置工具、持久化 jsonl 到 userData；仅扩展为空（`cli/src/runtime.ts:56`）。
- `completeSimple` 无工具无系统提示 → `goal_judge` / `memory_extract` / `wiki_page_generate` 语义改变，需重新验证。
- `describeModel` 返回 `provider/id` 字符串（`SWM:74`），消费方 `agentData/runtime.ts:63,280` 类型 `Promise<string>`，与 `expectedModel` 相等比较 → `MODEL_CHANGED`（`SWM:96-99`；`MAIN:112`）。第 3 份任务 4 改返 `{id, displayName}` 会破坏它。
- **需决策**（Q4）。

### 9. `goal/tools.ts:13 currentInput` 模块级单例——安全回归

- 注释「一 sidecar 一 session」。A 的 input 覆盖 B 的、A 的 `agent_end` 清空（`goal/index.ts:117,128`）→ B 的 `create_goal` 在 L48 `if (currentInput)` 为空时跳过 `GOAL_CREATE_INTENT_REQUIRED`。
- 规格与第 2 份任务 4 均未提。同类模块级单例：`_shared/approval.ts:7 current`、`_shared/resource-reload.ts:2 listeners`——规格 C 节只查了 `globalThis`，ESM 模块作用域同样跨 workspace 共享。
- Goal 直接 `new MemoryClient()`（`goal/index.ts:40`；`tools.ts:74`）不经 `desktopControl()` → 规格 L179 in-process port 覆盖不到 Goal。

### 10. 审批档位的真实读取点漏掉

- `_shared/approval.ts:12` 的 `getApprovalPolicy()` 本体用 `process.cwd()`，被 `safety:123,165`、`mcp-policy:86`、`multi-agent:311`、`im-platforms:280` **无 ctx** 调用。规格 B 节的 6 处清单没有它；第 2 份任务 5 修不到。
- `process.cwd()` 实际 7 文件 12 行（非 6 处）；`im-platforms` 行号应为 114。
- 内嵌后 `writeApprovalPolicy`（`PRS:656-669`）写的 workspace 键与扩展 `process.cwd()` 读的键不匹配。仅 `toolDecisionService.ts:29-31` 以 `ctx.cwd` 查 live 表兜底工具判定；`project_trust`（`safety:165`）、`mcp-policy:86`、状态回推仍错。

---

## 二、规格事实错误（改文字即可）

### 已确认边界

- L8 `utilityProcess.fork` 支持 `env / cwd / execArgv / stdio:'pipe'`（暴露 `stdout/stderr/pid`，仅 stdin 固定 ignore——runner 本就 ignore）；`killTree` 只用 pid（`runner.ts:350-353`），utilityProcess 同样可 `taskkill /T`。结论可保留，理由须改为「只能在 app ready 后的主进程调用，非普通可执行文件」。

### IPC 映射

- L59 `SESSION_BUSY` **不**依赖 prompt 早返回：`activeTurns` 在 `prepareTurn`（`PRS:331-333→737`）于 `client.send`（L335）之前登记，由 `agent_end` 清除（L409）。不 await 的决定仍正确（延迟、与 rpc 对齐），但真实代价是 IPC 处理器被整回合阻塞。
- L64 `abort_retry` 是 `session.abortRetry()`（`agent-session.d.ts:560`）；`set_auto_compaction` 是 `session.setAutoCompactionEnabled`（d.ts:529，内部写 settingsManager）。今日二者都是 RPC 命令（`PRS:32-33`），非主进程写 settings。
- `setModel(model: Model)` 收对象（d.ts:453），需先在 `modelRuntime.getAvailableSnapshot()` 查（`rpc-mode.js:361-366`）；`setThinkingLevel` / `cycleThinkingLevel` 同步（d.ts:470,475）。
- `prompt` 应转发 `source:"rpc"`、`images`、`streamingBehavior`（`rpc-mode.js:303-306`）；`InputSource` 默认 `"interactive"`（`types.d.ts:655`）。
- `preflightResult?: (success: boolean) => void`（`agent-session.d.ts:158-159`）：成功回调 `true`（js:832/845/870/948），失败先回调 `false` 再 throw（js:942）；Promise 在整回合后才 resolve（js:949）。

### 事件降级层

- `toJsonEvent` 对**所有**带 `partial` 的 `assistantMessageEvent` 都删 `partial`（`json-event.js:10-14`），非仅 `toolcall_start`；`message.role !== "assistant"` 抛错（L20-22）。
- 类型 `JsonAgentSessionEvent` **已**从包根导出（`index.d.ts:27`），可约束抄本的返回类型。


### *SessionUiAdapter*

- *L104 `editor(title, prefill`*`?)` 无 opts（`types.d.ts:135`），官方 rpc 也无 timeout/signal；仅 `select / confirm / input` 收第三参 `{signal?, timeout?}`（`types.d.ts:36-41`）。
- L109 今日 Goal UI 请求**从不广播**：`MAIN:184-188` 直接 `rejectUiRequest` 回 `cancelled`（`PRS:517-524`），渲染层丢弃 `source==='goal'`（`ExtensionUiHost.tsx:155`）。Goal 适配器应直接 resolve 取消值。
- `hasUI` / `mode` **不在** `ExtensionUIContext`，在 `ExtensionContext`（`types.d.ts:213-215`），runner 推得：`hasUI = uiContext !== noOp`（`runner.js:318-320`）。
- `readonly theme` 必须存在（`types.d.ts:175`）：包根不导出 `theme` 单例，它是未 `initTheme()` 即抛的 Proxy（`theme.js:540-546`）；本仓库扩展未读 `ui.theme`（grep 空），可给 stub。
- runner 以 `{...ui}` 展开包装（`runner.js:273-282`）：适配器成员必须是**自有可枚举属性**，类原型方法会丢；5 个对话方法必须返回真 Promise（`run().finally(finish)`，`runner.js:283-302`）。
- 线协议字段名是渲染层契约：`method / title / message / options / placeholder / prefill / statusKey / statusText / widgetKey / widgetLines / widgetPlacement / notifyType / text`（`rpc-mode.js:84-193`），消费点 `ExtensionUiHost.tsx:157-236`、`PromptRequestCard.tsx:133-203`、`lib/pi.ts:62-72`；`get_state` / `get_commands` 返回形状同理（`rpc-mode.js:346-359, 543-568`）。
- **`signal` 遗漏**：对话 opts 含 `signal`，官方 abort 即 resolve 默认值、已 aborted 立即返回（`rpc-mode.js:47-63`）。本仓库扩展在用：`agent-mode/index.ts:250`、`visual-companion/index.ts:71`。不实现则这些请求永不结束。

### Fork 子进程

- L121-126 `windowsHide: true` 不在 `runner.ts:279-299`（它在 rpc sidecar 的 `manager.ts:116`）。
- L128/134 并发上限在 `multi-agent/index.ts:21` 非 runner，`limits.maxConcurrency` 可覆盖（`:549`）；另有 `SUBAGENT_MAX_PER_SESSION` 默认 6（`index.ts:284-296`）；超时漏 hard = idle×10（`runner.ts:462`）与 exit-grace 100ms（`:311`）；deny 另含 `explore_context`（`:163`）；`SUBAGENT_MODE=inherit`（`:40-44`）；`PI_IS_SUBAGENT` 末位不可覆盖（`:295-297`）。
- 子代理走 `main(argv)`（`runtime.ts:152-153`）→ `SDK/cli/args.js:40-208` 解析 `--mode / --session / --no-session / -p / --tools / --skill / --append-system-prompt / --no-approve` ✓；但子代理用 `allExtensions` 非 profile 过滤集（`:153` vs `:55`）。


### Goal / 短调用

- L147 `describeModel` 复现量级估高：`findInitialModel`（`SDK/core/model-resolver.js:472-533`）对本场景只剩 3 步：settings `defaultProvider` + `defaultModel`（`settings-manager.js:454-459`，交互 `set_model` 会写回它，`agent-session.js:1263`）→ `getModel` + `hasConfiguredAuth` → `getAvailableSnapshot()` 匹配 `defaultModelPerProvider` 表 → 首个可用。`SettingsManager` 已导出（`index.d.ts:20`）；`findInitialModel` / 默认表未导出，复现约 25 行，须抄一份 provider 默认表。
- L141 `fixMermaid` 还靠 `activeModel` = 交互 worker `get_state().model`（`MAIN:279-288`），需一并迁到 `WorkspaceHandle`；`diagnose` 读 `usage.completion_tokens / prompt_tokens`（`providerService.ts:133-136`），pi-ai `Usage` 是 `input / output / cacheRead / cacheWrite`（`types.d.ts:265-277`），**今日统计恒 null**。
- L143 `runModelProbe` / `runProbeCli` 是 stdout 包装器、返回 void（`cli/src/probe-models.ts:46-50`；`extensions/mcp/probe.ts:49,54,63` 读 argv[3]、写 `~/.pi/mcp-tools-cache.json`）；可 import 的是 `collectModels(new ModelRegistry(rt))`、`probeServer` + `writeToolsCacheEntry`。缓存文件是 `McpPolicyService.readToolsCache`（`mcpPolicyService.ts:37`）的数据源，不能丢。`probeServer` 进程内运行使 MCP 子进程挂在 Electron 主进程下，超时仅 `client.close()`（`probe.ts:35-43`）。
- `refreshModelRegistry`（`PRS:530-542`）对 `manager.all()` 全部客户端（含 `__goal__:`）发 `switch_session`；models.json 重读靠 `ModelRuntime.refresh()`。
- 「一份 ModelRuntime」需 `createGrenRuntime` 接收并转发 `modelRuntime`：今日 `runtime.ts:50-70` 未传 → `createAgentSessionServices` 每次 `ModelRuntime.create`（`agent-session-services.js:56-61`），每次 new/switch/fork 都重建。选项见 `agent-session-services.d.ts:31`。共享后各 workspace 扩展的 `registerProvider` 落到同一实例（`agent-session-services.js:70-74`；合并语义 `model-runtime.js:558-570`）。
- sidecar 引用还有 `MAIN:80/82/165/223/274/289`、`PRS:113`（`processCommand` 选项从未使用）、`resolvePiPackageDir` → `PI_PACKAGE_DIR`（`MAIN:87,213,224,289,373`；`PRS:688`）。`PI_PACKAGE_DIR` 在 SDK 仅用于主题查找（`config.js:311-321`）；`applyOfficialMainPackageDir`（`official-package-dir.ts:68-75`）只在 `main()` 路径生效。
- `electron/app/runtimePaths.ts` 不存在，仅 `electron/runtimePaths.ts:14-48`。`PI_BIN` 在 electron-agent 无设置项，只有 `runner.ts:58`。


### 打包清单

- L164 `electron-builder.yml:9-12` **已有** `asar: true`、`asarUnpack: node_modules/@colbymchenry/**`、`afterPack: package-codegraph.cjs`（`package-codegraph.cjs:13-15` 依赖 unpacked 路径）。第 5 份任务 4 step4 的 yaml 会覆盖掉它们，破坏 CodeGraph。
- 今日 extensions 进包方式：`bun build ./src/main.ts --compile` → 单文件 `pi.exe` 127MB（`build-sidecar.mjs:30`），cli/src + extensions + 两处 node_modules + SDK **全部 bundle**（二进制内含 `extensions/multi-agent/runner`、`ast-grep-napi.win32-x64-msvc.node` 字串）；`resources/pi` 仅 pi.exe，无 .node；复制 SDK theme/assets 等 5 目录为空操作。三条「无进包路径」字面成立，但「阻断项」定性偏差——**今日即 bundle，方案 A 是沿用，方案 B（复制 + `../../extensions` 相对路径）才是从未验证的路径**。
- 真正工作量：(1) 两套 SDK 副本——`cli/node_modules/@earendil-works` 仅 pi-coding-agent，pi-ai / pi-agent-core 嵌套其下；`extensions/node_modules/@earendil-works` 顶层三包均 0.85.1；extensions 源码静态 import pi-ai×6、pi-agent-core×1，动态 `pi-ai/compat`×2（`llm.ts:78`、`summarize.ts:74`）；(2) `import.meta.url` 相邻资源——`code-exec/index.ts:16-17`（runner.py / .mjs）、`fable-behavior/loader.ts:7`（prompts/），bundle 后指向 out/main；(3) `@ast-grep/napi` 须成为 electron-agent 依赖（今日 `package.json` 无）。10 处动态 import 全为静态字面量。
- `node:sqlite` ExperimentalWarning 进 stderr，会混入 `runner.ts:375` 的 error 文本。


### workspace 上下文传播

- L191/197/201 `workerEnv` 实为 `PRS:685-704`，漏 `PI_PACKAGE_DIR`(688)、`PI_RUNTIME_CONFIG`(690)、`resolveEnv`(687，`MAIN` 未注入)；`automation` 唯一来源 `__system__`(693)，规格已删 system worker sidecar，该行风险消失；`PI_MCP_CONFIG` 是内联 JSON 非路径（701；`manager.ts:98-111`）。
- L198 `PI_ALLOWED_EXTENSIONS` 今日即全局：`allowedPluginIds()` 无 workspace 参数（`pluginManager.ts:132-134`；`PRS:702`）。**非塌缩点**，改 `createGrenRuntime` 显式入参即可。
- L204 直读 `process.env` 共 13 处：`goal/tools.ts:34,38,39`；`_shared/desktop-control.ts:75-76`；`memory/index.ts:10`；`safety/index.ts:92,99,100`；`multi-agent/index.ts:109,224`；`workflows.ts:87`；`auto-title:79`；`runner.ts:144`；`runtime-config.ts:16,83`。其中 **per-workspace 的**：`goal/tools.ts:34` `PI_GOAL_WORKER`、`:39` `PI_HUMAN_ORIGIN_TOKEN`（`PI_TURN_ORIGIN` 等 Electron 从不设置）、`desktop-control.ts:76` `PI_GOAL_WORKER`。其余为全局或仅子进程。
- `mcp/manager.ts:224-235` 注释确认依赖单进程前提；每次 new/switch/fork 重建扩展 → `process.on` 监听器泄漏（`mcp/manager.ts:230-232`、`im-platforms/index.ts:421`）。
- `session.reload()`（`agent-session.js:2217-2240`）只调 `resourceLoader.reload()`，复用构造期 `extensionFactories` / `noContextFiles`（`resource-loader.js:169-174,744`），不重算；但重跑所有扩展工厂（`im-*:116/542`、`mcp/index.ts:112`）；`skillsOverride` 为闭包，`SKILLS_DISABLED` 可热更新。reload 时 `resetApiProviders()`（`agent-session.js:2224`）重置 pi-ai 进程级注册表，对其他 workspace 在飞请求的影响**未核实**。

---


## 三、ALS 可行性结论

**单次 `prompt()` 内成立；watch / IM / 未包裹入口不成立。** 置信度高（SDK 源码 + 两次 node 探针）。

- (a) 工具执行与 `pi.on(...)` 钩子都在 `prompt()` promise 链内：`agent-session.js:821→775` → `agent.js:271 runAgentLoop` → `agent-loop.js:139 executeToolCalls` → `412 beforeToolCall` → `agent-session.js:224-230 emitToolCall`；事件 `agent.js:418 await listener` → `agent-session.js:360,384` → `runner.js:632 await handler`；工具 execute 由 `wrapper.js:17` 直接 await。三文件无 `setTimeout / setImmediate`，唯一 `queueMicrotask`（`runner.js:311`）在链内继承 store。
- (b) 无构造期驱动：`steer / followUp` 只入队（`agent.js:173-178`），在 runLoop 内 drain（`agent.js:316-323`；`agent-loop.js:83,107,158,161`）；自动压缩（805,1754）、重试 sleep（2313）均在 `_runAgentPrompt` 链内。
- (c) `steer / followUp` 后续回合不脱离：队列在发起 prompt 的上下文消费。风险在发起方：`im-gateway onMessage → sendUserMessage → prompt`（`im-gateway:78,120`；`agent-session.js:1183`）运行于 HTTP server 创建期的 store。
- **构造期读取可行**：`runtime.ts:56-60` 在 `createRuntime` 内同步 await 求值；只要 `createGrenRuntime` 与 `AgentSessionRuntime` 的 new/switch/fork 在 `run()` 内调用即可读到 ALS（探针：await 链保持 store）。`agent-session-runtime.js:137,161,207,225,242,287` 内调 `createRuntime`，**宿主必须把这些入口都包进 `run()`**。
- **切断点清单**（这些位置的回调不在 prompt 的 ALS 内）：`runtime-config.ts:39` fs.watch；`mcp/manager.ts:119 watchMcpConfigFiles`；`im-gateway startGateway` 的 server；`im-platforms lockTimer / lockHeartbeat`（413,464）、ilink 长轮询；`runtime.ts:139-145` reload 触发；宿主任何未包裹的 IPC / 定时器对 prompt / new / switch / fork / reload 的调用。
- 在 watch 回调里读 per-workspace 键的：`approval/index.ts:39`（watchConfig）、`compaction-policy/index.ts:51`（`consumeDesktopPulse` 由 watchConfig:58 调）、`mcp/manager.ts:89,95`（`defaultReadServers` 由 init 与 fs.watch `onConfigChange:181` 调；:119 构造期）。**这些须闭包绑定 workspace，不能靠 ALS。**
- 有 ctx 可用的：`approval:53,71`；`mcp/index.ts:59`（execute 第 5 参 ctx，`wrapper.js:13`）、96 已用 `ctx.cwd`；`web-search:527` 可由 execute 透传。
- 扩展工厂签名 `(pi: ExtensionAPI)` **无 ctx**（`approval/index.ts:21`；`ExtensionAPI` 无 cwd：`types.d.ts:906+`、`loader.js:230-372`），`ctx.cwd` 首见于 `session_start`（`:60`）。「activate 开头闭包捕获」不成立，只能在 `session_start` 里赋 `let`。
- `getMcpManager()` 在工厂期调用（`mcp/index.ts:112`），需 ALS 内构造。

---

## 四、五份实现计划的错误（实施前必须改）


### 第 1 份

- **任务 3**：`createGrenRuntime` 抽取时 `runtime.ts:22-28` 模块级 `process.on('uncaughtException' / 'unhandledRejection')` 非 EPIPE 静默吞错——不得带入主进程。须接收并转发 `modelRuntime`。
- **任务 4**：`confirm(message, extra)` 丢第二位置参 `message`；`input(message, extra)` 丢 `placeholder`；`editor(initial, extra)` 实为 `editor(title, prefill)` 且无 opts；opts 是第三参。`custom: () => undefined` 同步 → runner `withUIPrompt` 对返回值调 `.finally` 抛 TypeError，须 `async`。信封 `{request:{id, kind, message, options}}` / `{notification:{kind, key, value}}` 与渲染层按 `request.method` 分发、读 `title / options / statusKey / statusText` **不兼容**。`hasUI / mode` 放进 uiContext 无效。缺 13 个成员（`setWorking*`×3、`setHiddenThinkingLabel`、`pasteToEditor`、`addAutocompleteProvider`、`set/getEditorComponent`、`theme`、`getAllThemes / getTheme / setTheme`、`get/setToolsExpanded`），`as ExtensionUIContext` 掩盖了缺失；未处理 `signal`；成员须为自有可枚举属性。
- **任务 5**：`session.bindExtensions(...)` 未 await（L1092）；不传 `onError` / `commandContextActions` / `shutdownHandler`。
- **任务 7**：选项名 `preflightResult`，参数 boolean，失败先回调 `false` 再 throw。计划 `onPreflight: (result) => { settled = true; resolve(result ?? {ok:true}) }`：`false ?? x` 得 `false`，preflight 失败被当成功 resolve 并压掉 `.catch` 的 reject。应仅 `true` 时 resolve，`false` 留给 `.catch`；须转发 `images / streamingBehavior / source:"rpc"`。广播接线须对齐 `MAIN:166-178`（先广播再 handle）。

### 第 2 份

- **任务 3**：`getConfig` 改造前必须先解决主进程无 `PI_RUNTIME_CONFIG`；`ensureStarted()` 必须在任何 ALS `run()` 之外首次调用（否则 fs.watch 永久绑错 workspace）。
- **任务 4**：行号、函数名正确；未处理 `goal/tools.ts:13 currentInput` 单例；Goal 直接 `new MemoryClient()` 不经 `desktopControl()`。
- **任务 5**：「activate 开头 `const workspaceCwd = ctx.cwd`」不成立（工厂无 ctx）；未覆盖 `_shared/approval.ts:12`（真实读取点）；未覆盖 `_shared/approval.ts:7`、`resource-reload.ts:2` 模块单例。
- **任务 7**：行号正确；`getMcpManager()` 在工厂期调用需 ALS 内构造；`onConfigChange`(181) → `readServers` 在 fs.watch 上下文，ALS 键会错，须闭包绑定 workspace。
- **任务 8**：「im-* Map 分键」方向错——微信长轮询与锁是账号级单实例，应选 owner workspace。
- **任务 9**：`PI_ALLOWED_EXTENSIONS` 本为全局，走显式入参。

### 第 3 份

- 前置知识「共享 session 文件」断言不成立（一.1）。
- **任务 1**：`runtime.complete({prompt, model:string, signal})`、`result.text`、`snapshot.models`、`displayName` 均不存在；真实为 `completeSimple(Model 对象, {messages:[{role:'user', content, timestamp}]}, {signal})` 取 `content[]` 文本（`oneshot.ts:41-46,66-84` 今日已用同一 API）；快照是数组、显示名 `name`；模型身份是 `provider + id`，`resolveModelId(): string` 丢 provider。signal 受支持（`ProviderRequestOptions.signal`，`types.d.ts:53`；`model-runtime.js:426-449` 透传）。
- **任务 4/5**：`describeModel` 改返 `{id, displayName}` 与 `agentData/runtime.ts:63` 的 `Promise<string>` 及 `expectedModel` 比较冲突；须保留 `provider/id` 字符串格式。system worker 语义变更（一.8）。
- **任务 7**：mock 二函数返回值，但它们返回 void 并写 stdout；`{servers:[]}` 非真实形状（`ProbeResult{ok, toolNames, error?}`）；须保留 `writeToolsCacheEntry` 写缓存。
- Goal 专有规则 11 条，规格只提了第 1 条（附录 A）。

### 第 4 份

- **任务 2**：测试签名 `spawnPiAgent({prompt, cwd}, {spawn})` 与实际 `(cwd, task, opts)`（`runner.ts:193-208`）及 5 处调用不符；`windowsHide` 是新增非保留；「逐字保持」漏 `explore_context`、hard / exit-grace、`partial`、`SUBAGENT_MODE=inherit`、`PI_IS_SUBAGENT` 末位不可覆盖；称「workerEnv 必须保留给子进程」却无任务把它接进 spawn env（一.3）。
- 缺：cwd → pid 子代理登记与关项目 / 退出时回收（一.4）。
- 缺：POSIX `killTree` 无进程组语义。

### 第 5 份

- **任务 1**：`electron/app/runtimePaths.ts` 不存在；`PI_BIN` 无设置项。
- **任务 4**：step3 external `@earendil-works/pi-ai` 在 cli 树非顶层 → 运行期解析失败；step4 `files: node_modules/@ast-grep/**` 但该包非 electron-agent 依赖；asarUnpack 片段漏 `@colbymchenry/**` 会破坏 CodeGraph（且会覆盖已有 `asar` / `afterPack`）；step2 只查动态 import，漏 `import.meta.url` 资源（code-exec / fable-behavior）；step7 方案 B 复制 `../extensions` 会带上 `extensions/node_modules`（含 vitest / rolldown / lightningcss .node 等 devDeps），且与今日 bundle 策略相反。
- 「三条阻断项」应改为「沿用 bundle，处理两套 SDK 副本 + `import.meta.url` 资源 + `@ast-grep/napi` 依赖」。

---

## 五、需要决策的设计问题（规格必须定，不能留给实现）

### Q1. Goal session 持有模型（一.1）

- **A. 单持有者（推荐）**：Goal 回合经交互 `WorkspaceHandle` 排队执行，`origin` 由 ALS 标 `goal`。无写冲突；复用今日 `queueGoalTurnFromArgs` 排队与 `SESSION_REPLACING_COMMANDS` 规则；天然满足「Goal 回合不切走可见会话」。代价：Goal 回合会占用交互 handle（今日双 worker 本就没跑通，不存在需保持的并行性）。
- **B. 双 runtime**：`GoalHost` 用 `SessionManager.open(sessionPath)` 打开同一 jsonl，回合结束后交互 handle `session.reload()`。有窗口期分叉风险。

### Q2. `PI_RUNTIME_CONFIG` 在主进程的来源（一.2）

- **A. 启动期设 env（推荐）**：`process.env.PI_RUNTIME_CONFIG = runtimeConfigPath`，并在任何 ALS `run()` 之前调一次 `ensureStarted()`。文件是全局单份、键已命名空间化，没有 per-workspace 的必要；改动最小，顺带解决 fs.watch 绑错。
- **B. 经 ALS 传 path**：`configPath()` 改读 ALS。多余的复杂度。

### Q3. IM 平台归属（一.7）

- 微信连接 / 锁 / 长轮询是账号级单实例，进程内只能有一份。需定义 owner workspace 与消息路由目标。候选：首个开启 IM 的 workspace 为 owner；或设置项显式指定；或多 workspace 并存时只允许一个启用 IM。**产品决策。**

### Q4. System worker 形态（一.8）

- **A. 第三套 `AgentSessionRuntime`（推荐）**：`extensionFactories: []`、`noContextFiles: true`、无 UI。agent 语义零变化，`describeModel` 继续读 `session.model`，`MODEL_CHANGED` 检查原样保留，不必复现 settings 解析。代价：多一套 runtime——它本来就是独立进程，成本持平。
- **B. `completeSimple`**：重新校准三类任务 prompt，复现 ~25 行模型解析。

---


## 六、已核实为正确的关键断言

- `toJsonEvent` 行为（`json-event.js:2-9,16-28`）、未从包根导出、深路径 import → `ERR_PACKAGE_PATH_NOT_EXPORTED`（node 探针）；原始形状含 `message`（`pi-agent-core/dist/types.d.ts:392-394`）。
- rpc subscribe 回调 `output(toJsonEvent(event))`（`rpc-mode.js:265-266`）；prompt 时序 `rpc-mode.js:298-320`。
- 规格 L56-69 映射表的宿主方法全部存在：`prompt` 359、`steer` 375、`followUp` 383、`abort` 444、`compact` 515、`setModel` 453、`cycleModel` 461、`setThinkingLevel` 470、`cycleThinkingLevel` 475、`getUserMessagesForForking` 632、`bindExtensions` 532、`subscribe` 280、`reload` 541、`isStreaming` 295、`setSessionName` 606、`getSessionStats` 641、`abortRetry` 560、`setAutoCompactionEnabled` 529（均 `agent-session.d.ts`）。
- `AgentSessionRuntime` 单活跃会话；替换时 `teardownCurrent` 先 `abort` 再 `dispose`（`agent-session-runtime.js:102-113`），`dispose` 清空监听器并 invalidate runner（`agent-session.js:584-599`），新 session 全新构建（js:137-143）→ 需重 subscribe / 重 bind；`setRebindSession((session) => Promise<void>)`（d.ts:58）在 `finishSessionReplacement` 触发（js:120-123）。
- `ModelRuntime` 有 `completeSimple / streamSimple`（`model-runtime.d.ts:89-90`）、`getAvailableSnapshot(): readonly Model<Api>[]`（68）、`getModel(providerId, modelId)`、`hasConfiguredAuth`，无「当前模型」API；`prepareRequest` 自动注入 apiKey / headers / baseUrl。`Context = {systemPrompt?, messages: Message[], tools?}`（`types.d.ts:389-393`）；返回 `content[]`（无 `.text`）、`usage`、`stopReason`（`types.d.ts:307-321`）。
- `agentReducer.ts:364-365` 注释与 L383 `text || cur.text + textDelta` 存在。
- `commandTypes`：`agent_rewind_to:'fork'`（`PRS:30`）、`agent_set_mode:'prompt'`（`PRS:26`）；`SESSION_BUSY` `PRS:280-282`；`respondUi` `PRS:511-514`；信封 `pi://event / ui-request / exit`：`MAIN:171-202`；`pi://exit` `{workspace, code, sessionId?, source?}`（`MAIN:197-202`）；`handlePiExit` `PRS:431-461`。
- `createRuntime`（`runtime.ts:49-77`）内容与规格 L38 一致（另含 `EXTENSIONS_PROFILE`、`PI_ALLOWED_EXTENSIONS` 过滤）。json 模式无 uiContext → `hasUI === false`（`print-mode.js:53-54`）。
- 六变量注入 `PRS:691-702`；消费点 `goal/tools.ts:39`、`desktop-control.ts:19`、`mcp/manager.ts:87`、`runtime.ts:59`、`memory/client.ts:8`、`wiki-rag/client.ts:2`。Agent Data：`agentData/runtime.ts:180` TCP 127.0.0.1:0，`:201-211` 每 workspace token；`MemoryClient` 读 `getConfig('AGENT_DATA_ENDPOINT')`（`memory/client.ts:7-9`）。
- `process.cwd()`：`approval` 39,53,71；`compaction` 51；`mcp/manager` 89,95,119；`mcp/index` 59；`web-search` 527；`mcp/index.ts:96` 已用 `ctx.cwd`。`globalThis` 单例仅 `mcp/manager.ts:225`、`im-platforms:111`、`im-gateway:26`（`sqlite.ts:17`、`code-exec/runner.mjs:9` 非单例）。
- `resolvePiCommand` `runner.ts:49-65` 读 `getConfig("PI_BIN")`；`runtime-config.ts:41-50` 150ms 防抖。审批 key 两侧一致（`settingsService.ts:4-11` ≡ `_shared/approval.ts:22-24`）；`writeApprovalPolicy`（`PRS:656-669`）写 workspace 与 resolved 两键到全局 runtime-settings.json；今日 sidecar cwd = resolved（`PRS:674-676`；`manager.ts:113`）故匹配。
- 子代理：调用方仅 `multi-agent/index.ts:371,421,479,564` 与 `im-platforms/index.ts:284`；`jsonModeArgs` `runner.ts:215-239`（`--skill` 在 `--mode` 前，task 末位）；节流 150ms `:265,326-343`；idle 300s / startup max(2×idle, 300s) / quiet 60s `:436-481`；cancel 文件 `cancel.ts:12,55-74`，Electron 写入 `subagentService.ts:69`；memory-off 4 键 `runner.ts:117-122`；rc 文件 0o600 `:172-176`；`withoutSensitiveProcessConfig` 剔 `TDAI_ / TENCENTDB_`。
- 原生模块实测：`"version": "38.8.6"` / `NODE 22.22.0` / `SQLITE_OK function`（ExperimentalWarning）/ `ASTGREP_OK 16` / 无 `@mariozechner` 目录；`optionalDependencies: {"@mariozechner/clipboard": "0.3.9"}`。`sqlite.ts:16-20` 变量 require `node:sqlite` / `bun:sqlite`，无 better-sqlite3。
- kind / 超时：`goal_judge`、`wiki_page_generate` 60s，`memory_extract` 默认 30s；`tail` 串行（`SWM:20-23,36-51,87`）；worker env `PI_SYSTEM_WORKER / PI_DISABLE_PROJECT_CONTEXT / automation`，cwd = userData（`SWM:132`；`MAIN:81-90`）。
- `mcpPolicyService.ts:56` 由 `MAIN:212` 注入；`MAIN:278` 临时实例只为 `refreshModelRegistry`。oneshot 调用方仅 `fixMermaid / diagnose`（`providerService.ts:100-139`，IPC `register.ts:307-314`）；probe 调用方 `MAIN:273-277`、`mcpPolicyService.ts:55-70`（IPC `register.ts:236,305`）。
- im-gateway 无 token 非 loopback 强制 `127.0.0.1`（`im-gateway/index.ts:50-59`；`gateway.ts:74`）。
- `electron-agent/package.json` 无 pi 包；`build:sidecar`（:12）、`extraResources resources/pi`（`electron-builder.yml:13-15`）存在。

---


## 附录 A：Goal 专有规则清单（★ = 规格未提）

1. goal 源禁 `SESSION_REPLACING_COMMANDS`（`PRS:270,1059`）
2. ★必须自报 sessionId / sessionPath，不继承可见会话；`readSessionIdentity` 校验归属与 `SESSION_ID_MISMATCH`（`PRS:546-547,887-903`）
3. ★同 stateKey 有活跃回合则 `queueGoalTurnFromArgs`，开 worker 后二次复查；`followUp` 拒绝（`PRS:286-291,325-327`）
4. ★prompt / follow_up 须带 `goalId / idempotencyKey / revision / nextRound`，`GOAL_TURN_IDEMPOTENCY_CONFLICT`（`PRS:328,604,815,1066-1073`）
5. ★`get_state` 双重校验 `GOAL_WORKER_SESSION_MISMATCH`（`PRS:557-561`）；goal `get_state` 不移动可见指针（`PRS:338`）
6. ★worker 失败 / 退出时 `failQueuedGoalTurns` 逐项回报 failed；`drainGoalTurn` 出错继续排空（`PRS:460-499,826-857`）
7. ★prompt 固定 `goalPrompt(condition)`，profile `automation`（`PRS:784-798,1079-1086`）
8. ★`migrateLegacyGoal`（读 jsonl 旧条目 → `admin.goal.recoverLegacy`，去重且等 fork 同步）、`onSessionForked`（`PRS:976,979-1042`；`MAIN:227,258`）
9. ★Goal UI 请求一律取消（`MAIN:184-188`；`PRS:516-524`）
10. ★`bind / unbindGoalSession`、关闭后恢复 interactive 绑定、`ownsSession` 含 goalWorkers（`PRS:570-590,944-954`）
11. env `PI_HUMAN_ORIGIN_TOKEN='0'` / `PI_GOAL_WORKER='1'`（`PRS:699-700`），消费者 `goal/tools.ts:34`、`desktop-control.ts:76`


## 附录 B：`ExtensionUIContext` 完整签名（`SDK/core/extensions/types.d.ts:68-192`，28 项）

`→` 后为官方 rpc 行为（`rpc-mode.js:83-224`）。`hasUI` / `mode` **不在此接口**。

1. `select(title, options: string[], opts?: {signal?, timeout?}): Promise<string|undefined>` → 发 `{method:"select", title, options, timeout}`；超时 / abort / `cancelled` → `undefined`，否则 `value`
2. `confirm(title, message, opts?): Promise<boolean>` → `{method:"confirm", title, message, timeout}`；默认 `false`，否则 `confirmed`
3. `input(title, placeholder?, opts?): Promise<string|undefined>` → `{method:"input", title, placeholder, timeout}`；默认 `undefined`
4. `notify(message, type?: "info"|"warning"|"error"): void` → `{method:"notify", message, notifyType}`
5. `onTerminalInput(handler): () => void` → 返回 `() => {}`
6. `setStatus(key, text: string|undefined): void` → `{method:"setStatus", statusKey, statusText}`
7. `setWorkingMessage(message?)` 8. `setWorkingVisible(visible)` 9. `setWorkingIndicator(options?)` 10. `setHiddenThinkingLabel(label?)` → 均 no-op
8. `setWidget(key, content: string[]|undefined, options?: {placement?})` 重载 `(key, factory|undefined, options?)` → 仅 `undefined` / 数组时发 `{method:"setWidget", widgetKey, widgetLines, widgetPlacement}`
9. `setFooter(factory|undefined)` 13. `setHeader(factory|undefined)` → no-op
10. `setTitle(title)` → `{method:"setTitle", title}`
11. `custom<T>(factory, options?: {overlay?, overlayOptions?, onHandle?}): Promise<T>` → `async () => undefined`（**必须返回 Promise**）
12. `pasteToEditor(text)` → 转 `setEditorText`
13. `setEditorText(text)` → `{method:"set_editor_text", text}`
14. `getEditorText(): string` → `""`
15. `editor(title, prefill?): Promise<string|undefined>` → `{method:"editor", title, prefill}`，**无 timeout / signal**
16. `addAutocompleteProvider(factory)` 21. `setEditorComponent(factory|undefined)` → no-op；22. `getEditorComponent()` → `undefined`
17. `readonly theme: Theme` → 上游 `theme` 代理（需 stub）
18. `getAllThemes(): {name, path}[]` → `[]`；25. `getTheme(name)` → `undefined`；26. `setTheme(theme)` → `{success:false, error}`
19. `getToolsExpanded()` → `false`；28. `setToolsExpanded(expanded)` → no-op
