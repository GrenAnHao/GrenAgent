# 热控制面：运行时读内存

- 日期：2026-09-11
- 状态：设计草案（brainstorming 产出），待审查 → writing-plans
- 范围：审批与模式两张控制面。运行时只读进程内 live 表；`runtime-settings.json` 只做重启恢复。对话中切档，下一刀工具现读新档。
- 取代：`2026-06-26-real-control-plane-design.md` 里「热路径读配置文件 / `watchConfig` 才算生效」的部分。假 prompt 已去掉，不再讨论。
- 平台：只改 Electron 进程内 SDK 宿主与 `extensions/`。不改 Tauri。

## 1. 背景与目标

SDK 宿主已经把 `agent_set_approval` / `agent_set_mode` 从假 prompt 改成写 `runtime-settings.json`。审批热路径却仍 `refreshConfig()` 读盘，主进程还另有一张 `approvalPolicyStore`。两处内存必须同时写，漏一处就会出现「下拉变了、判定仍是旧档」。模式至今只写文件，等 `watchConfig`（150ms 防抖）才改 `currentMode`，对话中切模式不实时。

目标：

- 每种控制面一张 live 表，一个 `set`、一个 `get`。
- 切档先改内存（同步，发生在第一个 `await` 之前），再落盘。
- 热路径禁止读盘、禁止 `refreshConfig()`。
- 下一刀 `tool_call` / `evaluate` 按新档拦；不必中断本回合。

## 2. 架构

按工作区路径归一化分键（`\` → `/`，去尾斜杠，小写），与今天的 `APPROVAL_POLICY:` / `AGENT_MODE:` 后缀相同。

| 表 | 模块 | 值 | 默认 |
| --- | --- | --- | --- |
| 审批 | `extensions/_shared/approval.ts`（已有，收口为唯一表） | `ask` / `auto` / `full` | `auto` |
| 模式 | `extensions/agent-mode` 旁新增与审批同形的 live API | `agent` / `ask` / `debug` / `plan` / `brainstorm` | `agent` |

数据流：

```
底栏 IPC
  → writeApprovalPolicy / writeAgentMode
  → set*(workspace) + set*(resolved)     // 同步，热路径从此可读
  → mergeRuntimeSettingsFile             // 存档，可失败

热路径
  safety / mcp-policy / gateToolCall / ToolDecisionService.evaluate
  → 只 get*(workspace | ALS cwd)
  → 不读文件

冷路径
  session_start / watchConfig
  → 读文件（或会话条目）
  → 与 live 不同才 set*
```

模式的额外副作用：有 `lastCtx` 时顺手 `applyMode`（`setActiveTools` + `setStatus`）。没有也不挡——本回合靠门闩现读 live mode；下一轮 `before_agent_start` 按 live 表对齐工具集。模型在本回合可能仍看见旧工具名，写 / 危险 bash 会被当场拦住。

不设通用 `liveControl` bus。删段仍是 pulse，不进本规格。

## 3. 组件

### 3.1 `extensions/_shared/approval.ts`

唯一审批 live 表。`getApprovalPolicy` / `setApprovalPolicy` 只碰内存。`approvalPolicyConfigKey` 只给冷路径和落盘用。

### 3.2 删除 `electron-agent/electron/app/toolPermission/approvalPolicyStore.ts`

`ToolDecisionService.evaluate` 改为 `getApprovalPolicy(call.workspace)`。测试夹具里的 `setLiveApprovalPolicy` 改成 `setApprovalPolicy`。

### 3.3 模式 live API

与审批同形：`getAgentMode(cwd?)` / `setAgentMode(mode, cwd?)` / 已有 `agentModeConfigKey`。放在 `extensions/agent-mode/modes.ts`（该文件已有 key 与 `parseModeArg`），扩展与宿主都能 import。

`gateToolCall` 和 `applyMode` 以 live 表为准。工厂闭包里的 `currentMode` 只当缓存，`setAgentMode` 时一起改；门闩测试必须在闭包未刷时仍按 live 表拦截。

### 3.4 `writeApprovalPolicy` / `writeAgentMode`

1. 校验档位；非法则不 `set`、不落盘，抛 `INVALID_APPROVAL_POLICY` / `INVALID_AGENT_MODE`。
2. `set*(workspace)`。
3. 如有 `runtimeConfigPath`：`resolveWorkspace` 后 `set*(resolved)`，再 `mergeRuntimeSettingsFile` 写两个键、同一值。
4. 无路径或落盘失败：内存已改，错误抛给 IPC，不回滚。

`set` 必须发生在第一个 `await` 之前（`workspace` 键）。`resolved` 键可以在 `resolveWorkspace` 之后补。

宿主不调用 `applyMode`，以免绑 `WorkspaceHandle` / `ExtensionContext`。

### 3.5 扩展冷路径

`extensions/approval/index.ts` 与 `extensions/agent-mode/index.ts`：

- `session_start`：读文件 / 会话条目 → `set*` → `setStatus`。模式再按 live 表对齐工具集。
- `watchConfig`：解析到的值与 `get*` 不同才 `set*`。刚切档再落盘时 watch 读到相同值，空操作，不会把档位打回去。

### 3.6 渲染层

底栏下拉已乐观更新 zustand store，不改。回读仍靠扩展 `setStatus`。slash 菜单、`/plan-build`、Goal 命令不在本规格。

## 4. 错误处理

| 情况 | 行为 |
| --- | --- |
| 非法档位 | live 不变，不落盘，抛现有错误码 |
| 无 `runtimeConfigPath` | 先 `set(workspace)`，再抛 `RUNTIME_CONFIG_UNAVAILABLE`，不回滚 |
| 落盘失败 | 内存保留新值，IPC 失败；`watchConfig` 不会被这次失败触发 |
| 尚无 `session_start` | live 仍先改，门闩现读；`setActiveTools` / `setStatus` 等到 `session_start` 或下一轮 `before_agent_start` |
| 外部改盘 | `watchConfig` 灌 live；与 live 相同则空操作 |
| workspace / resolved 不一致 | 两个键都 `set`、都落盘，值为同一档 |

对话中的档位以内存为准。落盘失败只影响重启后能否恢复，不影响本回合判定。

## 5. 测试

测行为，不把「读了文件」当成成功。

1. `setApprovalPolicy` / `setAgentMode` 之后立刻 `get*` 为新值；随后把盘改回旧值，`get*` 仍是新值。
2. `agent_set_approval` / `agent_set_mode`：`set` 发生在落盘完成之前即可被 `get*` 读到（可用「写完 IPC 后改盘、`get*` 仍新」证明内存是真相）。
3. `evaluate`：sidecar facts 仍带 `auto` 时，只 `setApprovalPolicy(workspace, 'full')` 就放行危险命令；不再出现 `approvalPolicyStore`。
4. `gateToolCall`：live 已是 `ask` 时拦住 `write` / 危险 `bash`，即使工厂闭包里的旧 `currentMode` 未刷。
5. 非法档位：`get*` 不变，文件不被写。
6. `session_start` 把文件灌进 live 表（重启恢复）。

## 6. 非目标

- 不改 Tauri。
- 不改 slash 菜单，不把 `/plan-build` 收成 IPC。
- 不改删段 pulse。
- 不新增通用控制 bus，不新增 Pi RPC 命令类型。
- 不中断当前回合来切模式。

## 7. 与既有规格的关系

`2026-06-26-real-control-plane-design.md` 的「去掉假 prompt、IPC 写侧信道」仍然成立。本规格修正其后半段：侧信道文件是存档；运行时真相是 live 表。实现计划只覆盖第 3–5 节的 Electron / extensions 改动。
