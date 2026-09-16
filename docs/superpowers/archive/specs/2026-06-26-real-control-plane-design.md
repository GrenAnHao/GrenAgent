# SP-4 真控制面设计（去伪对话）

- 日期：2026-06-26
- 状态：设计草案（brainstorming 产出），待审查 → writing-plans
- 范围：把控制操作（模式/审批切换、配置重载）从"伪装成 prompt 塞进对话流"改为**真正的控制面**——配置侧信道 + 既有热重载，对话通道只跑真实消息。零 fork。
- 所属：零 fork 6 子项目之 SP-4。

## 1. 背景与目标

「伪对话」三处（实地）：
1. **控制走假 prompt**：`agent_set_mode`（`tauri-agent/src-tauri/src/commands/agent.rs:359`）与 `agent_set_approval`（:381）把 `/mode xxx`、`/approval xxx` 当**用户消息**塞进 `Prompt` 通道，靠扩展命令执行。GUI 操作变成假聊天。
2. **改配置靠 switch-session-to-self**：`broadcast_refresh`（`tauri-agent/src-tauri/src/commands/providers.rs:68`）用 `get_state` + `switch_session` 切回同一会话强制 runtime 重建以重读 models.json——拿会话操作当 reload 钩子。
3.（SP-2 已处理的 Rust 重抄 provider，不在此重复。）

目标：控制操作走干净通道，不污染对话、不触发对话 turn 机制；配置重载用真正的 reload。

## 2. 现状核验（锚点）

- `agent.rs:359` `agent_set_mode` / `:381` `agent_set_approval`：均 `Prompt { message: "/mode…" }`。
- `providers.rs:68` `broadcast_refresh`：switch-session-to-self 重载。
- `agent-mode` 扩展（`extensions/agent-mode/index.ts`）：`switchMode`/`applyMode`（:85/:105）已与命令处理分离；apply 多用 `pi.setActiveTools`/`pi.getActiveTools`（:89/:94，**在 `pi` 上而非 `ctx`**），仅 `pushStatus` 用 `ctx.ui.setStatus`（:71）。`session_start`（:332）已从持久 entry 回读模式。
- `approval` 扩展（`extensions/approval/index.ts`）：`setApprovalPolicy`（_shared，不需 ctx）、`session_start`（:38）回读，且已读 `getConfig("APPROVAL_POLICY")`（:47）。
- 侧信道底座：`extensions/_shared/runtime-config.ts`（`PI_RUNTIME_CONFIG` 文件 + `fs.watch` + `getConfig`/`watchConfig`）。
- 热重载底座：`cli/src/main.ts:151` 监听 `PI_RELOAD_REV` → `runtime.session.reload()`（mid-turn 延迟到 `agent_end`）。

## 3. 设计

### 3.1 控制面走配置侧信道（主方案）

- 桌面写期望状态到 `PI_RUNTIME_CONFIG`（如 `MODE=plan`、`APPROVAL_POLICY=auto`）。
- 扩展在工厂里 `watchConfig(next => …)` 订阅：
  - **approval**：`setApprovalPolicy` 不需 ctx → 立即应用；状态回推延迟到下一个生命周期事件（或桌面乐观回显）。
  - **agent-mode**：`pi.setActiveTools(...)` 在 `pi` 上 → 可在 watch 回调立即应用工具集；`pushStatus`（需 `ctx.ui`）延迟到下一个 `turn_start`/`before_agent_start`/`agent_end`（这些 handler 有 ctx），或桌面乐观回显当前模式。
- **不再发假 prompt**：`agent_set_mode`/`agent_set_approval` 改为写 config（+ 必要时 bump 一个 rev 通知）。

### 3.2 reload 兜底路径（复用既有机制）

- 对需要完整重建的变更（如 provider 配置）：桌面写 config + bump `PI_RELOAD_REV` → 既有 `main.ts:151` `session.reload()` → `session_start` 触发 → 扩展 `session_start`（已有 ctx）读取 config 并 apply（agent-mode/approval 的 `session_start` 已在读持久态，扩展为"持久态 < config 覆盖"）。
- 以此**替换 `broadcast_refresh` 的 switch-session-to-self**：新增 `reload_config` Tauri 命令 = 写 config + bump rev，干净重载。

### 3.3 选择

- 模式/审批：用 3.1（即时、轻量，多数 apply 在 `pi` 上无需 ctx）。
- provider 配置重读：用 3.2（reload 兜底，替换黑魔法）。

## 4. 数据流

```
切模式/审批：桌面 ──写 config(MODE/APPROVAL)──▶ 扩展 watchConfig 回调
   → pi.setActiveTools / setApprovalPolicy 即时 apply；状态在下个 lifecycle event 回推
重读配置：  桌面 ──写 config + bump PI_RELOAD_REV──▶ main.ts session.reload()
   → session_start → 扩展读 config 覆盖应用
```

## 5. 错误处理 / 降级

- config 值非法 → 扩展回退默认（agent → agent；approval → auto），不崩。
- watch 不可用（见 `runtime-config.ts:50` 容错）→ 退化为 reload 路径仍可用。
- 状态回推延迟期间，桌面以乐观回显为准；下个事件对齐真值（`ctx.ui.setStatus`）。
- mid-turn 控制变更：reload 已延迟到 `agent_end`（`main.ts:164`），不打断进行中的回合。

## 6. 非目标

- 不新增 RPC 原生命令类型（那需碰 coding-agent 的 rpc 模式；side-channel 已等价覆盖）。
- 不改对话消息本身的协议。

## 7. 测试

- 写 config → agent-mode/approval 即时 apply（工具集/策略变化）。
- reload_config 替换 switch-session：provider 重读生效、会话历史保留。
- config 非法回退默认；watch 不可用走 reload。
- 对话历史**不再出现** `/mode`、`/approval` 这类伪用户消息（回归断言）。

## 8. MVP 与增强

- MVP：模式/审批走 config 侧信道（去假 prompt）+ `reload_config` 替换 switch-session 黑魔法。
- 增强：统一的控制面状态回推通道（一个 `setStatus` 聚合）；若上游加 RPC 控制命令再切原生。
