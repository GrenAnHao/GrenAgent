# Electron 自研 Agent 模块替换 TencentDB 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Electron 版中完全移除 TencentDB，并交付 TypeScript Data Runtime、CodeGraph MCP 内置扩展、LLM Wiki RAG、Pi 当前模型驱动的 L0-L3 Memory，以及管理面板 IPC/API。

**架构：** Electron 主进程托管一个本地 TypeScript Data Runtime，Runtime 独占 Memory/Wiki 数据库和文件。Pi 扩展通过 JSON-RPC 访问存储；记忆和 Wiki 的 LLM 工作留在 Pi 扩展中并复用 `ctx.model`。CodeGraph 扩展作为 MCP client 调用 Rust CodeGraph 服务，Renderer 只通过 Electron IPC 访问查询和管理接口。

**技术栈：** TypeScript、Electron IPC、Node `node:sqlite`/现有 SQLite shim、JSON-RPC stdio、Model Context Protocol、Pi `completeSimple`、Vitest、CodeGraph MCP。

---

## 文件与职责总览

### 新建

- `electron-agent/electron/agentData/protocol.ts`：Runtime RPC 方法、请求/响应、错误和管理面类型。
- `electron-agent/electron/agentData/runtime.ts`：Runtime 子进程入口、鉴权、方法分发和优雅退出。
- `electron-agent/electron/agentData/client.ts`：Electron 主进程和 Pi 扩展使用的 RPC 客户端。
- `electron-agent/electron/agentData/storage.ts`：SQLite 打开、迁移版本、事务和原子 Markdown 文件操作。
- `electron-agent/electron/agentData/memoryStore.ts`：L0-L3 schema、读写、搜索和引用链。
- `electron-agent/electron/agentData/wikiStore.ts`：文档块、Wiki 页面、FTS5/BM25 索引和来源引用。
- `electron-agent/electron/agentData/jobStore.ts`：索引/同步/抽取任务状态、取消和审计事件。
- `electron-agent/electron/app/agentDataService.ts`：主进程 Runtime 生命周期和管理 API 门面。
- `extensions/memory/index.ts`、`client.ts`、`store.ts`、`context.ts`、`llm.ts` 及对应测试：自研 Memory 扩展。
- `extensions/wiki-rag/index.ts`、`client.ts`、`chunker.ts`、`llm.ts` 及对应测试：自研 Wiki RAG 扩展。
- `extensions/code-retrieval/index.ts`、`mcpClient.ts`、`tools.ts` 及对应测试：CodeGraph MCP adapter 和 Pi 工具。
- `electron-agent/src/lib/agentData.ts`：Renderer 类型化查询/管理 API。
- `electron-agent/src/features/agentData/AgentDataCenter.tsx`、`CodeRetrievalPanel.tsx`、`WikiPanel.tsx`、`MemoryPanel.tsx`：新的管理面板。

### 修改

- `electron-agent/electron/main.ts`、`electron-agent/electron/ipc/register.ts`、`electron-agent/electron/ipc/contracts.ts`：启动 Runtime、注册 IPC 和事件。
- `extensions/index.ts`、`extensions/package.json`、`extensions/package-lock.json`：注册新扩展并删除 TencentDB SDK。
- `cli/src/runtime.ts`、`cli/src/extension-profile.ts`、`cli/src/tencentdb-skills.ts`：去除 TencentDB 环境注入和 Skill 同步入口。
- `electron-agent/package.json`、`electron-agent/package-lock.json`、`electron-agent/electron-builder.yml`、`electron-agent/scripts/build-tencentdb-memory.mjs`：删除旧运行时依赖与打包资源。
- `electron-agent/src/features/settings/SettingsPanel.tsx`、`settingsSchema.ts`：移除 TencentDB 设置，接入 Agent Data 管理入口。
- `electron-agent/src/features/chat/input/workspace/ProjectContextPanel.tsx`、`ProjectContextTabs.tsx`、`WorkspaceBar.tsx`：切换新 CodeGraph/Wiki API。
- `tauri-agent/src-tauri/src/tencentdb/*`、`tauri-agent/src-tauri/src/commands/tencentdb.rs`、`tauri-agent/src/features/tencentdb/*`、`tauri-agent/src/lib/tencentdb.ts`：删除旧 Tauri TencentDB 生产代码；历史 Tauri CodeGraph 文件只作为参考恢复。

---

### 任务 1：清理 TencentDB 生产代码与依赖

**文件：**
- 删除：`electron-agent/electron/tencentdb/`、`electron-agent/scripts/build-tencentdb-memory.mjs`
- 修改：`electron-agent/electron/main.ts`、`electron-agent/electron/ipc/register.ts`、`electron-agent/electron/ipc/contracts.ts`
- 修改：`electron-agent/package.json`、`electron-agent/package-lock.json`、`electron-agent/electron-builder.yml`
- 修改：`extensions/index.ts`、`extensions/package.json`、`extensions/package-lock.json`
- 删除：`extensions/tencentdb-memory/`
- 修改：`cli/src/runtime.ts`、`cli/src/tencentdb-skills.ts`、`cli/src/extension-profile.ts`
- 删除：`tauri-agent/src-tauri/src/tencentdb/`、`tauri-agent/src-tauri/src/commands/tencentdb.rs`、`tauri-agent/src/features/tencentdb/`、`tauri-agent/src/lib/tencentdb.ts`

- [ ] **步骤 1：编写清理门禁测试**

在 `electron-agent/electron/tencentdbRemoval.test.ts` 增加静态门禁，扫描生产目录和 package manifests，断言不存在 `@tencentdb-agent-memory`、`TencentDbService`、`tencentdb_core_request`、`TDAI_MEMORY_ENDPOINT` 和 TencentDB extraResources。

- [ ] **步骤 2：运行门禁确认失败**

运行：`cd electron-agent; npm test -- electron/tencentdbRemoval.test.ts`

预期：FAIL，并列出当前残留路径。

- [ ] **步骤 3：删除旧运行时并改为新服务占位**

移除 `main.ts` 中 `TencentDbLayout`、`TencentDbRuntime`、`TencentDbPanelRuntime` 和 `TencentDbService` 的创建、warmup、shutdown 与 `resolveEnv` 注入；从 IPC 注册和 settings schema 删除所有 TencentDB command。删除 package/build 中的 SDK 和资源入口。扩展聚合暂时导出一个空的 `memory` provider 类型，保持编译入口但不保留 TencentDB 别名。

- [ ] **步骤 4：运行 TypeScript 与门禁**

运行：`cd electron-agent; npm test -- electron/tencentdbRemoval.test.ts; npm run build`

预期：门禁 PASS；构建只允许出现新占位接口缺失错误，不得出现 TencentDB 符号或依赖错误。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent extensions cli tauri-agent
git commit -m "refactor: remove TencentDB runtime and integration"
```

### 任务 2：建立 Data Runtime RPC 与 SQLite 基础

**文件：**
- 创建：`electron-agent/electron/agentData/protocol.ts`、`runtime.ts`、`client.ts`、`storage.ts`
- 创建：`electron-agent/electron/agentData/runtime.test.ts`、`client.test.ts`、`storage.test.ts`
- 创建：`electron-agent/electron/app/agentDataService.ts`、`agentDataService.test.ts`
- 修改：`electron-agent/electron/main.ts`、`electron-agent/electron/ipc/register.ts`

- [ ] **步骤 1：编写 RPC/迁移失败测试**

测试必须覆盖：随机 token 鉴权、未知 method 返回 `METHOD_NOT_FOUND`、请求超时、`hello` 返回协议版本、迁移重复执行幂等、Runtime 收到 stdin EOF 后退出。

- [ ] **步骤 2：运行测试确认失败**

运行：`cd electron-agent; npm test -- electron/agentData`

预期：FAIL，因为 Runtime、协议和服务尚未定义。

- [ ] **步骤 3：实现最小协议和 Runtime**

协议固定为：

```ts
type RpcRequest = { id: string; version: 1; method: string; params: Record<string, unknown>; token: string };
type RpcResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { code: string; message: string } };
```

Runtime 只监听动态分配的 loopback TCP 端口，先实现 `system.hello`、`system.status` 和 `system.shutdown`；`AgentDataService` 负责 spawn、读取端口/token、健康检查、请求复用和关闭回收。Pi 扩展通过端口和一次性 token 连接，避免依赖父进程 stdin。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd electron-agent; npm test -- electron/agentData`

预期：所有 RPC、鉴权、迁移和退出测试 PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData electron-agent/electron/app/agentDataService.ts electron-agent/electron/main.ts electron-agent/electron/ipc
git commit -m "feat: add local agent data runtime"
```

### 任务 3：实现 Memory Store 与 Pi Memory 扩展

**文件：**
- 创建：`electron-agent/electron/agentData/memoryStore.ts`、`memoryStore.test.ts`
- 创建：`extensions/memory/index.ts`、`client.ts`、`store.ts`、`context.ts`、`llm.ts`
- 创建：`extensions/memory/index.test.ts`、`client.test.ts`、`store.test.ts`、`context.test.ts`、`llm.test.ts`
- 修改：`extensions/index.ts`、`extensions/package.json`

- [ ] **步骤 1：编写 L0-L3 和 hook 失败测试**

覆盖：L0 幂等 cursor/fingerprint、L1 JSON 容错、L2/L3 Markdown 引用、`before_agent_start` 字符预算、`agent_end` 串行队列、LLM 失败保留旧状态、`memory_search` 和 `conversation_search` 作用域筛选。

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions; npx vitest run memory`

预期：FAIL。

- [ ] **步骤 3：实现 Store 和扩展**

`memoryStore` 只接受 `{ userId, workspace, sessionId }` 作用域；扩展通过 RPC 写入/检索，不读取任何 `TDAI_*` 变量。LLM 调用复用现有 `extensions/_shared/llm.ts` 的 `resolveModel(ctx.model, ctx.modelRegistry, undefined)` 与 `askLlm`。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions; npx vitest run memory; cd ../cli; npm run typecheck; npm run build`

预期：Memory 测试和扩展包构建 PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/memoryStore.ts extensions/memory extensions/index.ts extensions/package.json
git commit -m "feat: add local layered memory extension"
```

### 任务 4：接入 CodeGraph MCP adapter

**文件：**
- 创建：`extensions/code-retrieval/mcpClient.ts`、`tools.ts`、`index.ts`、`mcpClient.test.ts`、`tools.test.ts`、`index.test.ts`
- 修改：`extensions/package.json`、`extensions/index.ts`
- 创建：`electron-agent/electron/agentData/codeGraphJobs.ts`、`codeGraphJobs.test.ts`

- [ ] **步骤 1：编写 MCP 契约失败测试**

使用假的 stdio MCP server，覆盖 `initialize`、`notifications/initialized`、六个工具名映射、`projectPath` 注入、超时、进程退出和无 `.codegraph/` 可恢复提示。

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions; npx vitest run code-retrieval`

预期：FAIL。

- [ ] **步骤 3：实现 adapter**

默认启动命令为 `codegraph serve --mcp --path <workspace>`，允许 `GREN_CODEGRAPH_COMMAND` 覆盖；只解析 MCP stdout，stderr 进入脱敏诊断日志。工具参数与 CodeGraph 对齐，并限制 query/symbol/path 长度和 workspace 边界。

- [ ] **步骤 4：恢复历史 Tauri 图谱数据/UI 语义**

从提交 `d90d4d1` 恢复并改写以下行为到 Electron：`GraphNode`/`GraphEdge`/`RichGraph`、`compute_layout`、`detectCycles`、`findPaths`、CodeGraphPanel 的 loading/empty/error 状态，以及 IndexPanel 的 indexed/pending/failed 状态。所有调用改为 `codeRetrieval.*`，不得恢复 TencentDB 类型名。

- [ ] **步骤 5：运行测试确认通过**

运行：`cd extensions; npx vitest run code-retrieval; cd ../electron-agent; npm test -- src/features/agentData`

预期：MCP adapter 和图谱状态测试 PASS。

- [ ] **步骤 6：Commit**

```bash
git add extensions/code-retrieval electron-agent/electron/agentData/codeGraphJobs.ts electron-agent/src
git commit -m "feat: add built-in CodeGraph MCP retrieval"
```

### 任务 5：实现 Wiki RAG

**文件：**
- 创建：`electron-agent/electron/agentData/wikiStore.ts`、`wikiStore.test.ts`
- 创建：`extensions/wiki-rag/index.ts`、`client.ts`、`chunker.ts`、`llm.ts`、`index.test.ts`、`client.test.ts`、`chunker.test.ts`、`llm.test.ts`
- 修改：`extensions/index.ts`、`extensions/package.json`

- [ ] **步骤 1：编写分块、引用和检索失败测试**

覆盖：Markdown 标题分块、源码行号、内容哈希、FTS5/BM25 搜索、Wiki 页面原子替换、LLM 失败保留旧页面、workspace 隔离和删除级联。

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions; npx vitest run wiki-rag`

预期：FAIL。

- [ ] **步骤 3：移植 TencentDB Wiki 算法到自有接口**

把上游 Wiki 的扫描、Markdown 页面、来源引用和索引逻辑移植到 `wikiStore`；去掉 service/team/agent、HTTP Gateway 和官方 SDK。页面生成通过扩展里的 `ctx.model` 调用，结果只经 RPC 写入。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions; npx vitest run wiki-rag; cd ../cli; npm run typecheck; npm run build`

预期：Wiki 测试和扩展构建 PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/wikiStore.ts extensions/wiki-rag extensions/index.ts extensions/package.json
git commit -m "feat: add local LLM Wiki RAG"
```

### 任务 6：管理面板 Runtime API 与 Electron IPC

**文件：**
- 创建：`electron-agent/electron/agentData/jobStore.ts`
- 修改：`electron-agent/electron/agentData/protocol.ts`、`runtime.ts`、`client.ts`
- 修改：`electron-agent/electron/app/agentDataService.ts`、`electron-agent/electron/ipc/register.ts`、`contracts.ts`
- 创建：`electron-agent/src/lib/agentData.ts`、`agentData.test.ts`

- [ ] **步骤 1：编写管理 API 失败测试**

覆盖：`getSystemStatus`、`listJobs/getJob/cancelJob`、`getModuleConfig/updateModuleConfig`、`listAuditEvents/getDiagnostics`、`exportData/importData`；写操作必须产生 audit event，冲突版本返回 `VERSION_CONFLICT`。

- [ ] **步骤 2：运行测试确认失败**

运行：`cd electron-agent; npm test -- electron/agentData electron/ipc`

预期：FAIL。

- [ ] **步骤 3：实现 Runtime 管理方法和 IPC 映射**

Runtime 增加 `admin.*` 方法；主进程注册 `agentDataAdmin.*` command，Renderer API 只暴露类型化函数，不暴露 token、RPC 或数据库路径。任务进度通过现有 `gren:event:*` 事件广播。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd electron-agent; npm test -- electron/agentData electron/ipc`

预期：管理 API、版本冲突、审计和事件测试 PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData electron-agent/electron/app/agentDataService.ts electron-agent/electron/ipc electron-agent/src/lib/agentData.ts
git commit -m "feat: expose agent data management APIs"
```

### 任务 7：Electron 管理面板与工作区上下文迁移

**文件：**
- 创建：`electron-agent/src/features/agentData/AgentDataCenter.tsx`、`CodeRetrievalPanel.tsx`、`WikiPanel.tsx`、`MemoryPanel.tsx`
- 创建：`AgentDataCenter.test.tsx`、`CodeRetrievalPanel.test.tsx`、`WikiPanel.test.tsx`、`MemoryPanel.test.tsx`
- 修改：`electron-agent/src/features/settings/SettingsPanel.tsx`、`settingsSchema.ts`
- 修改：`electron-agent/src/features/chat/input/workspace/ProjectContextPanel.tsx`、`ProjectContextTabs.tsx`、`WorkspaceBar.tsx`

- [ ] **步骤 1：编写面板状态失败测试**

覆盖：Runtime stopped/starting/ready/failed、任务进度、CodeGraph indexed/pending/failed、Wiki 页面读写、Memory L0-L3 浏览、显式重建/删除确认和错误展示。

- [ ] **步骤 2：运行测试确认失败**

运行：`cd electron-agent; npm test -- src/features/agentData src/features/chat/input/workspace`

预期：FAIL。

- [ ] **步骤 3：移植历史 Tauri UI 交互**

复用 `d90d4d1` 的图谱画布数据结构、布局和状态显示，重命名为项目自研模块；面板通过 `agentData.ts` 调用 IPC，禁止直接拼 JSON-RPC 或读取文件。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd electron-agent; npm test -- src/features/agentData src/features/chat/input/workspace; npm run build`

预期：面板和工作区上下文测试 PASS，Electron 构建 PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/agentData electron-agent/src/features/settings electron-agent/src/features/chat/input/workspace
git commit -m "feat: add self-owned agent data management panels"
```

### 任务 8：全量验证、文档和发布清理

**文件：**
- 修改：`README.md`、`cli/README.md`、`extensions/README.md`
- 修改：`docs/superpowers/specs/2026-08-31-electron-self-owned-agent-modules-design.md`
- 修改：`electron-agent/electron-builder.yml`、`.github/workflows/release.yml`
- 创建：`docs/agent-data-migration.md`、`docs/third-party-notices.md`

- [ ] **步骤 1：添加发布清理扫描测试**

扫描源码、构建配置和打包产物，允许第三方许可文档中的来源说明，但禁止生产启动路径出现 TencentDB runtime、SDK、环境注入或旧 IPC command。

- [ ] **步骤 2：运行全量测试和构建**

运行：

```bash
cd extensions; npm test
cd ../electron-agent; npm test; npm run build
cd ../cli; npm test
```

预期：全部测试通过，Electron 构建成功。

- [ ] **步骤 3：手工验收三条主流程**

1. 无 TencentDB 运行时：对话写入/召回 L0-L3。
2. 已初始化 CodeGraph 工作区：六类 MCP 查询和图谱状态面板。
3. Wiki 同步、搜索、引用展示及管理面板任务进度。

- [ ] **步骤 4：更新文档和许可声明**

记录 TencentDB Agent Memory、CodeGraph 的 MIT 版权、来源 URL、上游版本/commit 和实际移植文件；文档说明旧数据默认不自动导入，导入工具只写入新 schema。

- [ ] **步骤 5：Commit**

```bash
git add README.md cli extensions electron-agent docs
git commit -m "docs: finalize self-owned agent modules migration"
```

---

## 自检

- 规格中的三类模块、Pi 当前模型复用、Data Runtime、管理面板、旧 TencentDB 清理和 Tauri CodeGraph 参考均有对应任务。
- 计划没有保留 TencentDB 兼容层；任务 1 是所有新模块接入前的门禁。
- `MemoryStore`、`WikiStore`、`jobStore` 和 RPC 协议的名称在后续任务中保持一致。
- 每个任务都有失败测试、最小实现、验证命令和独立提交点。
