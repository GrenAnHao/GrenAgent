# 热控制面：运行时读内存

- 日期：2026-09-11
- 状态：已审查，实现计划见 `docs/superpowers/plans/2026-09-11-live-control-plane.md`
- 范围：审批与模式两张控制面。运行时只读进程内 live 表；`runtime-settings.json` 只做重启恢复。对话中切档，下一刀工具现读新档。
- 取代：`2026-06-26-real-control-plane-design.md` 里「热路径读配置文件 / `watchConfig` 才算生效」的部分。假 prompt 已去掉，不再讨论。
- 平台：只改 Electron 进程内 SDK 宿主与 `extensions/`。不改 Tauri。

## 1. 背景与目标

SDK 宿主已经把 `agent_set_approval` / `agent_set_mode` 从假 prompt 改成写 `runtime-settings.json`。两条控制面的进度不同：

- **审批：** `extensions/_shared/approval.ts` 已是进程内表；`safety` / `mcp-policy` 热路径已 `getApprovalPolicy()`，不再 `refreshConfig()`。主进程却另有一张 `approvalPolicyStore`，`writeApprovalPolicy` 必须两处一起写。`evaluate` 用 `getLiveApprovalPolicy` 做可选覆盖：未写入时退回 `facts.preset`。`session_start` / `watchConfig` 只灌 `approval.ts`，不碰第二张表。
- **模式：** `writeAgentMode` 只落盘，不碰内存。扩展工厂闭包里的 `currentMode` 等 `watchConfig`（150 ms 防抖）才变；`tool_call` 把门闩写成 `gateToolCall(currentMode, …)`。对话中切模式不实时。无路径时在任何 `set` 之前就抛 `RUNTIME_CONFIG_UNAVAILABLE`。

目标：

- 每种控制面一张 live 表，一个 `set`、一个 `get`。
- 切档先改内存（同步，发生在第一个 `await` 之前），再落盘。
- 热路径禁止读盘、禁止 `refreshConfig()`。
- 下一刀 `tool_call` / `evaluate` 按新档拦；不必中断本回合。
- 模式工具集可以下一轮再齐；门闩本回合必须已按新档工作。

## 2. 架构

按工作区路径归一化分键（`\` → `/`，去尾斜杠，小写），与今天的 `APPROVAL_POLICY:` / `AGENT_MODE:` 后缀相同。

| 表 | 模块 | 值 | 默认（`Map` 未写入时 `get` 的回退） |
| --- | --- | --- | --- |
| 审批 | `extensions/_shared/approval.ts`（已有，收口为唯一表） | `ask` / `auto` / `full` | `auto` |
| 模式 | `extensions/agent-mode/modes.ts` 新增与审批同形的 live API | `agent` / `ask` / `debug` / `plan` / `brainstorm` | `agent` |

`get*` 的默认值是读时回退。表本身用 `Map.has` 区分「未写入」与「显式写成默认档」。冷路径只在未写入时灌盘，避免用过期 `getConfig` 覆盖 IPC 刚写下的内存。

### 2.1 键

`WorkspaceHandle` 里 `workspace` 是 IPC 别名，`cwd` 是 `resolveWorkspace` 之后的路径。扩展 `ctx.cwd`、ALS `cwd`、`collectFacts` 写入的 `call.workspace` 都是这份 **cwd**，不是别名。

| 方向 | 键 |
| --- | --- |
| 写 | `set*(workspace)`（IPC 别名，第一个 `await` 之前）+ `set*(resolved)`（`resolveWorkspace` 之后） |
| 热路径读 | `get*(call.workspace)` / `get*(ctx.cwd)` / 无参 `get*()`（ALS `cwd`） |

只 `set` 别名、不 `set` resolved，safety 无参 `get` 会落到默认档。

### 2.2 数据流

```
底栏 IPC
  → writeApprovalPolicy / writeAgentMode
  → set*(workspace) + set*(resolved)     // 同步，热路径从此可读
  → mergeRuntimeSettingsFile             // 存档，可失败

热路径
  safety / mcp-policy / tool_call 门闩 / ToolDecisionService.evaluate
  → 只 get*(cwd | ALS cwd | call.workspace)
  → 不读文件
  → facts.preset 不是 fallback

冷路径
  session_start：该 cwd 尚未写入才读文件 / 会话条目 → set*
  watchConfig：解析值与 get* 不同才 set*（外部改盘）
  刚切档再落盘时 watch 读到相同值，空操作，不把档位打回去
```

模式工具集不走通用 bus，也不靠宿主调 `applyMode`：

- 本回合：门闩现读 live。模型可能仍看见旧工具名；写 / 危险 bash 当场拦。ask → agent 的同一回合，写工具可能仍被 `setActiveTools` 藏着，接受。
- 下一轮：`before_agent_start` 用 `session_start` 留下的 `sessionCtx`，按 live 调 `applyMode`（silent），对齐工具集与 `setStatus`。
- 内部切档（`/plan-build`、`brainstorm-deliver`）：走 `applyMode`，`applyMode` 必须同时 `setAgentMode`，否则门闩仍按旧 live 拦执行阶段。

不设通用 `liveControl` bus。删段仍是 pulse，不进本规格。

### 2.3 相对现状

实现计划不要重做已经到位的部分。

**已到位**

- `approval.ts` 的 `get` / `set`、分键、默认 `auto`，以及「盘盖不过内存」的单测
- `writeApprovalPolicy`：先 `set(workspace)` 再 resolved / 落盘；无路径不回滚
- `safety` / `mcp-policy` 热路径已 `getApprovalPolicy()`
- `approval` 的 `watchConfig` 已与 `get*` 比较后空操作
- 底栏下拉已乐观更新 zustand

**待做**

- 删除 `approvalPolicyStore`，`evaluate` 改 `getApprovalPolicy`；空表即 `auto`
- 模式 live API；`writeAgentMode` 对齐 `writeApprovalPolicy`
- `tool_call` hook 改读 live；`applyMode` 写 live；`before_agent_start` 按 live 对齐工具集
- `session_start` 不覆盖已写入的 live
- 第 5 节里尚未存在的测试

## 3. 组件

### 3.1 `extensions/_shared/approval.ts`

唯一审批 live 表。`getApprovalPolicy` / `setApprovalPolicy` 只碰内存。`approvalPolicyConfigKey` 只给冷路径和落盘用。`get` 保持「未写入回退 `auto`」；用 `Map.has`（或等价）供 `session_start` 判断是否已写入。

### 3.2 删除 `electron-agent/electron/app/toolPermission/approvalPolicyStore.ts`

`ToolDecisionService.evaluate` 改为 `getApprovalPolicy(call.workspace)`，**总是**用 live 覆盖 `facts.preset`。未 `set` 过的 workspace 就是 `auto`，不再把 sidecar / RPC 传入的 preset 当 fallback。

`permission.tool.evaluate` 与现有 `evaluate(facts({ preset }))` 夹具都按此语义：空表 + `facts.preset === 'full'` 仍按 `auto` 判定。测试夹具里的 `setLiveApprovalPolicy` 改成 `setApprovalPolicy`。

### 3.3 模式 live API

与审批同形：`getAgentMode(cwd?)` / `setAgentMode(mode, cwd?)` / 已有 `agentModeConfigKey`。放在 `extensions/agent-mode/modes.ts`（该文件已有 key 与 `parseModeArg`），扩展与宿主都能 import。未写入回退 `agent`；同样用 `Map.has` 区分未写入。

`gateToolCall(mode, toolName, input)` **保持纯函数**，签名不改。改的是 hook：

```
pi.on("tool_call", …) → gateToolCall(getAgentMode(ctx.cwd), event.toolName, event.input)
```

工厂闭包里的 `currentMode` 只当 `applyMode` 的本地缓存，宿主 `setAgentMode` 不会改它。门闩测试必须在闭包未刷时仍按 live 拦截。

`applyMode(next, ctx)` 在改工具集 / `currentMode` / `setStatus` / persist 的同时 `setAgentMode(next, ctx.cwd)`。所有内部切档只走 `applyMode`，live 不会掉。

`before_agent_start`：若有 `sessionCtx` 且 `getAgentMode(sessionCtx.cwd) !== currentMode`，则 `applyMode(live, sessionCtx, { silent: true })`。无 `sessionCtx` 则只靠门闩，不挡。

### 3.4 `writeApprovalPolicy` / `writeAgentMode`

`writeApprovalPolicy` 已符合下列顺序（除了还在写 `approvalPolicyStore`）。`writeAgentMode` 今天只落盘，要改成同一顺序。

1. 校验档位；非法则不 `set`、不落盘，抛 `INVALID_APPROVAL_POLICY` / `INVALID_AGENT_MODE`。
2. `set*(workspace)`。
3. 如有 `runtimeConfigPath`：`resolveWorkspace` 后 `set*(resolved)`，再 `mergeRuntimeSettingsFile` 写两个键、同一值。
4. 无路径或落盘失败：内存已改，错误抛给 IPC，不回滚。

`set` 必须发生在第一个 `await` 之前（`workspace` 键）。`resolved` 键可以在 `resolveWorkspace` 之后补。无路径时不得在 `set(workspace)` 之前抛 `RUNTIME_CONFIG_UNAVAILABLE`。

宿主不调用 `applyMode`，以免绑 `WorkspaceHandle` / `ExtensionContext`。

### 3.5 扩展冷路径与模式对齐

`extensions/approval/index.ts` 与 `extensions/agent-mode/index.ts`：

- `session_start`：该 cwd **尚未写入** 时，读文件 / 会话条目 → `set*`。已写入则不覆盖（不拿可能过期的 `getConfig` / ALS 快照打回 IPC 新档）。然后 `setStatus`。模式再按 live 对齐工具集（可直接 `applyMode`）。
- `watchConfig`：解析到的值与 `get*` 不同才 `set*`（外部改盘）。模式若有 `sessionCtx`，再 `switchMode` / `applyMode`。IPC 切档后文件等于 live，空操作，**不**负责对齐工具集——那是 `before_agent_start` 的事。
- `before_agent_start`（仅模式）：见 3.3。这是桌面切档后工具集对齐的必做点，不是顺嘴一句。

优先级（模式 `session_start` 灌表时，且仅当未写入）：文件 scoped 键 > 会话条目 > 默认 `agent`。与今天「文件盖过条目」一致。

### 3.6 渲染层与内部命令

底栏下拉已乐观更新 zustand store，不改。回读仍靠扩展 `setStatus`（可能延迟到下一轮 `before_agent_start`）。

不把 `/plan-build`、`/brainstorm-deliver` 收成 IPC，也不改 slash 菜单。但这两处已经 `applyMode("agent")`：必须走 3.3 的 `applyMode`（内含 `setAgentMode`），否则执行阶段会被门闩按旧 live（`plan` / `brainstorm`）拦住。Goal 命令不在本规格。

## 4. 错误处理

| 情况 | 行为 |
| --- | --- |
| 非法档位 | live 不变，不落盘，抛现有错误码 |
| 无 `runtimeConfigPath` | 先 `set(workspace)`，再抛 `RUNTIME_CONFIG_UNAVAILABLE`，不回滚 |
| 落盘失败 | 内存保留新值，IPC 失败；`watchConfig` 不会被这次失败触发 |
| 尚无 `session_start` | live 仍先改，门闩现读；`setActiveTools` / `setStatus` 等到 `session_start` 或下一轮 `before_agent_start` |
| 外部改盘 | `watchConfig` 灌 live；与 live 相同则空操作 |
| workspace / resolved 不一致 | 两个键都 `set`、都落盘，值为同一档 |
| `evaluate` 空表 | 视为 `auto`，忽略 `facts.preset` |
| 桌面切档后同一回合 | 门闩已是新档；工具可见集可能仍是旧的，下一轮再齐 |
| `session_start` 遇已写入的 live | 不覆盖；按 live `setStatus` / 对齐工具 |

对话中的档位以内存为准。落盘失败只影响重启后能否恢复，不影响本回合判定。

## 5. 测试

测行为，不把「读了文件」当成成功。审批侧 1、2、6 的对等用例已有，不要重写；补模式与收口。

1. `setApprovalPolicy` / `setAgentMode` 之后立刻 `get*` 为新值；随后把盘改回旧值，`get*` 仍是新值。（审批已有）
2. `agent_set_approval` / `agent_set_mode`：`set` 发生在落盘完成之前即可被 `get*` 读到（可用「写完 IPC 后改盘、`get*` 仍新」证明内存是真相）。（审批已有；补模式）
3. `evaluate`：sidecar facts 仍带 `auto` 时，只 `setApprovalPolicy(workspace, 'full')` 就放行危险命令；不再出现 `approvalPolicyStore`。另测：空表 + `facts.preset === 'full'` 仍按 `auto` 拦危险命令。
4. `tool_call` hook：live 已是 `ask` 时拦住 `write` / 危险 `bash`，即使工厂闭包里的旧 `currentMode` 未刷。`gateToolCall` 纯函数单测保持按传入 `mode` 测。
5. 非法档位：`get*` 不变，文件不被写。无 `runtimeConfigPath`：`get*` 已是新值，并抛 `RUNTIME_CONFIG_UNAVAILABLE`。
6. `session_start`：空表时把文件灌进 live（重启恢复）。该 cwd 已有 live 时，过期的 `getConfig` / 会话条目不得覆盖。
7. `/plan-build`（或直接调 `applyMode("agent")`）之后 `getAgentMode` 为 `agent`，门闩放行 `write`。

## 6. 非目标

- 不改 Tauri。
- 不改 slash 菜单，不把 `/plan-build` / `/brainstorm-deliver` 收成 IPC（但必须写 live，见 3.6）。
- 不改删段 pulse。
- 不新增通用控制 bus，不新增 Pi RPC 命令类型。
- 不中断当前回合来切模式；不要求本回合立刻 `setActiveTools`。

## 7. 与既有规格的关系

`2026-06-26-real-control-plane-design.md` 的「去掉假 prompt、IPC 写侧信道」仍然成立。本规格修正其后半段：侧信道文件是存档；运行时真相是 live 表。实现计划只覆盖第 3–5 节的 Electron / extensions 改动，并跳过 2.3 已到位项。
