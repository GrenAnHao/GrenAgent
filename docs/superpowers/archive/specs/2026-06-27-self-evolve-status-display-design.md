# self-evolve 状态显示对齐设计（GrenAgent × MiMo 参考）

**日期：** 2026-06-27  
**状态：** 草案，待用户审查  
**前置：** [2026-06-26-self-evolve-dream-distill-design.md](./2026-06-26-self-evolve-dream-distill-design.md)（调度、persona、MEMORY.md 注入）

## 问题

当前 Pi `self-evolve` 用手动 `spawn(stdio:ignore)` + `ctx.ui.notify`，与 MiMo Code 的状态可见性差距大：

- 用户发 `/dream` / `/distill` 后 GrenAgent 发送按钮长时间转圈，主聊天无进度。
- MiMo 手动命令在当前会话流式跑专用 agent；自动触发在侧栏出现 `[自动] Auto Dream` 会话并显示 Spinner。

GrenAgent 是 TUI 之外的桌面 UI，**不复制 MiMo TUI 布局**，但应保留 MiMo 的**语义**：专用 agent、受限工具、可观察运行态、可查看完整 transcript、自动/手动可区分。

## 决策摘要（brainstorming 结论）

| 维度 | 决策 |
|---|---|
| 可见性主路径 | **Pi 原生**：`multi-agent` 的 `SubAgentRegistry` + 顶部 Bot 菜单角标 + 右坞 `SubAgentConversation` |
| 手动 `/dream` `/distill` | 主聊天 **启动 Notice** + 角标；**不**自动打开右坞；**不**在主聊天流式全文 |
| 自动 `session_start` 触发 | 主聊天 **启动 Notice** + **完成 Notice**（摘要或失败原因）；详情在右坞 |
| MiMo 独立 Auto 会话 | **不**新建 GrenAgent 侧栏 session 行；用 registry 条目 + `task` 标签（`Auto Dream` / `Auto Distill`）代替 |

## MiMo 机制映射表

| MiMo（TUI） | GrenAgent（Pi） |
|---|---|
| `Command` 绑定 `agent: dream/distill`，`subtask: false` | persona + `spawnPiAgent` + 工具 deny 列表（沿用现有 personas / `SAFETY_DENY_TOOLS`） |
| 手动命令 → 当前 session 流式 `prompt()` | registry 后台子代理 + Notice；transcript 在右坞 |
| 自动 → `Session.create({ title: "Auto Dream" })` + 后台 prompt | registry 行 `source:auto`，`task:"Auto Dream"` |
| `session_status.busy` + 列表 Spinner | `registry.status=running` → `SubAgentMenuButton` 轮询（已有） |
| 完整输出在会话内可见 | `spawnPiAgent` JSON 流 → `onUpdate` → registry + 右坞 |
| `shouldAutoRun` 间隔 / 项目年龄 / 10s 防抖 | 已有 `schedule.ts`，不变 |
| `SYSTEM_SPAWNED_AGENT_TYPES` 非交互权限 | `SELF_EVOLVE_CHILD=1`，子代理 `--no-approve` |

## 架构

```
/dream | /distill | session_start(auto)
        │
        ▼
  startEvolveJob({ agent, source: manual|auto, cwd, ctx })
        │
        ├─ SubAgentRegistry.insert(running, task label, profile)
        ├─ sendMessage → Notice（start）
        ├─ spawnPiAgent(task, { onUpdate, env: SELF_EVOLVE_CHILD })
        │       └─ JSON 流 transcript → registry.output + 右坞
        └─ on finish:
              ├─ registry.mark done|error
              └─ if source===auto → sendMessage → Notice（done|error + 摘要）
```

### 模块职责

| 单元 | 职责 |
|---|---|
| `schedule.ts` | 纯间隔判定 + 标记文件（不变） |
| `runner.ts` | **重写**：封装 `spawnPiAgent` + registry 生命周期；不再 `stdio:ignore` |
| `index.ts` | 调度 / 命令调用 `startEvolveJob`；Notice 文案 |
| `multi-agent/registry.ts` | 复用，不 fork |
| `multi-agent/runner.ts` | 复用 `spawnPiAgent`（含 stream throttle） |
| `NoticePill.tsx` | 扩展 `customType` 标题：`self-evolve-*-start` / `*-done` / `*-error` |
| `ChatView.tsx` | slash 命令 `awaitStreamingEnd` 短超时（2s），因主 agent 不占槽 |

### Registry 字段约定

- `task`：`Dream（手动）` / `Distill（手动）` / `Auto Dream` / `Auto Distill`
- `profile`：JSON `{ "preset": "dream"|"distill", "source": "manual"|"auto" }`
- `output`：终态 transcript 摘要（`extractFinalText` 或截断前 N 字符供 Notice 使用）

### Notice `customType`

| customType | 何时 | 内容要点 |
|---|---|---|
| `self-evolve-dream-start` | 手动/自动 dream 启动 | 已在后台运行；点右上角 Bot 查看 |
| `self-evolve-distill-start` | 手动/自动 distill 启动 | 同上 |
| `self-evolve-dream-done` | **仅 auto** dream 成功 | 一行摘要 + 右坞链接提示 |
| `self-evolve-distill-done` | **仅 auto** distill 成功 | 同上 |
| `self-evolve-dream-error` | **仅 auto** dream 失败 | 错误原因 |
| `self-evolve-distill-error` | **仅 auto** distill 失败 | 错误原因 |

手动命令**仅 start Notice**；完成态只在右坞查看（用户选择）。

## 错误处理

- `spawnPiAgent` 失败：registry `error`；auto 发 error Notice；手动仅 registry + 角标变错态。
- `session_start` 调度 try/catch 包裹，失败不阻塞冷启动。
- 子代理超时：`runner` 已有 hard timer → registry `error` / auto error Notice。

## 测试

- `runner.test.ts`（新）：mock `spawnPiAgent` + registry，断言 insert → running → done，auto 路径触发两次 sendMessage。
- 保留 `schedule.test.ts` / `memory-file.test.ts`。
- `NoticePill.test.tsx`：新 customType 标题。
- 不新增 E2E；冒烟：手动 `/dream` → Notice + Bot 角标 + 右坞 transcript。

## 范围外

- 主聊天内联流式 dream（MiMo 手动 TUI 行为）。
- GrenAgent 侧栏新建「Auto Dream」会话条目。
- 完成时手动命令的主聊天 Notice。
- 自动打开右坞。

## 对现有实现的替换

- 删除 `runner.ts` 中 `stdio:ignore` + `unref` 路径。
- 删除 `index.ts` 中仅 toast 的 `ackBackgroundJob`（改为 startEvolveJob 统一 Notice）。
- 保留 `before_agent_start` MEMORY.md 注入与 `SELF_EVOLVE_CHILD` 防递归。
