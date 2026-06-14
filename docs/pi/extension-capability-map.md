# Pi 扩展能力矩阵

> 目标场景：当前项目是桌面端脚手架，后续需要在桌面端集成并扩展 Pi Agent。  
> 来源仓库：`https://github.com/earendil-works/pi.git`，本地 `pi/`，基准 `main` / `9ccfcd7c`。

## 总体判断

Pi 的设计取向是“core 极简，能力通过 extension/SDK/RPC 组合”。你列出的能力里，很多已经在 `packages/coding-agent/examples/extensions/` 有示例，不需要 fork core 起步。桌面端更适合把 Pi 当作 agent runtime，外层负责窗口、权限 UI、配置持久化、MCP 管理、沙箱生命周期和工作区策略。

## 能力映射

| 目标能力 | 上游相关示例/源码 | 推荐扩展方式 | 桌面端注意点 |
| --- | --- | --- | --- |
| 沙箱 | `examples/extensions/sandbox/index.ts`、`examples/extensions/gondolin/index.ts`、`docs/containerization.md` | override built-in tools 或替换工具 operations | 桌面端要管理依赖安装、平台支持、工作区 mount、沙箱状态 UI |
| 多智能体 | `examples/extensions/subagent/` | 注册 `subagent` tool，子进程跑 `pi --mode json -p --no-session` | 子代理输出、取消、并发、费用、project agents trust 需要桌面 UI 可见 |
| MCP | 上游无内建 MCP，README 明确 “No MCP” | 在桌面端或 extension 中实现 MCP client，再 `registerTool()` 暴露 MCP tools | 不建议改 core；MCP server 管理、鉴权、schema 映射放桌面层 |
| Plan mode | `examples/extensions/plan-mode/` | `setActiveTools()` 切 read-only/full；`tool_call` block bash；`before_agent_start` 注入模式上下文 | 可把计划确认、执行、进度 widget 做成桌面原生面板 |
| Todo | `examples/extensions/todo.ts`、`plan-mode/index.ts` | tool result details 或 custom session entry 保存分支相关状态 | 不要只存外部全局状态，否则 `/tree` 分支恢复会错 |
| 权限控制 | `permission-gate.ts`、`confirm-destructive.ts`、`project-trust.ts` | `tool_call` / session before hooks + `ctx.ui.confirm/select` | 非交互/RPC 模式默认 block 或交给桌面端确认 |
| 路径保护 | `protected-paths.ts`、`tool-override.ts` | 拦截 `write/edit/read/bash`，按 path policy block 或替换工具 | 路径判断要做 normalize/resolve，避免 `../`、symlink、大小写绕过 |
| 自定义上下文压缩 | `custom-compaction.ts`、`trigger-compact.ts` | `session_before_compact` 返回自定义 compaction；`ctx.compact()` 主动触发 | 压缩策略最好带 source files / modified files / decisions / next steps |
| 运行时动态注册工具 | `dynamic-tools.ts`、`reload-runtime.ts` | `pi.registerTool()`，必要时 `setActiveTools()` 或 reload resources | 动态工具 schema 要稳定，桌面端要能刷新工具列表 |
| 上下文嫁接 | `handoff.ts`、`session_before_tree`、`context`、`before_agent_start` | 生成 handoff prompt，新建 session；或 `context` hook 动态改 messages | 桌面端可做“从当前对话生成新任务上下文”按钮 |
| 自动 git | `git-checkpoint.ts`、`auto-commit-on-exit.ts`、`dirty-repo-guard.ts` | session/turn hooks + `pi.exec("git", ...)` | 自动提交要强确认；优先做 checkpoint / dirty guard，不默认 commit |
| 工具启用/禁止切换 | `tools.ts`、`plan-mode/index.ts`、SDK `tools` option | `getAllTools()`、`getActiveTools()`、`setActiveTools()` | 工具状态应随 session branch 恢复，避免全局状态污染 |
| 结构化输出终止 | `structured-output.ts` | 自定义 terminating tool，返回 `details` + `terminate: true` | 桌面端从 `details` 读取机器可用结果，避免再等一轮 assistant 文本 |

## 应优先采用的集成形态

### 桌面端优先：SDK 或 RPC

如果桌面端后端是 Node.js/Electron/Tauri sidecar：

- **Node/Electron main process**：优先 SDK，使用 `createAgentSession()` / `createAgentSessionRuntime()`，可以直接注入 `resourceLoader`、`customTools`、`settingsManager`。
- **非 Node 后端或语言隔离**：优先 RPC，启动 `pi --mode rpc`，通过 JSONL command/event 管理会话。

### 能力优先：extension

除非要改 Pi 的公共 API，否则优先写 extension：

- 安全策略：`tool_call`、`project_trust`、`session_before_*`
- UI 交互：`ctx.ui.select/confirm/input/editor/notify/setStatus/setWidget`
- 自定义工具：`pi.registerTool()`
- 模型/provider：`pi.registerProvider()`
- 上下文：`context`、`before_agent_start`、`message_end`
- 压缩：`session_before_compact`、`ctx.compact()`
- 会话：`newSession()`、`switchSession()`、`fork()`、`navigateTree()`

## 推荐落地顺序

1. **先接通 runtime**：桌面端选择 SDK 或 RPC，能启动 session、发送 prompt、流式接收事件、展示 tool call。
2. **加权限和路径保护**：先实现 `permission-gate`、`protected-paths` 类策略，避免后续功能放大风险。
3. **加工具启停与 plan mode**：把 read-only exploration 和 execution 分开，解决“先规划再执行”的产品基础。
4. **加 todo 和结构化输出**：让 agent 的阶段状态和最终结果可被桌面端稳定读取。
5. **加自定义 compaction / handoff**：解决长上下文和跨任务上下文嫁接。
6. **加 sandbox**：从 path policy 进化到 OS/VM/container 边界。
7. **加多智能体**：在权限、沙箱、输出模型成熟后再引入并发子代理。
8. **加 MCP**：把 MCP 管理放桌面端，动态映射成 Pi tools。
9. **加自动 git**：先做 dirty guard / checkpoint，再考虑自动 commit。

## 不建议一开始就做的事

- 不建议 fork Pi core 来内建 MCP、plan mode、todo 或 permissions。上游已经把这些留给 extension 层。
- 不建议在没有路径保护和权限确认前开启 `bash`、`write`、`edit` 给桌面端用户。
- 不建议自动提交默认开启。先做 checkpoint 和用户确认。
- 不建议把 todo、plan、tool 状态只存桌面全局 store。Pi session 是树结构，状态需要能随 branch 恢复。
- 不建议把 MCP tool schema 直接裸传给模型。要做名称规范、描述清洗、参数限制、敏感字段过滤。
