# Pi 桌面端扩展操作手册

> 目标：为桌面端脚手架后续扩展 Pi Agent 提供可执行的实现路径。  
> 来源仓库：`https://github.com/earendil-works/pi.git`，本地 `pi/`，基准 `main` / `9ccfcd7c`。

## 1. 桌面端集成基座

### 方案 A：SDK 集成

适合 Electron main process、Node sidecar 或能直接跑 TypeScript/JavaScript 的后端。

关键 API：

- `createAgentSession()`
- `createAgentSessionRuntime()`
- `createAgentSessionServices()`
- `SessionManager`
- `SettingsManager`
- `DefaultResourceLoader`
- `ModelRegistry`
- `AuthStorage`

参考：

- `examples/sdk/12-full-control.ts`
- `examples/sdk/13-session-runtime.ts`
- `examples/sdk/05-tools.ts`
- `examples/sdk/06-extensions.ts`

推荐模式：

```typescript
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  additionalExtensionPaths: [
    "./extensions/desktop-permissions.ts",
    "./extensions/desktop-tools.ts",
  ],
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd,
  resourceLoader,
  tools: ["read", "grep", "find", "ls"],
  sessionManager: SessionManager.create(cwd),
});
```

如果桌面端允许切换 workspace/session，使用 `AgentSessionRuntime`。每次 `newSession()`、`switchSession()`、`fork()` 后要重新绑定 event subscription 和 extension UI。

### 方案 B：RPC 集成

适合 Tauri/Rust、C#、Python 或希望把 Pi 当独立进程的桌面端。

启动：

```bash
pi --mode rpc --name "desktop-session"
```

桌面端负责：

- 向 stdin 写 JSONL command。
- 从 stdout 解析 JSONL response/event。
- 处理 `extension_ui_request` 并回写 `extension_ui_response`。
- 处理进程生命周期、abort、stderr、crash recovery。

参考：

- `examples/rpc-extension-ui.ts`
- `packages/coding-agent/docs/rpc.md`

## 2. 沙箱

Pi 默认没有权限隔离。你需要从两层做：

1. **策略层**：拦截危险工具调用。
2. **执行层**：把实际执行放入 sandbox/VM/container。

### 轻量策略层

先实现：

- `permission-gate.ts`：危险 bash 命令确认。
- `protected-paths.ts`：禁止写敏感路径。
- `tool-override.ts`：override built-in read/write/bash，加入审计和阻断。

示例 hook：

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return;
  if (isDangerous(event.input.command as string)) {
    if (!ctx.hasUI) return { block: true, reason: "Blocked in headless mode" };
    const ok = await ctx.ui.confirm("Run command?", String(event.input.command));
    if (!ok) return { block: true, reason: "Blocked by user" };
  }
});
```

### OS sandbox

参考 `examples/extensions/sandbox/index.ts`。

它使用 `@anthropic-ai/sandbox-runtime`：

- macOS：`sandbox-exec`
- Linux：`bubblewrap`

实现方式：

- 注册同名 `bash` tool 覆盖内置 bash。
- 用 `createBashTool(localCwd, { operations })` 注入自定义 `BashOperations`。
- 在 `user_bash` event 中返回同一套 operations，覆盖 `!` 命令。
- 在 `session_start` 初始化 sandbox config。
- 在 `session_shutdown` 清理 sandbox。

配置来源：

```text
~/.pi/agent/extensions/sandbox.json
<cwd>/.pi/sandbox.json
```

建议桌面端把这份配置做成 UI：

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws"],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*"]
  }
}
```

### VM tool routing

参考 `examples/extensions/gondolin/index.ts`。

它把 host cwd mount 到 guest `/workspace`，然后重建内置工具：

- `createReadTool(GUEST_WORKSPACE, { operations })`
- `createWriteTool(...)`
- `createEditTool(...)`
- `createBashTool(...)`
- `createLsTool(...)`
- `createFindTool(...)`
- 自定义 grep walker

核心点：

- path 需要在 host 和 guest 之间转换。
- `before_agent_start` 要改 system prompt 里的 cwd，告诉模型实际工作目录是 `/workspace`。
- `session_shutdown` 关闭 VM。
- `user_bash` 也要路由进 VM。

桌面端建议：

- 沙箱状态显示在顶部或 session footer。
- 第一次启用时检测平台依赖。
- 把 host workspace mount 设成只允许当前项目。
- `bash/write/edit` 默认走 sandbox，除非用户明确关闭。

## 3. 多智能体

参考 `examples/extensions/subagent/`。

上游实现方式：

- 注册 `subagent` tool。
- 每个子代理是单独 `pi` 进程。
- 子进程使用 `--mode json -p --no-session`。
- agent 定义来自 markdown frontmatter。
- 支持 single、parallel、chain 三种模式。

Agent 定义：

```markdown
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
---

System prompt for this agent.
```

目录：

```text
~/.pi/agent/agents/*.md
.pi/agents/*.md
```

安全模型：

- 默认只加载 user-level agents。
- project-local agents 需要 `agentScope: "project"` 或 `"both"`。
- 交互模式下对 project agents 做确认。

桌面端建议：

- 先支持 user-level agents，再开放 project agents。
- UI 展示每个子代理：状态、工具调用、最终输出、tokens、cost、model。
- 并发限制保守起步：例如 max 4。
- 子代理默认 read-only，只有 worker 类 agent 才给 write/edit/bash。
- abort 要杀子进程并清理临时 prompt 文件。

## 4. MCP

Pi 上游没有内建 MCP，README 明确把 MCP 留给 extension 或外部工具。桌面端可这样做：

### 推荐架构

```text
Desktop MCP Manager
  - 启动/鉴权/列出 MCP servers
  - 读取 tool schemas
  - 做权限策略、敏感字段过滤、调用审计
        |
        v
Pi Extension
  - 将允许的 MCP tools 映射成 pi.registerTool()
  - execute() 内调用桌面端 MCP bridge
        |
        v
Pi Agent
```

### Tool 映射规则

- MCP tool name 转为稳定 Pi tool name，例如 `mcp_<server>_<tool>`。
- description 要加入 server 名称、风险级别、输出大小限制。
- parameters 使用 MCP schema，但过滤不该由模型填写的字段。
- execute 内部加超时、取消、输出截断。
- 对写操作或外部副作用操作，先通过桌面权限 UI 确认。

### 不建议

- 不建议直接把所有 MCP tools 暴露给模型。
- 不建议把 MCP 凭证传入 agent context。
- 不建议在 Pi core 内实现 MCP；先用 extension 保持可升级性。

## 5. Plan Mode

参考 `examples/extensions/plan-mode/`。

核心机制：

- `pi.registerFlag("plan")`
- `/plan` command 和 `Ctrl+Alt+P` shortcut
- `pi.setActiveTools(PLAN_MODE_TOOLS)`
- `tool_call` hook 拦截非 allowlist bash
- `before_agent_start` 注入 `[PLAN MODE ACTIVE]` 上下文
- `agent_end` 提取 `Plan:` 下的编号步骤
- 用户确认执行后恢复 full tools
- `turn_end` 解析 `[DONE:n]` 更新进度
- `pi.appendEntry()` 持久化状态

推荐桌面端流程：

1. 用户点击“计划模式”。
2. 工具切换成 `read, grep, find, ls`，是否保留 `bash` 取决于 allowlist。
3. 系统提示强制只做分析和计划。
4. 生成计划后，桌面端展示结构化步骤。
5. 用户点击“执行”后恢复 `edit/write/bash`。
6. 执行阶段要求模型用 `[DONE:n]` 或 structured tool 更新步骤。

注意：上游示例里 `PLAN_MODE_TOOLS` 包含 `questionnaire`，你的桌面端如果没有该工具，要替换为自己的 `ask_user` 或 omit。

## 6. Todo

参考 `examples/extensions/todo.ts`。

关键设计：todo 状态存在 tool result details 中，并从 `ctx.sessionManager.getBranch()` 重建。这能保证：

- `/tree` 切分支后 todo 回到该 branch 的正确状态。
- fork/clone 不会共享错误的全局 todo。

推荐实现：

- `todo` tool 支持 `list/add/toggle/clear/update`。
- `details` 保存完整状态快照。
- 桌面端从 tool result details 或 session branch 重建 UI。
- 如果 plan mode 已有步骤，todo 可以和 plan steps 合并成一个任务面板。

不要只把 todo 存桌面全局 store，否则 session branch 会失真。

## 7. 权限控制与路径保护

相关示例：

- `permission-gate.ts`
- `protected-paths.ts`
- `confirm-destructive.ts`
- `project-trust.ts`
- `tool-override.ts`

### 权限控制层级

1. **Project trust**：是否允许加载项目 `.pi/` 资源和 project-local agents/extensions。
2. **Tool enablement**：当前 session 允许哪些工具。
3. **Tool call policy**：每次工具调用是否允许。
4. **Path policy**：工具参数里的 path 是否允许。
5. **Execution sandbox**：就算允许，也只在受限环境执行。

### 路径保护建议

最小保护：

- `.env`
- `.env.*`
- `.git/`
- `node_modules/`
- `~/.ssh`
- `~/.aws`
- `~/.gnupg`
- credentials/secrets files

实现时必须：

- `resolve(ctx.cwd, inputPath)`。
- 检查是否在 workspace 内。
- 做 path normalize。
- Windows 下注意大小写和盘符。
- 如果支持 symlink，落地前检查 realpath。

### Headless/RPC 默认策略

如果 `!ctx.hasUI`，危险操作默认 block，不要默认 allow。

## 8. 自定义上下文压缩

相关示例：

- `custom-compaction.ts`
- `trigger-compact.ts`
- `handoff.ts`

### 自定义压缩

用 `session_before_compact`：

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, signal } = event;
  const model = ctx.modelRegistry.find("google", "gemini-2.5-flash");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  const summary = await summarize(preparation, model, auth, signal);
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: { strategy: "desktop-full-summary" },
    },
  };
});
```

压缩摘要建议包含：

- 用户目标。
- 已做决策和原因。
- 已读/已改文件。
- 当前代码状态。
- 工具调用中的重要输出。
- 未完成任务。
- 下一步。

### 主动触发压缩

用 `ctx.compact()`：

```typescript
ctx.compact({
  customInstructions: "Focus on modified files and pending tasks",
  onComplete: () => ctx.ui.notify("Compaction completed"),
  onError: (error) => ctx.ui.notify(error.message, "error"),
});
```

### 上下文嫁接

`handoff.ts` 不压缩当前 session，而是生成新 session 的启动 prompt：

1. 从 `ctx.sessionManager.getBranch()` 取当前 branch。
2. 如果有 compaction entry，保留 compaction summary 和 first kept entry 之后的内容。
3. `convertToLlm()` + `serializeConversation()` 生成可读历史。
4. 用当前 model 生成 handoff prompt。
5. `ctx.newSession({ parentSession, withSession })` 创建新 session。
6. 把生成的 prompt 填到 editor，用户确认后再发送。

桌面端可做成“从当前对话派生新任务”按钮。

## 9. 动态注册工具与资源

相关示例：

- `dynamic-tools.ts`
- `dynamic-resources/index.ts`
- `reload-runtime.ts`

### 动态工具

```typescript
pi.registerTool({
  name: "my_dynamic_tool",
  label: "My Dynamic Tool",
  description: "Do something",
  parameters: Type.Object({ message: Type.String() }),
  async execute(_id, params) {
    return { content: [{ type: "text", text: params.message }] };
  },
});
```

如果工具需要立刻进入可用集合，注册后检查：

```typescript
const active = new Set(pi.getActiveTools());
active.add("my_dynamic_tool");
pi.setActiveTools([...active]);
```

桌面端用途：

- MCP tools 动态映射。
- workspace-specific tools。
- 用户安装/卸载工具后刷新工具列表。

### 动态资源

用 `resources_discover` 返回额外资源路径：

```typescript
pi.on("resources_discover", () => ({
  skillPaths: ["/path/to/SKILL.md"],
  promptPaths: ["/path/to/prompt.md"],
  themePaths: ["/path/to/theme.json"],
}));
```

### Reload

LLM-callable tool 不能直接调用 `ctx.reload()`，因为 tool 拿到的是 `ExtensionContext`。上游示例做法是：

```typescript
pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
```

由 command handler 使用 `ExtensionCommandContext.reload()`。

## 10. 自动 Git

相关示例：

- `git-checkpoint.ts`
- `auto-commit-on-exit.ts`
- `dirty-repo-guard.ts`

### 推荐优先级

1. **Dirty guard**：切 session/fork 前检查 `git status --porcelain`。
2. **Checkpoint**：在 turn 开始前 `git stash create`，fork 时可恢复。
3. **手动确认 commit**：自动生成 commit message，但让用户确认。
4. **自动 commit**：只作为可选高级设置，默认关闭。

不建议直接照搬 `auto-commit-on-exit.ts` 默认行为到桌面端。它会 `git add -A` 并提交，风险较高。

### 桌面端实现建议

- 每次 agent 修改文件后，在 UI 侧显示 changed files。
- 创建 checkpoint 不改变工作区，优先 `git stash create`。
- 对 `git stash apply`、`git add`、`git commit` 做显式确认。
- 记录 checkpoint 与 session entry id 的关联，方便 `/tree` 或 fork 时恢复代码状态。

## 11. 工具启用/禁止切换

相关示例：

- `tools.ts`
- `plan-mode/index.ts`
- `examples/sdk/05-tools.ts`

核心 API：

- `pi.getAllTools()`
- `pi.getActiveTools()`
- `pi.setActiveTools(toolNames)`

Session 级持久化：

- 用 `pi.appendEntry("tools-config", { enabledTools })` 保存。
- 在 `session_start` 和 `session_tree` 从 `ctx.sessionManager.getBranch()` 恢复。

桌面端建议：

- 工具面板展示所有工具、来源、schema、风险级别。
- read-only preset：`read, grep, find, ls`
- default preset：`read, bash, edit, write`
- dangerous preset：包含外部网络、MCP 写操作、git 写操作时必须确认。

## 12. 结构化输出终止

参考 `structured-output.ts`。

核心点：

- 自定义 tool 返回 `details`，桌面端从 details 读机器可用数据。
- 返回 `terminate: true`，当该 batch 所有工具结果都 terminating 时，agent 不再追加一轮 assistant 文本。

示例：

```typescript
return {
  content: [{ type: "text", text: `Saved structured output: ${params.headline}` }],
  details: {
    headline: params.headline,
    summary: params.summary,
    actionItems: params.actionItems,
  },
  terminate: true,
};
```

适用场景：

- 任务总结。
- 计划步骤输出。
- 测试报告。
- PR 描述草稿。
- 桌面端需要稳定 JSON-like result 的自动化流程。

## 13. 推荐扩展目录

桌面脚手架可以维护自己的 Pi package 或 extensions 目录：

```text
desktop-pi-extensions/
├── package.json
├── extensions/
│   ├── desktop-permissions.ts
│   ├── desktop-sandbox.ts
│   ├── desktop-mcp.ts
│   ├── desktop-plan-mode.ts
│   ├── desktop-todo.ts
│   ├── desktop-compaction.ts
│   ├── desktop-git.ts
│   └── desktop-structured-output.ts
├── prompts/
│   ├── plan.md
│   └── review.md
└── skills/
    └── desktop-workflow/SKILL.md
```

`package.json`：

```json
{
  "name": "desktop-pi-extensions",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

## 14. 实施检查清单

- [ ] 选择 SDK 或 RPC 作为桌面端集成方式。
- [ ] 建立 extension 加载目录和版本管理方式。
- [ ] 实现权限确认和路径保护。
- [ ] 实现工具启停 preset。
- [ ] 实现 plan mode read-only/execution 切换。
- [ ] 实现 todo/plan 状态在 session branch 上恢复。
- [ ] 实现 structured output terminating tool。
- [ ] 实现自定义 compaction 和 handoff。
- [ ] 接入 sandbox 或 VM tool routing。
- [ ] 接入 MCP bridge 并做 tool schema 过滤。
- [ ] 实现 dirty repo guard 和 checkpoint。
- [ ] 为所有危险能力做非交互默认 block。
- [ ] 为桌面端 UI 展示 tool call、permission prompt、sandbox state、subagent state、cost/usage。
