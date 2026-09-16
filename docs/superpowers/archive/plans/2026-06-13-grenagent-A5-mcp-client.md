# A5 MCP 客户端实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 让 GrenAgent/Pi 作为 MCP 客户端连接外部 MCP servers（stdio + SSE），把它们的工具动态注册为 `mcp__<server>__<tool>` 暴露给 agent；设置面板配置 `mcpServers`，连接面板展示 server 列表。

**父 spec：** `docs/superpowers/specs/2026-06-13-grenagent-subproject-a-extensions-safety-design.md`（§4.8 模块 5：MCP 客户端）

---

## 实施状态（2026-06-13）

A5 全部 6 任务完成，逐任务提交：

- ✅ 任务 1 config 纯函数 + 单测（5/5）
- ✅ 任务 2 MCP client（async factory：连接 stdio/SSE + `registerTool` 转发 `callTool`）
- ✅ 任务 3 注册 + `@modelcontextprotocol/sdk` 依赖 + 重建（4999 modules）
- ✅ 任务 4 settings `MCP_SERVERS`（独立「MCP 服务器」分类）
- ✅ 任务 5 ConnectionsPanel MCP 区（配置推导；测试 3/3 + 前端 tsc 0）
- ✅ 任务 6 端到端：**stdio 实测连上 `server-filesystem`，14 tools 注册为 `mcp__fs__*`，agent 识别并列出**，进程 12s 正常退出

**技术 gate 全通过**（用户最关心）：`@modelcontextprotocol/sdk` 能被 `bun --compile` 打包；stdio 子进程在编译二进制内 spawn 成功。
**实现中修的 bug**：连接超时未清理 transport → stdio 子进程泄漏 / 进程不退出 → 已加 `client.close()` 清理。
**待用户 app 内**：ConnectionsPanel MCP 区渲染 + 配置真实 server 在 GUI 调用。
**后续修复（用户 GUI 反馈）**：① 配置改标准 `mcpServers` 包裹格式（兼容 `.cursor/mcp.json` / Claude Desktop；仍兼容裸 map）；② **实时连接状态**：mcp extension 经 `setStatus("mcp", JSON)` 推送 → `mcpStatusStore` → ConnectionsPanel 每个 server 显示 ● 已连/工具数 / ○ 失败 / 待连接。
**YAGNI 未做**：OAuth、StreamableHTTP、per-session 生命周期。

> 下方为原始计划步骤（复选框保留为原始拆解；实际完成情况以本节为准）。

---

## 关键发现（实现前排查）

1. **pi 0.78 无内置 MCP**（`dist/*.d.ts` 无 `mcp` 匹配）→ 需自研 client，符合 spec。
2. **`ExtensionFactory = (pi) => void | Promise<void>`（async 可行）** → 可在 factory 内 `await` 连接所有 MCP server、`listTools` 后 `pi.registerTool(...)`，pi 等 factory 完成再启动 agent。**不依赖运行时动态注册**（确定性强）。
3. **opencode 参考**（`MiMo-Code/packages/opencode/src/mcp/index.ts`，Effect 重实现，精简借鉴）：
   - `import { Client } from "@modelcontextprotocol/sdk/client/index.js"`；`StdioClientTransport`（`{command,args,env,cwd}`）/ `SSEClientTransport`（`new URL(url)`）。
   - `new Client({name,version})` → `client.connect(transport)` → `client.listTools()` → `{ tools:[{name,description,inputSchema}] }`。
   - 转发：`client.callTool({ name, arguments }, CallToolResultSchema, { timeout })`。
   - 命名：`sanitize(server)_sanitize(tool)`；清理：`client.close()`。
4. **settings → sidecar env 是通用机制**：A4 的 `TAVILY_API_KEY` 未改 Rust 即在 sidecar `process.env` 生效。→ `MCP_SERVERS`（JSON 字符串）加 settings 字段即自动注入 sidecar，无需 Rust 改动。
5. **`ConnectionsPanel` 是「配置推导」展示**（读 `useSettingsForm` 值，im-gateway 状态也非 sidecar 实时）→ A5 前端 MVP 同模式：解析 `MCP_SERVERS` 配置列出 servers + transport；实时「已连/失败/工具数」留增强（需 sidecar→前端 RPC 状态通道，本期不做）。
6. **registerTool 参数是 typebox `TSchema`，MCP 返回 JSON Schema**：typebox schema 本质即 JSON Schema 对象，运行时兼容；用 `Type.Unsafe(mcpTool.inputSchema)` 或 `as unknown as TSchema` 适配。

---

## 方案与权衡（MVP）

- **连接生命周期 = sidecar 进程**（非 per-session）：桌面 sidecar 常驻服务一个 workspace，factory 启动时连一次、进程退出 `close`。比 spec「随 session」更简单且契合桌面常驻模型。
- **传输**：stdio（本地 server，spawn command）+ SSE（远程 URL）。**不做** StreamableHTTP / OAuth（YAGNI，spec 未要求）。
- **容错 + 超时**：单 server 连接失败/超时 → 标记失败、跳过，不阻塞其他 server 与 agent 启动（每连接独立 try + 超时）。
- **配置**：`MCP_SERVERS` = JSON 字符串，形如 `{ "name": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","."], "env": {...} } }` 或 `{ "name": { "url": "https://..." } }`。有 `url` → SSE；有 `command` → stdio。
- **前端 MVP**：ConnectionsPanel 加「MCP Servers」区，从配置解析列出（name + transport + command/url 摘要）+ 设置面板编辑 `MCP_SERVERS` JSON。

### ⚠️ 主要技术风险（需任务 3 重建时验证）

- **`@modelcontextprotocol/sdk` 能否被 `bun build --compile` 打包**，且 **`StdioClientTransport` 在编译后的单文件二进制内能 spawn 子进程**。A3 已证明 sidecar 自身可 spawn（`process.execPath`），`node:child_process` 在 bun-compiled 下可用；但 MCP sdk 的 stdio transport 走 cross-spawn，需实测。若 stdio 不可用，退化为「仅 SSE」并提示。

---

## 文件结构

- 创建 `extensions/mcp/package.json` — `pi-mcp`，依赖 `@modelcontextprotocol/sdk`
- 创建 `extensions/mcp/config.ts` — 纯函数：`parseMcpServers(json)`、`sanitize`、类型 `McpServerConfig`
- 创建 `extensions/mcp/config.test.ts` — 纯函数单测
- 创建 `extensions/mcp/index.ts` — async factory：连接 + `listTools` + `registerTool` 转发 + 退出清理
- 修改 `extensions/index.ts` — 注册 `mcp` 到 `allExtensions`
- 修改 `tauri-agent/src/features/settings/settingsSchema.ts` — 加 `MCP_SERVERS`（text，JSON）
- 修改 `tauri-agent/src/features/connections/ConnectionsPanel.tsx`（+ test）— MCP servers 区（配置推导）
- npm install sdk + 重建 sidecar + 端到端冒烟

---

## 任务 1：config 纯函数 + 单测

**文件：** `extensions/mcp/package.json`、`extensions/mcp/config.ts`、`extensions/mcp/config.test.ts`

- [ ] **步骤 1：package.json** — `pi-mcp`，`dependencies: { "@modelcontextprotocol/sdk": "^1.x" }`，peer `typebox`
- [ ] **步骤 2：写失败测试** `config.test.ts`：
  - `parseMcpServers('{"fs":{"command":"npx","args":["-y","x"]}}')` → `[{ name:"fs", transport:"stdio", command:"npx", args:["-y","x"], env:{} }]`
  - `parseMcpServers('{"api":{"url":"https://m"}}')` → `[{ name:"api", transport:"sse", url:"https://m" }]`
  - `parseMcpServers("")` / 非法 JSON → `[]`（容错）
  - `sanitize("we!rd name")` → `we_rd_name`
- [ ] **步骤 3：运行确认失败**
- [ ] **步骤 4：实现** `config.ts`（`unknown` + 守卫解析；`url`→sse / `command`→stdio）
- [ ] **步骤 5：运行确认通过**
- [ ] **步骤 6：Commit** — `feat(mcp): parse mcpServers config pure functions (A5)`

---

## 任务 2：MCP client + extension 入口（async factory）

**文件：** `extensions/mcp/index.ts`

- [ ] **步骤 1：实现** async factory：

```ts
export default async function (pi: ExtensionAPI) {
  const servers = parseMcpServers(process.env.MCP_SERVERS ?? "");
  for (const s of servers) {
    try {
      const client = new Client({ name: "grenagent", version: "0.1.0" });
      const transport = s.transport === "sse"
        ? new SSEClientTransport(new URL(s.url))
        : new StdioClientTransport({ command: s.command, args: s.args, env: { ...process.env, ...s.env } });
      await withTimeout(client.connect(transport), MCP_TIMEOUT_MS);
      const { tools } = await client.listTools();
      for (const t of tools) {
        pi.registerTool({
          name: `mcp__${sanitize(s.name)}__${sanitize(t.name)}`,
          label: `${s.name}: ${t.name}`,
          description: t.description ?? `MCP tool ${t.name} from ${s.name}`,
          parameters: Type.Unsafe(t.inputSchema),   // JSON Schema ≈ typebox
          async execute(_id, params) {
            const r = await client.callTool({ name: t.name, arguments: params ?? {} });
            return { content: r.content, details: { server: s.name, tool: t.name } };
          },
        });
      }
      registry.set(s.name, { client, status: "connected", toolCount: tools.length });
    } catch (e) {
      registry.set(s.name, { status: "failed", error: String(e) });
    }
  }
  // 进程退出清理
  const cleanup = () => { for (const e of registry.values()) e.client?.close().catch(() => {}); };
  process.on("exit", cleanup); process.on("SIGTERM", cleanup); process.on("SIGINT", cleanup);
}
```

> 细节：`callTool` 结果 `content` 已是 `[{type,text|...}]`，可直接作为工具结果 content（必要时映射）。`Type.Unsafe` 来自 typebox。`MCP_TIMEOUT_MS` 默认 15000。
- [ ] **步骤 2：Commit** — `feat(mcp): connect MCP servers and register their tools (A5)`

---

## 任务 3：注册 + 装依赖 + 重建（验证 bundle/stdio）

- [ ] **步骤 1：注册** `mcp` 到 `extensions/index.ts`（import/export/allExtensions，置于 webSearch 之后）
- [ ] **步骤 2：装依赖** — `cd extensions && npm install`（拉 `@modelcontextprotocol/sdk`）
- [ ] **步骤 3：重建** — `cd tauri-agent && node scripts/build-sidecar.mjs`。**重点验证**：bun 无 `Could not resolve @modelcontextprotocol/sdk`；产物体积合理。
- [ ] **步骤 4：stdio spawn 冒烟** — 设 `MCP_SERVERS={"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}}`，跑 `<sidecar> --mode json -p --no-session "list mcp tools you have"`，确认 `mcp__fs__*` 工具被注册（JSONL 中出现）。若 stdio 失败 → 记录、计划退化为仅 SSE。
- [ ] **步骤 5：Commit** — `feat(mcp): register mcp extension into sidecar bundle (A5)`

---

## 任务 4：settings 加 MCP_SERVERS

**文件：** `tauri-agent/src/features/settings/settingsSchema.ts`

- [ ] **步骤 1**：新增分类或在现有加 `{ key: 'MCP_SERVERS', label: 'MCP Servers（JSON）', type: 'text', placeholder: '{"name":{"command":"npx","args":[...]}}' }`（建议单列「MCP」分类或并入连接）
- [ ] **步骤 2**：前端 `tsc --noEmit` 0
- [ ] **步骤 3：Commit** — `feat(settings): MCP_SERVERS config field (A5)`

---

## 任务 5：前端 ConnectionsPanel MCP 区（配置推导）

**文件：** `tauri-agent/src/features/connections/ConnectionsPanel.tsx`（+ test）

- [ ] **步骤 1：写失败测试** — 给定 `MCP_SERVERS` JSON，面板渲染 server 名 + transport
- [ ] **步骤 2：实现** — 解析 `values.MCP_SERVERS`（容错），列出 servers（name + stdio/sse + command/url 摘要）；加 `MCP_SERVERS` 编辑输入（复用 `SettingFieldInput`）
- [ ] **步骤 3：测试通过 + 前端 tsc 0**
- [ ] **步骤 4：Commit** — `feat(mcp): MCP servers section in connections panel (A5)`

---

## 任务 6：端到端冒烟

- [ ] **步骤 1**：配一个真实 MCP server（如 `@modelcontextprotocol/server-filesystem` 或 `server-everything`），在 app 内确认 `mcp__*` 工具可被 agent 调用、ConnectionsPanel 列出 server。
- [ ] **步骤 2**：失败/无配置路径优雅降级（无 `MCP_SERVERS` → 不注册、不报错）。

---

## 自检

**规格覆盖度（对照 spec §4.8）：**
- 读 `mcpServers` 配置 → 任务 1/4（`MCP_SERVERS` JSON）✅
- `@modelcontextprotocol/sdk` 连接（stdio/SSE）→ 任务 2 ✅
- `listTools` 后动态 `registerTool` 为 `mcp__<server>__<tool>` + 转发 → 任务 2 ✅
- 连接生命周期 → sidecar 进程（任务 2 cleanup）✅（调整自「随 session」）
- ConnectionsPanel MCP 状态 → 任务 5（配置推导）◐；实时「已连/工具数」= 增强（需 RPC 状态通道）
- 设置编辑 `mcpServers` JSON → 任务 4/5 ✅

**风险（复述）：** `@modelcontextprotocol/sdk` 的 bun-compile 打包 + stdio 子进程 spawn 必须在任务 3 重建/冒烟时验证；不通则退化为仅 SSE 传输。

**YAGNI 取舍：** 不做 OAuth、StreamableHTTP、per-session 生命周期、sidecar→前端实时状态通道（均留增强）。
