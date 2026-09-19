# MCP 列表按钮改为实时重载

- 日期：2026-09-19
- 状态：已审查（2026-09-19）
- 主题：扩展面板 MCP 卡片上的刷新按钮不再做一次性探测，改为强制重连该条实时 MCP，使 agent 立刻用上新工具列表。
- 相关：`extensions/mcp/manager.ts`（进程级连接管理）、`electron-agent/electron/app/mcpConfigService.ts`（配置热更新）

## 1. 背景

MCP 卡片右侧的 `RefreshCw` 按钮当前 title 为「测试连接」，点击走 `probe_mcp_server`：另起一条临时连接、`listTools`、写入 tools cache、然后断开。

这条路径**不**触碰 `createManager` 里的实时 client。已连接的 server（例如显示「81 工具」）点下去只会再起一个探测进程，agent 侧工具集不变。`reconcile()` 又只在配置 diff 时才断连重连，所以同配置下点刷新什么都不会重连。

图标语义是刷新，用户预期是重载这条连接。

## 2. 目标 / 非目标

**目标**

1. 卡片刷新按钮对**这一条**已启用 MCP 做强制重连：关掉旧 client，按当前配置再连，写 tools cache，经现有 `mcp.state.publish` 把状态推到 UI。
2. 重连过程中卡片保持在列表里，状态为「连接中…」，不出现「条目消失再出现」。
3. 按钮文案与页头/空列表提示从「测试连接」改为「重载」。
4. 未启用条目不可点重载。

**非目标**

- 不删除 `probe_mcp_server`、`probeServer`、首次无缓存时的自动探测。
- 不改配置增删改后的 `hotReload` / `reconcile()` 语义（仍只在 diff 时重连）。
- 不做「重载全部 MCP」按钮。
- 不改权限策略、审计、添加/编辑/删除 MCP。
- 不改 CLI `pi probe-mcp`。

## 3. 已确认的设计决定

| 维度 | 决定 |
| --- | --- |
| 产品选择 | 强制重连实时连接，不是改文案继续探测 |
| 实现 | Manager 增加按名 `reloadServer`，经 MCP 配置 IPC 暴露 |
| 配置未变 | 仍重连（这是与 `reconcile()` 的差别） |
| 未启用 | 按钮 `disabled`，不发 IPC |
| Manager 未 init | 先 `init()`（连接该 workspace 全部已启用 server），不再对目标做第二次 connect |
| 探测 | 按钮不再调用 `probeOne`；自动探测保留 |
| 超时 | 沿用 `MCP_TIMEOUT_MS`，不新开探测超时 |

## 4. 架构

```text
McpServerCard 刷新按钮
        │
        ├─ !enabled ──► disabled，不调用
        │
        └─ enabled
                │
                ▼
        pi.reloadMcpServer(workspace, name)
                │
                ▼
        IPC reload_mcp_server
                │
                ▼
        McpConfigService.reload(workspace, name)
                │
                ▼
        get-or-create manager(workspace)
                │
                ├─ 未 init ──► init()（连接全部已启用）后返回
                │
                └─ 已 init
                        │
                        ▼
                reloadServer(name)
                        │
                        ├─ readServers() 无此名 ──► throw
                        │
                        └─ 关旧 client（catalog 保留）
                           标 connecting 并立刻 emit
                           connectServer(config)
                                │
                                ▼
                           bind() 订阅者 mcp.state.publish
                                │
                                ▼
                           mcpStatusStore → 卡片「连接中… / N 工具 / 连接失败」
```

三个单元：

1. **`McpManager.reloadServer(name)`**：强制重连一条。`reconcile()` 继续只处理 diff。
2. **`McpConfigService.reload` + IPC**：桌面入口，按 workspace 找到 manager。
3. **扩展面板按钮**：从 `onProbe` / `probeOne` 改为 `reloadMcpServer`；文案改为「重载」。

## 5. 组件与 API

### 5.1 Manager

`extensions/mcp/manager.ts` 的 `McpManager` 增加：

```ts
reloadServer(name: string): Promise<void>
```

行为：

1. `reloadServer` **一律等到目标 server 进入 `connected` 或 `failed` 再 resolve**。IPC 与按钮转圈都等这条 Promise。
2. 未 `init`：调用 `init()`。`init()` 必须把各 server 的连接 Promise 留下来（现在是 `void Promise.all`，要改成可 await）。目标若在 `readServers()` 中，只 await 那一条，**不要**再 `connectServer` 一次，避免双连。目标不在列表中则 `throw`。
3. 已 `init`：在当前 `readServers()` 里找 `name`。找不到（未配置或未启用）则 `throw`，文案包含 server 名。
4. 找到则 `forceReconnect(config)`：
   - 若有旧 client：`close()`，从 `clients` 删除，**不**从 `catalog` 删除。
   - `catalog.set(name, { status: "connecting", tools: [] })`，立刻 `emit()`。
   - 再 `await connectServer(config)`（连上、`listTools`、写 cache、最终 `emit`）。
5. `connectServer` 开头设置 `connecting` 之后也立刻 `emit()`，让 `init()` 的并行连接同样能显示「连接中…」。这是小幅修正，不改变成功/失败终态。

没有会话时 `bind()` 尚未 `subscribe`，`emit` 不会走到 `mcp.state.publish`。这与现有 `upsert` → `hotReload` 相同，不另开一条桌面推送。按钮仍靠 await + `probing` 转圈；有会话后状态走现有订阅。

`getMcpManager()` 继续按 workspace 分键。桌面侧重载必须针对**指定 workspace**，不能只调无参 `getMcpManager()`（那会落到当前 ALS / cwd）。

新增（或扩展现有）按 workspace 取 manager 的入口，例如：

```ts
getMcpManagerFor(workspace: string): McpManager
```

不存在则 `createManager({ workspace })` 并放入 `managers`。`getMcpManager()` 改为委托给它，行为与现在一致。

导出：

```ts
export async function reloadMcpServer(workspace: string, name: string): Promise<void>
```

内部：`getMcpManagerFor(workspace)`，然后 `await mgr.reloadServer(name)`。

### 5.2 桌面服务与 IPC

`McpConfigService` 增加：

```ts
async reload(workspace: string, name: string): Promise<void>
```

只转发 `reloadMcpServer(workspace, name)`，不改配置文件，不走 `hotReload`。

`registerMcpConfigCommands` 增加：

```ts
registerCommand('reload_mcp_server', (_event, args) =>
  service.reload(readString(args, 'workspace'), readString(args, 'name')))
```

`electron-agent/src/lib/pi.ts`：

```ts
reloadMcpServer: (workspace: string, name: string) =>
  invoke<void>('reload_mcp_server', { workspace, name })
```

### 5.3 卡片与面板

`McpServerCard`：

| 项 | 新值 |
| --- | --- |
| 按钮 `title` | `重载` |
| 空工具提示 | `点右侧「重载」刷新连接与工具列表` |
| `data-testid` | 改为 `mcp-reload-${name}` |
| `onProbe` | 重命名为 `onReload` |
| `disabled` | `!enabled` 或重载进行中（`probing` 或 `runtimeStatus === 'connecting'`） |

`probing` prop 可保留作 loading 旗标，语义变为「正在重载」，不必改名（避免无关重命名）。旋转动画沿用。

`ExtensionsPanel`：

- 页头说明改为：连接外部 MCP server，工具以 `mcp__server__tool` 暴露给 agent。点「重载」重新连接并刷新工具（即时生效）。
- `onReload` 调用 `pi.reloadMcpServer(workspace, entry.name)`。用现有 `probing` set 包住 await，finally 里清掉。
- 不再为按钮调用 `probeOne`。
- 首次无缓存的自动探测循环保持不变。

失败时：若 IPC throw，把错误写入面板已有的 `mcpError`；manager 连接失败仍走 catalog `failed` + tools cache，卡片显示「连接失败」。

## 6. 数据流

| 事件 | catalog | 实时 client | tools cache | UI |
| --- | --- | --- | --- | --- |
| 点重载（已连接） | 立刻 `connecting`，条目仍在 | 关旧、开新 | 成功后覆盖 | 「连接中…」→「N 工具」 |
| 点重载（已失败） | `connecting` | 新连 | 成功覆盖 / 失败写 error | 「连接中…」→ 成功或「连接失败」 |
| 点重载（未启用） | 不变 | 不变 | 不变 | 按钮 disabled |
| 配置 upsert/remove | 现有 `hotReload` + `reconcile()` | 仅 diff 项 | 现有 | 不变 |
| 首次无缓存 | 不经 reload | 不经 reload | 现有 probe | 现有「探测中…」 |

## 7. 错误处理

| 情况 | 行为 |
| --- | --- |
| 名称不在当前已启用列表 | `reloadServer` throw；面板 `mcpError` 显示错误（正常 UI 因 disabled 不会走到） |
| 连接失败 / 超时 | `connectServer` 现有路径：catalog `failed`，cache `ok: false`，卡片红字 |
| Manager 不存在 | `getMcpManagerFor` 创建后按 §5.1 处理 |
| 并发连点同一条 | 按钮在 connecting/probing 时 disabled；若仍重入，后一次 `forceReconnect` 关掉前一次 client 再连，不排队 |

不新增 toast。列表状态已经足够。

## 8. 测试

**Manager（`extensions/mcp/manager.test.ts`）**

- 已连接的 server：`reloadServer` 调用旧 client `close`，再 `connect` 一次；中间 snapshot 仍含该 name 且 status 为 `connecting`。
- 配置未变也会重连（`connect` 次数 +1）。
- 未启用 / 不存在的 name：reject。
- 未 init：`reloadServer` 触发 `init`，对已启用目标 `connect` 恰好一次，且在目标进入终态后才 resolve。

**服务（`mcpConfigService.test.ts`）**

- `reload` 调用按 workspace + name 转发，不写配置文件。

**UI**

- `McpServerCard`：title「重载」；`mcp-reload-*` 可点；`enabled=false` 时按钮 disabled。
- `ExtensionsPanel`：点击走 `reloadMcpServer`，不走 `probeMcpServer`。

## 9. 范围

一份实现计划即可覆盖：manager API、一条 IPC、卡片/面板文案与接线、对应测试。不拆子项目。
