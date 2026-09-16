# MCP 连接管理器（进程级单例 + 每会话薄绑定）设计

- 日期：2026-06-15
- 状态：设计待审（brainstorming 产出）
- 主题：根除 `mcp` 扩展跨会话复用 `pi`/`ctx` 句柄导致的「extension ctx is stale」守卫错误
- 关联：`extensions/mcp/`、`docs/superpowers/specs/2026-06-15-mcp-permission-panel-design.md`（权限面板依赖 `summary().toolNames`，本设计保持兼容）

## 1. 目标

修复切换/新建会话后 MCP 报「This extension ctx is stale after session replacement or reload」、工具被错误标 `failed`、配置监听泄漏的问题。

成功标准：

- 同一 workspace 下所有会话**共享一套 MCP 连接**，切换/新建/fork/reload 会话**零重连**，新会话**即时**拥有全部已连工具。
- pi 运行时的「ctx 失效」守卫**从结构上不可能再触发**（无任何 `pi`/`ctx` 句柄活过其所属会话）。
- `fs.watch` 配置监听**全进程仅一个**，会话替换不再泄漏监听。
- 连接失败只反映**真实**连接问题，不再把守卫文案当失败。
- 对外可见数据（`setStatus("mcp", ...)` 的 `summary()`，含 `toolNames`）保持兼容，权限面板不受影响。

## 2. 背景与根因

报错原文来自 pi 运行时扩展守卫（`pi/packages/coding-agent/src/core/extensions/loader.ts:154-158` 等三处的 `invalidate()`）。

关键生命周期事实（已核 `pi/packages/coding-agent` 源码 + 回归测试 `2860-replaced-session-context`）：

1. **一个 workspace 一个 pi 进程**（`tauri-agent/src-tauri/src/pi/manager.rs`：「每个工作区复用同一个 pi 进程」）。`agent_new_session` / `agent_switch_session` / `agent_fork` 只是向**同一进程**发 RPC。
2. **每次会话替换都重跑扩展工厂**：`AgentSessionRuntime.newSession/switchSession/fork` 均为「`teardownCurrent()`（发 `session_shutdown` → dispose）→ 重新 `createRuntime()`（重建 services + 重载扩展，用**新鲜 `pi`**）」。扩展模块按 `loader.ts` 的 `moduleCache: false` 每次重载。
3. **替换后旧 `pi` 和旧 `ctx` 都失效**：回归测试断言 `oldPi.sendUserMessage(...)` 与 `oldCtx.sessionManager.*` 都抛守卫错。
4. `session_shutdown` 在「invalidate 之前」触发，故其 handler 内 `ctx` 仍有效，可用于清理。

现状为何炸（`extensions/mcp/index.ts`）：

- 连接逻辑放在 `session_start` 内、被 `started` 闭包标志门控，且闭包随每会话重建 → **每切一次会话就重连一遍所有 MCP**。
- `watchConfig` 订阅在 `session_start` 注册、返回的取消函数被丢弃 → 旧会话订阅闭包仍持旧 `pi`，配置一变就撞守卫；监听逐会话泄漏。
- 旧会话的在途 `connectServer` 完成时 `pi.registerTool` 命中已失效的旧 `pi` → 守卫抛错 → 被 `catch` 后当作「连接失败」并把守卫文案写进日志/状态。

即「workspace 共享、不重连」**当前根本没实现**，是本设计的目标。

## 3. 设计决策（brainstorming 已确认）

| 维度 | 决策 |
|------|------|
| 多会话语义 | workspace 共享一套连接；切换/新建会话即时**重投射**已连工具，**不重连** |
| 连接平面 | 进程级单例（`globalThis`），跨会话存活，**绝不引用 `pi`/`ctx`** |
| 会话平面 | 每会话工厂用各自新鲜 `pi` 做薄绑定：登记/激活 + 订阅 + `session_shutdown` 解绑 |
| 守卫错误 | 由架构消除（无跨会话句柄），而非打补丁 |
| 工具移除 | API 无 `unregisterTool`，靠 `setActiveTools` 取消激活 |
| 配置监听 | 仅一个 `fs.watch`，在 `createManager()` 内一次性建立 |
| 对外兼容 | `setStatus("mcp", ...)` 的 `summary()` 形状不变（含 `toolNames`） |
| 不改动 | `config.ts` / `diff.ts` / `toolsCache.ts` / `probe.ts` / Rust 侧 / 权限策略 |

## 4. 架构：两平面

```
进程级（globalThis，跨会话）                 会话级（每会话重建，持新鲜 pi/ctx）
McpManager (extensions/mcp/manager.ts)        extensions/mcp/index.ts 默认导出
  - clients: Map<name, Client>                  pi.on("session_start", (e, ctx) => {
  - catalog: Map<name, ServerEntry>               mgr = getMcpManager(); mgr.init();
  - 一个 fs.watch（watchConfig 一次）              project(mgr.snapshot());           // 登记+激活
  - connect / disconnect / diff 热更新            unsub = mgr.subscribe(project);    // 变化重投射
  - callTool(server, tool, args)                  renderStatus(ctx);                 // ctx.ui.setStatus
  - subscribe(listener): () => void             });
  - 不引用 pi / ctx                              pi.on("session_shutdown", () => unsub());
        │  发「快照变化」事件                          ▲ execute() 调 mgr.callTool（不碰 pi/ctx）
        └───────────────────────────────────────────┘
```

「活过会话」的只有 `McpManager`，而它不碰会话句柄；唯一碰 `pi`/`ctx` 的会话绑定随会话生灭并在 `session_shutdown` 解绑 → 守卫错误不可能再出现。

## 5. 连接管理器（新 `extensions/mcp/manager.ts`）

```ts
type McpStatus = "connecting" | "connected" | "failed";
interface McpToolDef { name: string; description?: string; inputSchema?: unknown } // 原始工具（未加前缀）
interface ServerEntry { status: McpStatus; error?: string; tools: McpToolDef[] }
interface McpSnapshot { servers: Map<string, ServerEntry> }            // 不可变快照

interface McpManager {
  init(): void;                                                        // 幂等：首连 + 建 fs.watch（仅首次实际执行）
  snapshot(): McpSnapshot;                                             // 当前各 server 状态 + 工具定义
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<{ text: string }>;
  subscribe(listener: (snap: McpSnapshot) => void): () => void;        // 快照变化时回调；返回取消函数
  closeAll(): void;                                                    // 关闭全部 client（进程退出）
}

export function getMcpManager(): McpManager {
  const g = globalThis as { __grenMcpManager?: McpManager };
  return (g.__grenMcpManager ??= createManager());                     // ??= 保证全进程仅一份
}
```

`createManager()` 行为：

- `init()`：内部 `started` 守卫；首次：`void Promise.all(readServers().map(connectServer))` 启动连接；调用一次 `watchConfig(onConfigChange)`（因 `??=` 仅首个模块实例的闭包被保留，后续会话重载的 `runtime-config` 实例无人 `ensureStarted`，不产生额外 watcher）。
- `connectServer(s)`：`connect()`（由 index 迁入）→ `listTools()` → 写 `catalog[s.name] = { status: "connected", tools }` → `writeToolsCacheEntry(...)` → `emit()`。失败：`{ status: "failed", error }` + 缓存 + `emit()`。
- `onConfigChange()`：`diffServers(current, desired)` → 断开 `removed + changed`、连接 `added + changed`；每步后 `emit()`。
- `callTool(server, tool, args)`：用 `clients.get(server)` 调 `client.callTool`，抽取 text；client 始终在管理器手里。
- `emit()`：同步遍历 listeners，逐个 `try/catch` 隔离（仿 `runtime-config`）。
- 进程退出：`createManager()` 内注册一次 `process.on("exit"|"SIGTERM"|"SIGINT", closeAll)`。
- `readServers()`：复用 `injectDefaultServers(parseMcpServers(getConfig("MCP_SERVERS") ?? ""), getAllConfig(), process.platform)`。

`connect()` / `withTimeout()` / `MCP_TIMEOUT_MS` 从 `index.ts` 迁入 `manager.ts`。

## 6. 每会话薄绑定（`extensions/mcp/index.ts` 瘦身）

```ts
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_e, ctx) => {
    const mgr = getMcpManager();
    mgr.init();
    let alive = true;                                   // 防 shutdown 竞态
    const render = (snap: McpSnapshot) => {
      if (!alive) return;
      project(pi, snap);                                // 登记 + 激活 + 停用已移除
      if (ctx.hasUI) try { ctx.ui.setStatus("mcp", JSON.stringify(summary(snap))); } catch {}
    };
    render(mgr.snapshot());                             // 立即投射当前目录（已连则瞬时）
    const unsub = mgr.subscribe(render);                // 后续变化重投射
    pi.on("session_shutdown", () => { alive = false; unsub(); });
  });
}
```

- `project(pi, snap)`：对每个 `connected` server 的工具 → 全名 `mcp__${sanitize(server)}__${sanitize(tool)}` → `pi.registerTool({ ..., async execute(_id, params) { return mgr.callTool(server, tool, params) } })`；登记后 `pi.setActiveTools(union(getActiveTools(), 已连全名) − 未连全名)`。`registerTool` 同会话内重复调用是覆盖 Map，幂等。
- `summary(snap)`：产出 `[{ name, status, tools, toolNames }]`，与现状 `summary()` 形状一致（权限面板兼容）。
- 所有会话级调用（`registerTool`/`setActiveTools`/`ctx.ui.setStatus`）外裹 `try/catch` 兜底；正常路径下 `session_shutdown` 已解绑、`alive=false`，事件不会在失效后到达。

## 7. 数据流

- **首个会话 `session_start`**：`getMcpManager().init()` 触发首连；`render(snapshot())` 此刻可能为空；`subscribe`。server 陆续连上 → `emit` → 用**本会话 `pi`** 补登记。
- **切换/新建/fork/reload**：旧会话 `session_shutdown` → `unsub()`；管理器与连接**原样存活**；新会话 `session_start` 从 `snapshot()` 拿到**已就绪**目录 → **瞬时登记、零重连**。
- **配置变更**：客户端写 runtime config → 管理器（唯一订阅者）`diffServers` → 连新/断旧 → `emit` → 仅**当前**会话 `render`。
- **工具调用**：本会话工具 `execute` → `mgr.callTool(server, tool, args)`（不碰 `pi`/`ctx`）。
- **mid-session 移除某 server**：快照里它变为非 `connected`/消失 → `project` 经 `setActiveTools` 停用其工具。

## 8. 错误处理

- **守卫错误**：架构上不可能（无跨会话句柄）。
- **连接失败**：`catalog` 记 `failed` + `error` + 写 tools-cache；经 `emit` 反映到当前会话状态；不再有守卫文案混入。
- **监听泄漏**：消除——`fs.watch` 仅一个；会话订阅在 `session_shutdown` 必解绑，并以 `alive` 兜底竞态。
- **listener 异常隔离**：`emit` 内逐个 `try/catch`。
- **进程退出**：`closeAll()` 关闭全部 client，迁自 index 的 `exit/SIGTERM/SIGINT`。

## 9. 代码落点

- 新：`extensions/mcp/manager.ts`（管理器 + `getMcpManager`，迁入 `connect`/`withTimeout`/超时常量）。
- 改：`extensions/mcp/index.ts`（瘦身为每会话薄绑定 + `project` + `summary`）。
- 复用不改：`extensions/mcp/{config,diff,toolsCache,probe}.ts`、`_shared/runtime-config.ts`、Rust 侧、权限策略。
- 测试：新 `extensions/mcp/manager.test.ts`；扩展/调整 `extensions/mcp/*.test.ts`。

## 10. 测试策略

- **管理器单元**（注入假 `connect`，不起真进程）：首连/`diff` 重连/断开；`catalog` 与 `emit` 行为；`init()` 幂等且只建一个 watch；`callTool` 路由到对应 client；listener 异常隔离；`closeAll`。
- **绑定单元**（假 `pi`/`ctx` + 假 manager）：`session_start` 用当前快照登记+激活；收到 `emit` 重投射；`session_shutdown` 后**对 `pi` 零调用**（含晚到事件被 `alive` 拦截）；`summary` 形状含 `toolNames`。
- **回归（守卫场景）**：模拟会话替换——会话 1 绑定 → `session_shutdown` 解绑 → 切到会话 2（新 `pi`）→ 管理器 `emit` 仅命中会话 2 绑定，旧 `pi` 零调用。
- **构建**：sidecar 构建 + 相关 vitest 全绿。

## 11. 风险与取舍

- **globalThis 单例**：这是本框架下「跨会话共享」的既定手段；键名 `__grenMcpManager` 加前缀避免冲突。
- **runtime-config 每会话重载**：定为复用 `runtime-config.watchConfig`，在 `createManager()` 内一次性调用（因 `??=`，仅首个模块实例的闭包被保留）。后续会话重载产生的 `runtime-config` 实例无人 `ensureStarted`（绑定层不读配置，只有管理器读），故不新增 watcher、不泄漏。不采用「管理器自读 `PI_RUNTIME_CONFIG` 自建 watch」的替代方案，以复用既有已测模块。
- **工具名仅连接后可见**：与现状一致，连上后投射。
- **首会话冷启动窗口**：首连未完成时工具暂缺，连上即经 `emit` 补齐；符合预期。
- **`registerTool` 无对应注销**：跨会话靠「新会话只登记已连项」自然收敛；mid-session 移除靠停用。

## 12. 验收标准

1. 切换/新建/fork/reload 会话后，MCP 工具在新会话**立即可用**且**无重连**（无重复 spawn）。
2. 全程不再出现「extension ctx is stale ...」守卫错误。
3. 全进程 MCP 配置 `fs.watch` 仅一个；会话替换不增加监听。
4. 连接失败状态仅来自真实连接错误。
5. `setStatus("mcp", ...)` 的 `summary` 含 `toolNames`，权限面板照常工作。
6. `manager.test.ts` 与绑定/回归测试全绿；sidecar 构建通过。
7. 全程无 emoji。
