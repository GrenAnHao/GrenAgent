# MCP 权限控制 · 阶段 2（前端管理面板）设计

- 日期：2026-06-15
- 状态：设计待审（brainstorming 产出）
- 前置：阶段 1（`extensions/mcp-policy/`）已实现，提供 `~/.pi/mcp-policy.json`（三态 + 规则）与 `~/.pi/mcp-audit.jsonl`
- 配套设计：`docs/superpowers/specs/2026-06-15-mcp-tool-permission-design.md`

## 1. 目标

给 GrenAgent 桌面端提供可视化的 MCP 工具权限管理：在扩展页按工具看/调三态（auto/needs_approval/disabled）、编辑参数级规则、查看审计日志。权限变更即时生效、无需重启。

成功标准：用户不必手改 JSON 就能管理每个 MCP 工具的权限与规则；能查看历史调用审计；权限改动写入 `~/.pi/mcp-policy.json` 后，sidecar 下次调用即按新策略执行。

## 2. 背景与关键约束

阶段 1 的策略与审计落在用户级文件，sidecar `tool_call` 钩子运行时读、mtime 缓存。阶段 2 给这套文件加前端管理界面。探索发现两个约束，决定阶段 2 不是"纯前端"：

1. **前端拿不到工具名列表**：`mcpStatusStore` 只有每 server 的工具数量，无工具名。需让 `mcp` 扩展把工具名（注册全名）随 `setStatus` 推送。
2. **全局文件读写需新后端 command**：Pi 不用 `@tauri-apps/plugin-fs`，`files.rs` 的 `read_file/write_file` 限制在 workspace 内；`~/.pi/` 在 workspace 外，需新增专用 Rust command。

数据流利好：`ExtensionUiHost` 已把 `setStatus("mcp")` 的整个 JSON 透传给 `mcpStatusStore.setServers`，故工具名只需在 sidecar summary 与 store 类型上加字段，中转层不改。

## 3. 设计决策（brainstorming 已确认）

| 维度 | 决策 |
|------|------|
| 范围 | 完整版：sidecar 推工具名 + Rust 全局文件 command + 前端 per-tool 三态 + 规则编辑 + 审计查看 |
| 面板形态 | `McpServerCard` 可展开，展示该 server 工具列表 |
| 三态控件 | `Segmented` 三段（自动 / 需审批 / 禁用） |
| 审计查看 | MCP tab 顶部「审计」入口 → 全局审计列表（可按 server/工具/decision 筛选） |
| 参数规则编辑 | 工具行「规则」→ `ToolPermissionModal`（三态 + 规则数组编辑） |
| policy key | 工具注册全名 `mcp__server__tool`（与 sidecar `decide` 匹配一致），UI 显示去前缀短名 |
| Rust 落点 | 新文件 `commands/mcp_policy.rs`（与 `files.rs` 的 workspace 限制隔离） |
| 生效方式 | 权限变更写文件即时生效，**不触发**「重启生效」（区别于 `MCP_SERVERS`） |

## 4. 架构：三层

```
sidecar (extensions/mcp)            Rust (commands/mcp_policy.rs)        前端 (features/extensions)
summary() 每 server 加 toolNames  →  read_mcp_policy()  -> String     ←→ ExtensionsPanel (持 policy state)
ctx.ui.setStatus("mcp", json)        write_mcp_policy(content)            ├ McpServerCard 可展开 → 工具行
   │                                 read_mcp_audit()   -> String         │   Segmented 三态 + 「规则」按钮
   ▼                                   (路径 ~/.pi/, 原子写)              ├ ToolPermissionModal(三态+规则编辑)
ExtensionUiHost 透传 → mcpStatusStore(+toolNames)                         └ AuditModal(解析 jsonl + 筛选)
```

## 5. sidecar 改动（`extensions/mcp/index.ts`，最小）

- `registry` 的值类型加 `toolNames?: string[]`。
- `connectServer` 成功分支：`registry.set(s.name, { status: "connected", tools: tools.length, toolNames: newNames })`（`newNames` 已是注册全名 `mcp__server__tool`）。
- `summary()` 每个 server 加 `toolNames: registry.get(s.name)?.toolNames ?? []`。

不改连接、注册、`mcp-policy` 钩子逻辑。

## 6. store 改动（`tauri-agent/src/stores/mcpStatusStore.ts`）

`McpServerStatus` 加 `toolNames?: string[]`。`ExtensionUiHost` 不改（已透传整个对象）。

## 7. Rust command（新 `tauri-agent/src-tauri/src/commands/mcp_policy.rs`）

```rust
fn pi_home() -> PathBuf            // ~/.pi（与 sidecar os.homedir() 一致的 home）
#[tauri::command] async fn read_mcp_policy() -> Result<String, String>   // 不存在返回 ""
#[tauri::command] async fn write_mcp_policy(content: String) -> Result<(), String>  // 原子写 tmp+rename, mkdir -p ~/.pi
#[tauri::command] async fn read_mcp_audit() -> Result<String, String>    // 不存在返回 ""
```

- 路径硬编码到 `~/.pi/mcp-policy.json` / `~/.pi/mcp-audit.jsonl`，不接受任意路径参数（最小权限，避免变成任意文件读写）。
- 注册进 `src-tauri/src/lib.rs` 的 `invoke_handler![]`。
- home 解析：复用项目现有依赖（`dirs` crate 或 `std::env` `USERPROFILE`/`HOME`），与 sidecar `os.homedir()` 落点一致。

## 8. 前端

### 8.1 调用封装（`tauri-agent/src/lib/`）

```ts
readMcpPolicy(): Promise<string>                 // invoke('read_mcp_policy')
writeMcpPolicy(content: string): Promise<void>   // invoke('write_mcp_policy', { content })
readMcpAudit(): Promise<string>                  // invoke('read_mcp_audit')
```

### 8.2 纯函数（新 `features/extensions/mcpPolicy.ts`，可单测）

操作**原始对象**以保留 sidecar 写入的其他字段（读-改-写不丢字段）：

```ts
type Perm = 'auto' | 'needs_approval' | 'disabled';
type RulePolicy = 'never' | 'required' | 'always';
interface RuleItem { match?: Record<string, string>; policy: RulePolicy }

parsePolicyDoc(json: string): Record<string, unknown>          // 容错，返回 raw 对象
getToolPerm(raw, toolFullName): Perm                            // 无记录 ⇒ 'auto'
getToolRules(raw, toolFullName): RuleItem[]
setToolPerm(raw, toolFullName, perm): Record<string, unknown>  // 返回新 raw（不可变）
setToolRules(raw, toolFullName, rules): Record<string, unknown>
serializePolicyDoc(raw): string                                // JSON.stringify(raw, null, 2)
parseAuditLines(text: string): AuditEntry[]                     // split \n + JSON.parse 容错跳过坏行
shortToolName(fullName): string                                // 去 mcp__server__ 前缀
```

### 8.3 组件

- **`McpServerCard.tsx`（改为可展开）**：加 `expanded` 态与展开区。展开渲染 `live.toolNames`（来自 store）逐行：短名 + `Segmented`（自动/需审批/禁用，值=`getToolPerm`）+ 「规则」按钮。`onPermChange(fullName, perm)` 与 `onOpenRules(fullName)` 由 props 上抛。server 未连接（无 toolNames）时展开提示"连接后可查看并配置工具权限"。
- **`ToolPermissionModal.tsx`（新）**：`@lobehub/ui` `Modal`；标题工具全名；含 `Segmented` 三态 + 规则数组编辑器（每条：`KeyValueEditor` 编 match + `Select` 选 policy；增/删/排序条目）；保存调 `onSave(fullName, { perm, rules })`。
- **`AuditModal.tsx`（新）**：`Modal`；打开时 `readMcpAudit` → `parseAuditLines` → 倒序列表（时间/server/工具/decision/参数摘要）；顶部按 server、工具、decision 筛选；空态提示。
- **`ExtensionsPanel.tsx`（改）**：加 `policyRaw` state（mount 时 `readMcpPolicy`→`parsePolicyDoc`）；`writePolicy(next)` = `writeMcpPolicy(serializePolicyDoc(next))` 后 `setPolicyRaw(next)`；MCP hero 行加「审计」按钮（`ScrollText` lucide 图标）控制 `AuditModal`；把 policy + 回调传给 `McpServerCard`；持有 `ToolPermissionModal` 开关与目标工具。权限相关改动**不调** `markChanged()`（不显示重启）。

图标统一 `@lobehub/ui` 的 `Icon` + lucide（无 emoji）。

## 9. 数据流

- **加载**：`mcpStatusStore`（toolNames）+ `readMcpPolicy` → 每工具按全名取三态显示
- **改三态**：`onPermChange` → `setToolPerm(policyRaw,...)` → `writePolicy` → 即时生效
- **改规则**：modal 保存 → `setToolRules` → `writePolicy`
- **审计**：`readMcpAudit` → `parseAuditLines` → 筛选展示
- **并发**：每次写以当前 `policyRaw` 为基（mount 已读最新）+ 原子写，人操作低频，最后写赢

## 10. 即时生效 vs 重启

`MCP_SERVERS`（增删/启停 server）→ env → 重启生效（现状不变）。**权限/规则**写 `~/.pi/mcp-policy.json` → sidecar `tool_call` mtime 重读 → **即时生效**。两条路径分开：权限操作不触发 `needsRestart`，UI 上无「重启生效」提示。

## 11. 代码落点

- 改：`extensions/mcp/index.ts`、`tauri-agent/src/stores/mcpStatusStore.ts`、`tauri-agent/src-tauri/src/lib.rs`、`tauri-agent/src/features/extensions/{ExtensionsPanel,McpServerCard}.tsx`
- 新：`tauri-agent/src-tauri/src/commands/mcp_policy.rs`、`tauri-agent/src/features/extensions/{mcpPolicy.ts,ToolPermissionModal.tsx,AuditModal.tsx}`、前端 `invoke` 封装（落到现有 lib 模块）
- 测试：`mcpPolicy.test.ts`（纯函数）、组件测试（`McpServerCard` 展开 + 改三态、`AuditModal` 筛选）

## 12. 测试策略

- `mcpPolicy.ts` 单测（vitest）：`getToolPerm` 默认 auto、`setToolPerm/Rules` 不可变且保留其他字段、`parseAuditLines` 容错、`shortToolName`。
- 组件测试（vitest + jsdom，mock `readMcpPolicy/writeMcpPolicy/readMcpAudit` + `useMcpStatusStore`）：展开渲染工具行、改 `Segmented` 触发 `writeMcpPolicy`、规则 modal 保存、审计筛选。
- sidecar：`mcp` summary 含 toolNames（轻量断言或手验）。
- Rust：路径解析 + 原子写（可选）。
- 构建：sidecar 构建 + 前端 `tsc` + vitest 全绿；Tauri 端 `cargo check`。

## 13. 风险与取舍

- **工具名仅连接后可见**：未连接 server 无法配工具权限——可接受（先连上再配）。
- **前后端并发写**：读-改-写 + 原子写兜底，人操作低频。
- **审计文件增长**：MVP 前端读全量 parse + 限制显示条数（如最近 500）；后续可改 Rust tail。
- **home 一致性**：Rust 与 sidecar 必须解析到同一 `~/.pi/`；用同源 home。
- **policy 往返保真**：前端操作 raw 对象，不强类型重写，避免丢失 sidecar 未来新增字段。

## 14. 验收标准

1. `mcp` 扩展 summary 推送 `toolNames`，`mcpStatusStore` 收到。
2. Rust `read_mcp_policy/write_mcp_policy/read_mcp_audit` 可用，路径限定 `~/.pi/`。
3. `McpServerCard` 展开显示该 server 工具，每工具 `Segmented` 三态反映 policy。
4. 改三态后 `~/.pi/mcp-policy.json` 即时更新，保留其他工具/字段；sidecar 无需重启即按新策略执行。
5. 「规则」modal 可增删/编辑参数规则（match + policy）并保存。
6. 「审计」入口展示 `mcp-audit.jsonl`，可按 server/工具/decision 筛选。
7. 权限操作不显示「重启生效」。
8. `mcpPolicy.ts` 与组件测试全绿；sidecar 构建、前端 tsc、`cargo check` 通过。
9. 全程无 emoji，图标走 `@lobehub/ui` `Icon` + lucide。
