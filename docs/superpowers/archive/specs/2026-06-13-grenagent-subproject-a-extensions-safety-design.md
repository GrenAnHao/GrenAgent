# 子项目 A：扩展能力补全 + 安全/生命周期框架 — 设计

- 日期：2026-06-13
- 状态：设计待审（brainstorming 产出）
- 父任务：GrenAgent / Pi agent 能力补全（拆分为 A→B→C，本文档为 **A**）
- 后续：B = 记忆系统迁移 mem0；C = 借鉴 MiMo-Code/opencode 深度优化

## 1. 目标

为 GrenAgent（Tauri 桌面）+ Pi sidecar 补齐缺失的 agent 能力，并建立统一的安全/生命周期护栏框架：

1. 安全/生命周期框架（地基）
2. todo（任务清单）
3. plan-mode（规划模式）
4. sub-agent（修复桌面可用性 + UI）
5. web search（联网搜索）
6. MCP 客户端（连接外部 MCP servers）

最大化复用 Pi 官方扩展示例（`pi/packages/coding-agent/examples/extensions`），改造为 GrenAgent 自研 extension。

## 2. 背景与现状（来自能力排查）

当前 sidecar = **Pi 0.78 core（7 工具 + 22 命令）+ 8 个自研 extension（10 工具 + 4 命令）**。

| 能力 | 现状 |
|------|------|
| todo | ❌ 无（仅 docs 规划） |
| bash/shell | ✅ Pi core 内置 `bash` 工具，已有 UI 卡片 |
| web search | ⚠️ 仅 `fetch_url`（抓指定 URL），无搜索引擎 |
| MCP 客户端 | ❌ 无 |
| plan mode | ❌ 无 |
| sub-agent | ⚠️ `spawn_agent` 已打包，但 `runner.ts` 默认 spawn 系统 `pi`、`PI_BIN` 未注入，桌面无全局 pi 时失败；无子代理 UI |

## 3. 关键决策（brainstorming 已确认）

- **安全级别**：中档 + 预留沙箱接口（不在本期实现 OS 级沙箱/micro-VM，但留扩展点）
- **能力移植策略**：复用官方示例的「工具/命令逻辑」；UI 一律走 GrenAgent 的 **React**（经 Tauri RPC + 现有卡片/面板/确认弹窗模式），**不照搬** 终端 overlay/TUI
- **web search provider**：默认 **Tavily**（`TAVILY_API_KEY`），可配 Brave；复用 `fetch_url` 抓正文
- **MCP 配置来源**：设置面板的 `mcpServers` JSON（形如 `.cursor/mcp.json`），支持 stdio + SSE 传输

## 4. 架构

### 4.1 Pi Extension API 基础（已确认形态）

```ts
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => { /* 可返回 { block:true, reason } 拦截 */ });
  pi.on("session_start" | "project_trust" | "model_select" | "input", handler);
  pi.registerTool({ name, label, description, parameters /* typebox */, execute });
  pi.registerCommand(name, { description, handler });
  // ctx.ui.confirm/select/notify/setStatus/setWidget...
  // 状态持久化：tool result 的 details 字段随 session 存（支持 fork）
}
```

### 4.2 GrenAgent 集成模式（三层）

1. **Sidecar 打包**：每个新 extension 加入 `extensions/index.ts` 的 `allExtensions` → `build-sidecar.mjs` 用 `bun build --compile` 静态编入二进制。
2. **Rust/RPC 层**：必要时在 `src-tauri` 暴露新命令（如 settings 注入、子代理查询）。
3. **React UI 层**：
   - 工具结果 → `src/features/tools/extensionCards.tsx` 新增卡片
   - 命令/管理界面 → 复用 `ManagerLayout` / `RightPanel`
   - 确认/选择 → React 弹窗经现有 ask/confirm RPC（替代示例里的 `ctx.ui.confirm`）

### 4.3 模块 0：安全/生命周期框架（地基，先行）

新 `extensions/safety/`：
- **危险 bash 拦截**：`tool_call` 命中 `rm -rf`、`sudo`、`mkfs`、`:(){:|:&};:`、`> /dev/sd*` 等模式 → 弹确认（React），拒绝则 `{ block:true }`
- **写保护路径**：`write`/`edit` 命中 `.env`、`.git/`、`node_modules/`、`*.key`、`*.pem` → 默认 block + 提示（可在设置放开）
- **项目信任**：`project_trust` 事件，首次打开某工作区需用户确认信任后才允许写/bash
- **危险会话操作确认**：clear/fork/switch 前确认
- **sandbox adapter 接口**：定义 `SandboxAdapter`（`exec(cmd)`/`isEnabled()`）抽象，本期实现 `NoopSandbox`，预留 future `AnthropicSandbox`/`GondolinSandbox`
- 参考示例：`permission-gate.ts`、`protected-paths.ts`、`project-trust.ts`、`confirm-destructive.ts`、`sandbox/`
- UI：设置面板加「安全」分类（开关：危险命令确认、路径保护、项目信任）

### 4.4 模块 1：todo

- `extensions/todo/`：`todo` 工具（增/改/删/列）+ `/todos` 命令；状态存于 tool result `details`，`session_start` 时从 `ctx.sessionManager.getBranch()` 重建（支持 fork）
- 参考：`todo.ts`
- UI：对话内 `TodoCard`（勾选/进度）；右面板可选 todo 视图（复用 `RightPanel`）

### 4.5 模块 2：plan-mode

- `extensions/plan-mode/`：`/plan` 进入只读规划；用 `setActiveTools` 切换只读白名单（read/grep/find/ls/fetch_url），拦截写类工具；plan→act 切换；步骤追踪
- 参考：官方 `plan-mode/`（index.ts + utils.ts）
- UI：header 模式指示（Plan/Act）+ 步骤卡片 + 切换按钮

### 4.6 模块 3：sub-agent 修复 + UI

- 修 `extensions/multi-agent/runner.ts`：spawn 时优先用 `PI_BIN`
- `src-tauri/src/pi/sidecar.rs`：spawn sidecar 时注入 `PI_BIN = <当前 sidecar 可执行文件路径>`，使子代理复用 sidecar 本体而非系统 `pi`
- `settingsSchema.ts`：加 `PI_BIN`（可选覆盖）
- 同样修 `long-term-memory/extractor.ts` 的 spawn 路径（`MEMORY_EXTRACT=1` 时）
- UI：`SpawnAgentCard`（已有）+ 右面板「子代理」列表/进度

### 4.7 模块 4：web search

- `extensions/web-search/`：`web_search` 工具，provider=Tavily（默认）/Brave，env 配 API key；返回「摘要 + 结果链接」，可选对 top 结果调用 `fetch_url` 取正文
- 借鉴：opencode `packages/opencode/src/tool/websearch/`
- UI：`WebSearchCard`（结果列表）+ 输入区「联网搜索」快捷按钮

### 4.8 模块 5：MCP 客户端

- `extensions/mcp/`：读设置 `mcpServers`（`{ name: { command/url, args, env, transport } }`），用 `@modelcontextprotocol/sdk` client 连接（stdio/SSE）；`listTools` 后动态 `registerTool` 为 `mcp__<server>__<tool>`，调用转发到对应 server；连接生命周期随 session
- 借鉴：opencode `packages/opencode/src/cli/cmd/mcp.ts` 与其 tool 映射
- UI：连接面板（`ConnectionsPanel`）加 MCP servers 区：状态（已连/失败/工具数）；设置面板编辑 `mcpServers` JSON

## 5. 数据流（统一）

```
用户输入 / agent 决策
  → sidecar（Pi runtime + extensions）
  → tool execute / command handler（含 safety tool_call 拦截）
  → 结果 details / RPC 事件
  → Tauri Rust 转发
  → React 卡片/面板渲染（extensionCards / RightPanel / ConnectionsPanel）
确认类：extension 请求 → RPC → React 弹窗 → 用户决定 → 回传 block/allow
```

## 6. 错误处理

- 安全拦截：返回 `{ block:true, reason }`，UI 显示原因
- MCP 连接失败：该 server 标红降级，不影响其他工具
- sub-agent spawn 失败：回退提示（检查 PI_BIN）
- web search API 失败/无 key：回退 `fetch_url` 或提示配置 key

## 7. 测试策略

- extension：vitest 单测工具/命令逻辑（mock ctx）
- Rust：`cargo test` 覆盖 PI_BIN 注入、settings env、MCP 配置解析
- 前端：vitest 覆盖新卡片/面板渲染
- 集成：`build-sidecar.mjs` 重建 + 启动冒烟（日志 Running）

## 8. 实现顺序（交给 writing-plans 拆 phase）

`A0 安全框架 → A1 todo → A2 plan-mode → A3 sub-agent 修复 → A4 web search → A5 MCP`（MCP 最复杂，垫后）

每个 phase 自带 TDD（红→绿→重构）+ commit，沿用既有 phase1-7 模式。

## 9. 文件清单（预估）

**新增**：
- `extensions/safety/`、`extensions/todo/`、`extensions/plan-mode/`、`extensions/web-search/`、`extensions/mcp/`（各 index.ts + 测试）
- `src/features/tools/`：TodoCard、WebSearchCard 等卡片
- `src/features/todo/`、`src/features/subagents/`（右面板视图，按需）

**修改**：
- `extensions/index.ts`（注册新 extension 到 allExtensions）
- `extensions/multi-agent/runner.ts`、`extensions/long-term-memory/extractor.ts`（PI_BIN）
- `src-tauri/src/pi/sidecar.rs`（注入 PI_BIN）
- `src/features/settings/settingsSchema.ts`（PI_BIN、TAVILY/Brave key、mcpServers、安全开关）
- `src/features/connections/ConnectionsPanel.tsx`（MCP 状态）
- `src/features/tools/extensionCards.tsx`、`toolUtils.ts`（新工具图标/卡片）
- `src/features/panels/RightPanel.tsx`（todo / 子代理视图）
- `src/features/chat/input/config.tsx`（联网搜索快捷）

## 10. 借鉴 opencode（MiMo-Code，详见 C）

- MCP client：`packages/opencode/src/cli/cmd/mcp.ts` 的 server 配置与 tool 映射思路
- web search：`packages/opencode/src/tool/websearch/`
- （checkpoint/fork、上下文压缩、workflow 留待 C 子项目）

## 11. 非目标（YAGNI）

- 不做重档 OS 沙箱 / micro-VM（仅留 `SandboxAdapter` 接口）
- 不做记忆系统迁移（B 子项目）
- 不做 opencode 架构移植（C 子项目）
- 不照搬官方示例的 TUI overlay/游戏类示例
