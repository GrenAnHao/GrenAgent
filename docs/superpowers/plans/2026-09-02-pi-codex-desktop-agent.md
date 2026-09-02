# Pi Codex 风格桌面 Agent 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Electron 主进程建立 Codex 风格的本地 App Server，使项目 Pi 负责项目会话，通用 system Pi 按需执行受限系统任务，并逐步统一事件、记忆、MCP、权限、沙箱、插件和非交互队列。

**架构：** Electron 是唯一控制面，持久化 Thread/Turn/Item、策略和任务状态；每个 workspace 仍使用一个项目 Pi，可服务多个 Thread 但串行执行 active Turn。system Pi 是 Electron 共享的按需 Worker，只接受 ServiceTask Registry 中已注册的任务定义，不继承项目上下文、工具或权限。

**技术栈：** Electron 主进程、TypeScript、Vitest、现有 Agent Data SQLite/JSONL RPC、Pi JSONL RPC、Zod（运行时 schema 校验）。

---

## 文件与职责清单

### 新增

- `electron-agent/electron/app/appServer/types.ts`：Thread、Turn、Item、AppEvent、ServiceTask 和权限相关公共类型。
- `electron-agent/electron/app/appServer/eventBus.ts`：单调 sequence、订阅、环形缓冲和 gap 回放。
- `electron-agent/electron/app/appServer/eventBus.test.ts`：事件顺序、订阅隔离和 gap 行为。
- `electron-agent/electron/pi/eventAdapter.ts`：Pi 原始事件到 AppEvent/Item 的映射。
- `electron-agent/electron/pi/eventAdapter.test.ts`：assistant、thinking、tool、agent_end 和未知事件映射。
- `electron-agent/electron/agentData/threadStore.ts`：Thread/Turn/Item/AppEvent repository。
- `electron-agent/electron/agentData/threadStore.test.ts`：迁移、关联、状态更新和重启读取。
- `electron-agent/electron/app/appServer/serviceTaskRegistry.ts`：系统任务定义注册和能力白名单。
- `electron-agent/electron/app/appServer/serviceTaskRegistry.test.ts`：注册、schema 校验和非法能力拒绝。
- `electron-agent/electron/app/appServer/taskQueue.ts`：Turn/ServiceTask 调度、取消、重试和恢复。
- `electron-agent/electron/app/appServer/taskQueue.test.ts`：同 Thread 串行、system Pi 串行、取消和重试。
- `electron-agent/electron/pi/systemWorkerManager.ts`：system Pi 按需启动、空闲退出和崩溃回收。
- `electron-agent/electron/pi/systemWorkerManager.test.ts`：启动复用、idleTimeout、退出和故障重试。
- `electron-agent/electron/app/memoryService.ts`：scope 策略、capture/search 和记忆任务入队。
- `electron-agent/electron/app/memoryService.test.ts`：默认隔离、显式跨项目读取和审计字段。
- `electron-agent/electron/app/permissionManager.ts`：PermissionProfile 合并、evaluate 和 ask 状态机。
- `electron-agent/electron/app/permissionManager.test.ts`：readonly/workspace/automation 及 ask/deny。
- `electron-agent/electron/app/sandbox/sandboxManager.ts`：统一进程策略入口和降级事件。
- `electron-agent/electron/app/sandbox/sandboxManager.test.ts`：路径、环境、网络和能力不足降级。
- `electron-agent/electron/app/plugin/pluginManager.ts`：manifest 校验、生命周期和故障记录。
- `electron-agent/electron/app/plugin/pluginManager.test.ts`：状态迁移、版本拒绝和故障隔离。

### 修改

- `electron-agent/electron/agentData/storage.ts`：增加 schema migration，创建 `threads`、`turns`、`items`、`app_events`、`service_tasks`、`plugin_state`。
- `electron-agent/electron/app/agentDataService.ts`：暴露新的 repository/RPC 方法并保持现有 Agent Data API。
- `electron-agent/electron/pi/manager.ts`：保留 workspace 唯一项目 Pi 约束，支持 system worker 独立 manager。
- `electron-agent/electron/app/piRuntimeService.ts`：接入 Thread/Turn adapter、统一事件发布、memory RPC 和权限决策。
- `electron-agent/electron/ipc/contracts.ts`、`electron-agent/electron/ipc/register.ts`：增加 thread/turn/item/task/event/memory/permission/mcp IPC 合约。
- `electron-agent/electron/app/mcpConfigService.ts`、`electron-agent/electron/app/mcpPolicyService.ts`：合并全局/项目 MCP 配置并通过 PermissionManager 审计。
- `electron-agent/electron/app/shellService.ts`、`electron-agent/electron/app/terminalService.ts`：所有命令和 PTY 经过 SandboxManager/PermissionManager。
- `electron-agent/electron/app/subagentService.ts`：子代理进程复用统一沙箱和非交互任务状态。
- `electron-agent/src/lib/pi.ts`、`electron-agent/src/stores/agentReducer.ts`：增加 AppEvent 双读适配，保留旧 Pi 事件兼容。
- `electron-agent/src/stores/agentStoreRegistry.ts`、聊天相关组件：在双读验证后切换 Item 驱动状态。
- `extensions/index.ts`、`extensions/goal/index.ts`、`extensions/web-search/index.ts`、`extensions/mcp/index.ts`：提供 manifest/capability 元数据并调用统一权限入口。
- `extensions/memory/*`：移除直接写入全局状态的路径，改走 Electron MemoryService RPC。

每个任务只修改清单中的相关文件；现有无关工作区改动不纳入提交。

## 任务 1：协议类型、EventBus 和 Pi 事件 adapter

**文件：**
- 创建：`electron-agent/electron/app/appServer/types.ts`
- 创建：`electron-agent/electron/app/appServer/eventBus.ts`
- 创建：`electron-agent/electron/app/appServer/eventBus.test.ts`
- 创建：`electron-agent/electron/pi/eventAdapter.ts`
- 创建：`electron-agent/electron/pi/eventAdapter.test.ts`

- [ ] **步骤 1：编写失败测试**

在 `eventBus.test.ts` 覆盖：发布两个事件得到 `sequence=1,2`；一个订阅者抛错时另一个仍收到事件；`replay(afterSequence)` 越过最早缓存返回 `{ kind: "gap" }`。在 `eventAdapter.test.ts` 断言 `message_update` 变为 `item.delta`，`tool_execution_end` 变为 `item.updated`，未知事件返回 `undefined`。

- [ ] **步骤 2：运行测试确认失败**

运行：`npm --prefix electron-agent test -- --run electron/app/appServer/eventBus.test.ts electron/pi/eventAdapter.test.ts`

预期：因模块和导出尚不存在而失败。

- [ ] **步骤 3：实现最小协议层**

在 `types.ts` 定义设计稿中的 `Thread`、`Turn`、`Item`、`AppEvent`、`PermissionProfile` 和 `ServiceTask`。EventBus 维护 `nextSequence`、固定容量数组和 `subscribe/replay`；adapter 只做字段映射，不改变原始 Pi 事件。

- [ ] **步骤 4：运行测试确认通过**

运行同一 Vitest 命令，预期全部 PASS，并补充 `npm --prefix electron-agent run build` 类型检查。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/appServer electron-agent/electron/pi/eventAdapter.ts electron-agent/electron/pi/eventAdapter.test.ts
git commit -m "feat: add app event protocol and pi adapter"
```

## 任务 2：Agent Data 持久化与 App Server adapter

**文件：**
- 修改：`electron-agent/electron/agentData/storage.ts`
- 创建：`electron-agent/electron/agentData/threadStore.ts`
- 创建：`electron-agent/electron/agentData/threadStore.test.ts`
- 修改：`electron-agent/electron/app/agentDataService.ts`
- 修改：`electron-agent/electron/app/piRuntimeService.ts`
- 修改：`electron-agent/electron/ipc/contracts.ts`
- 修改：`electron-agent/electron/ipc/register.ts`

- [ ] **步骤 1：编写迁移和 repository 失败测试**

使用临时 SQLite 文件验证 `schemaVersion()` 升级后存在六张新表；插入 Thread、Turn、Item 后按 threadId 读取；更新 Turn 为 `failed` 会保存 error；关闭并重新打开数据库仍能读取权威快照。

- [ ] **步骤 2：运行测试确认失败**

运行：`npm --prefix electron-agent test -- --run electron/agentData/threadStore.test.ts electron/agentData/storage.test.ts`

预期：新表和 repository 方法不存在导致失败。

- [ ] **步骤 3：实现 migration、repository 和 adapter**

在 migration 中使用幂等 `CREATE TABLE IF NOT EXISTS`；repository 提供 `createThread/listThreads/readThread/createTurn/updateTurn/upsertItem/listItems/appendAppEvent`。在 `piRuntimeService` 为现有 `agent_prompt`、`agent_abort` 建立 Thread/Turn adapter，并通过 EventBus 发布生命周期事件。IPC 合约只返回序列化 DTO，不暴露 SQLite 对象。

- [ ] **步骤 4：运行测试确认通过**

运行：`npm --prefix electron-agent test -- --run electron/agentData/threadStore.test.ts electron/app/piRuntimeService.test.ts electron/ipc/contracts.test.ts`

预期：新测试和既有 Pi runtime/IPC 测试全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/ipc/contracts.ts electron-agent/electron/ipc/register.ts
git commit -m "feat: persist thread turn item state"
```

## 任务 3：通用 ServiceTask Registry、TaskQueue 和 system Pi

**文件：**
- 创建：`electron-agent/electron/app/appServer/serviceTaskRegistry.ts`
- 创建：`electron-agent/electron/app/appServer/serviceTaskRegistry.test.ts`
- 创建：`electron-agent/electron/app/appServer/taskQueue.ts`
- 创建：`electron-agent/electron/app/appServer/taskQueue.test.ts`
- 创建：`electron-agent/electron/pi/systemWorkerManager.ts`
- 创建：`electron-agent/electron/pi/systemWorkerManager.test.ts`
- 修改：`electron-agent/electron/pi/manager.ts`
- 修改：`electron-agent/electron/agentData/storage.ts`

- [ ] **步骤 1：编写失败测试**

测试 Registry 拒绝未注册 kind、输入 schema 不匹配和未声明 capability；测试 Queue 保证同一 Thread 不并发、system task 串行、取消 queued task、进程退出后 running task 恢复 queued；测试 Worker 对首个任务启动 Pi，连续任务复用进程，idleTimeout 后关闭。

- [ ] **步骤 2：运行测试确认失败**

运行：`npm --prefix electron-agent test -- --run electron/app/appServer/serviceTaskRegistry.test.ts electron/app/appServer/taskQueue.test.ts electron/pi/systemWorkerManager.test.ts`

预期：Registry、Queue 和 system worker 模块不存在而失败。

- [ ] **步骤 3：实现注册表和调度**

定义内置 kind：`memory_extract`、`memory_deduplicate`、`memory_summarize`、`thread_title_generate`、`content_classify`、`context_summarize`。Registry 保存 schema、timeout、maxAttempts、capabilities；Queue 仅接受启用定义，system Pi 串行执行，项目 Pi 由 Thread 锁串行执行。所有状态写入 `service_tasks` 并发布 `task.*` 事件。

- [ ] **步骤 4：实现 systemWorkerManager**

复用 `spawnPiClient` 的 JSONL transport，但使用独立 worker key 和受限启动参数；启动时只发送任务定义和临时上下文，完成后清理上下文；无任务达到 idleTimeout 调用 `close`。崩溃将当前任务按 `attempts/maxAttempts` 回队或标记 failed。

- [ ] **步骤 5：运行测试确认通过**

运行同一 Vitest 命令和 `npm --prefix electron-agent run build`，预期全部 PASS、TypeScript 无错误。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/app/appServer electron-agent/electron/pi/systemWorkerManager.ts electron-agent/electron/pi/manager.ts electron-agent/electron/agentData/storage.ts
git commit -m "feat: add on-demand system task worker"
```

## 任务 4：MemoryService 与 system Worker 接入

**文件：**
- 创建：`electron-agent/electron/app/memoryService.ts`
- 创建：`electron-agent/electron/app/memoryService.test.ts`
- 修改：`electron-agent/electron/agentData/memoryStore.ts`
- 修改：`electron-agent/electron/app/piRuntimeService.ts`
- 修改：`extensions/memory/capture.ts`
- 修改：`extensions/memory/llm.ts`

- [ ] **步骤 1：编写失败测试**

验证默认 `search(project-A)` 只返回 project-A 与 global；启用跨项目策略后返回 project-B 且结果带 `sourceProjectId/scope`；capture 只产生 pending record 和 `memory_extract` ServiceTask，不直接写入最终记忆表；system worker 结果经 schema 校验后才写入。

- [ ] **步骤 2：运行测试确认失败**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryService.test.ts electron/agentData/memoryStore.test.ts; npm --prefix extensions exec vitest run memory/capture.test.ts`

预期：MemoryService RPC 和统一 scope 过滤尚不存在而失败。

- [ ] **步骤 3：实现 MemoryService**

实现 `MemoryScope` 过滤、跨项目策略读取、capture 入队、system task 完成回调和 `memory.updated` 事件。SQLite 写入由 Electron 完成；system worker 只返回结构化提炼结果，结果不写入项目 Pi session。

- [ ] **步骤 4：切换 memory 扩展 RPC**

扩展通过受控 RPC 调用 `memory.search`/`memory.capture`，删除直接依赖 Electron 数据库的路径；保留现有扩展 API 的兼容包装。

- [ ] **步骤 5：运行测试确认通过并提交**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryService.test.ts electron/agentData/memoryStore.test.ts; npm --prefix extensions exec vitest run memory/capture.test.ts`，预期 PASS。

```bash
git add electron-agent/electron/app/memoryService.ts electron-agent/electron/agentData/memoryStore.ts electron-agent/electron/app/piRuntimeService.ts extensions/memory
git commit -m "feat: route memory through electron and system worker"
```

## 任务 5：MCP Center 与 PermissionManager

**文件：**
- 创建：`electron-agent/electron/app/permissionManager.ts`
- 创建：`electron-agent/electron/app/permissionManager.test.ts`
- 修改：`electron-agent/electron/app/mcpConfigService.ts`
- 修改：`electron-agent/electron/app/mcpPolicyService.ts`
- 修改：`electron-agent/electron/app/piRuntimeService.ts`
- 修改：`electron-agent/electron/ipc/contracts.ts`
- 修改：`electron-agent/electron/ipc/register.ts`
- 修改：`extensions/goal/index.ts`、`extensions/web-search/index.ts`、`extensions/mcp/index.ts`

- [ ] **步骤 1：编写失败测试**

断言 readonly 拒绝写文件/进程，workspace 只允许 workspace root，automation 遇到 ask 返回 blocked，MCP 全局+项目配置合并后只下发当前项目有效 server，策略变更产生 `permission.*` 和 `mcp.state_changed` 审计事件。

- [ ] **步骤 2：运行测试确认失败**

运行：`npm --prefix electron-agent test -- --run electron/app/permissionManager.test.ts electron/app/mcpConfigService.test.ts electron/app/mcpPolicyService.test.ts`

预期：统一 evaluate 和中心配置合并接口尚不存在而失败。

- [ ] **步骤 3：实现 PermissionManager**

实现 `evaluate(operation, profile)` 返回 `allow|deny|ask`；将现有 approval、safety、mcp-policy 和 workspace trust 作为 provider 链接入，不在各调用点复制规则。`ask` 创建 permission request 并持久化 resolution。

- [ ] **步骤 4：实现 MCP Center adapter**

在 Electron 合并全局/项目配置，向 Pi 发送脱敏配置或凭据引用；Pi 继续建立独立 Client。所有 MCP 工具调用仍由 Pi 执行，Electron 只处理配置、策略和审计。

- [ ] **步骤 5：运行测试确认通过并提交**

运行：`npm --prefix electron-agent test -- --run electron/app/permissionManager.test.ts electron/app/mcpConfigService.test.ts electron/app/mcpPolicyService.test.ts electron/app/piRuntimeService.test.ts`，预期 PASS。

```bash
git add electron-agent/electron/app/permissionManager.ts electron-agent/electron/app/mcpConfigService.ts electron-agent/electron/app/mcpPolicyService.ts electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/ipc extensions/goal extensions/web-search extensions/mcp
git commit -m "feat: centralize permissions and mcp governance"
```

## 任务 6：SandboxManager 与进程入口统一

**文件：**
- 创建：`electron-agent/electron/app/sandbox/sandboxManager.ts`
- 创建：`electron-agent/electron/app/sandbox/sandboxManager.test.ts`
- 修改：`electron-agent/electron/app/shellService.ts`
- 修改：`electron-agent/electron/app/terminalService.ts`
- 修改：`electron-agent/electron/app/subagentService.ts`
- 修改：`electron-agent/electron/pi/manager.ts`

- [ ] **步骤 1：编写失败测试**

测试 `run` 收到 readonly profile 时拒绝写路径；workspace profile 将 cwd 和读写路径限制在 workspace root；网络关闭时拒绝网络能力；平台能力不足时发布降级事件且不升级 profile。

- [ ] **步骤 2：运行测试确认失败**

运行：`npm --prefix electron-agent test -- --run electron/app/sandbox/sandboxManager.test.ts electron/app/shellService.test.ts electron/app/terminalService.test.ts electron/app/subagentService.test.ts`

预期：统一 SandboxManager 入口不存在而失败。

- [ ] **步骤 3：实现策略层 SandboxManager**

实现路径规范化、环境变量过滤、网络模式和 `SandboxCapabilities`；Windows 首版调用受控 child process/Job Object 能力探测，能力不足返回明确降级状态；禁止静默切换 unrestricted。

- [ ] **步骤 4：接入所有进程入口**

Shell、PTY、Terminal、项目 Pi、system Pi 和子代理统一调用 `SandboxManager.run/stop`，并将 profile 与审计上下文传入；保留现有命令 allowlist 作为 provider。

- [ ] **步骤 5：运行测试确认通过并提交**

运行：`npm --prefix electron-agent test -- --run electron/app/sandbox/sandboxManager.test.ts electron/app/shellService.test.ts electron/app/terminalService.test.ts electron/app/subagentService.test.ts electron/pi/manager.test.ts`，预期 PASS。

```bash
git add electron-agent/electron/app/sandbox electron-agent/electron/app/shellService.ts electron-agent/electron/app/terminalService.ts electron-agent/electron/app/subagentService.ts electron-agent/electron/pi/manager.ts
git commit -m "feat: route processes through sandbox manager"
```

## 任务 7：PluginManager 生命周期和扩展 manifest

**文件：**
- 创建：`electron-agent/electron/app/plugin/pluginManager.ts`
- 创建：`electron-agent/electron/app/plugin/pluginManager.test.ts`
- 修改：`extensions/index.ts`
- 修改：`electron-agent/electron/ipc/contracts.ts`
- 修改：`electron-agent/electron/ipc/register.ts`
- 修改：`extensions/goal/index.ts`、`extensions/web-search/index.ts`、`extensions/mcp/index.ts`

- [ ] **步骤 1：编写失败测试**

覆盖 discovered→validated→loaded→started→ready→stopping→stopped；无效 apiVersion 进入 validation_failed；启动异常只标记该插件并发布 `plugin.state_changed`，其他插件状态不变。

- [ ] **步骤 2：运行测试确认失败**

运行：`npm --prefix electron-agent test -- --run electron/app/plugin/pluginManager.test.ts; npm --prefix extensions exec vitest run index.test.ts`

预期：manifest、状态机和 PluginManager 尚不存在而失败。

- [ ] **步骤 3：实现 PluginManager**

校验 `id/version/apiVersion/capabilities/permissions`，Electron 保存状态和故障；Pi 只收到允许加载的扩展列表。发现/校验/启动阶段错误隔离；运行期致命错误按项目 Pi 进程边界恢复，不引入每插件独立进程。

- [ ] **步骤 4：补充内置扩展元数据**

为 goal、web-search、mcp 增加 manifest capability；保留 `allExtensions` 静态导出，通过 adapter 接入生命周期，不改变现有扩展加载顺序。

- [ ] **步骤 5：运行测试确认通过并提交**

运行：`npm --prefix electron-agent test -- --run electron/app/plugin/pluginManager.test.ts` 和 `npm --prefix extensions exec vitest run index.test.ts goal web-search mcp`，预期 PASS。

```bash
git add electron-agent/electron/app/plugin extensions/index.ts electron-agent/electron/ipc extensions/goal extensions/web-search extensions/mcp
git commit -m "feat: add plugin lifecycle manager"
```

## 任务 8：agent/goal/mcp/web-search 接入与前端 AppEvent 切换

**文件：**
- 修改：`electron-agent/src/lib/pi.ts`
- 修改：`electron-agent/src/stores/agentReducer.ts`
- 修改：`electron-agent/src/stores/agentStoreRegistry.ts`
- 修改：聊天相关组件和对应测试
- 修改：`electron-agent/electron/app/piRuntimeService.ts`
- 修改：`extensions/goal/index.ts`、`extensions/web-search/index.ts`、`extensions/mcp/index.ts`

- [ ] **步骤 1：编写失败集成测试**

构造一组 AppEvent，断言 Renderer 按 Item 重建 assistant/tool/permission 状态；旧 `pi://event` 与新事件并行时不重复显示；goal 后续 Turn 通过 `turn/start` 入队；web-search 遵守网络 profile；MCP 状态来自中心事件。

- [ ] **步骤 2：运行测试确认失败**

运行：`npm --prefix electron-agent test -- --run src/stores/agentReducer.test.ts src/stores/agent.test.ts electron/app/piRuntimeService.test.ts; npm --prefix extensions exec vitest run goal web-search`

预期：Reducer 尚未消费 AppEvent，集成断言失败。

- [ ] **步骤 3：实现双读 adapter**

在 `agentReducer` 增加 AppEvent 分支，旧事件保留；以 `item.delta` 更新流式文本，以 `item.updated` 关闭 Item，以 permission 事件驱动现有审批 UI。PiRuntimeService 同时发送旧事件和 AppEvent，使用相同 turn/item id。

- [ ] **步骤 4：切换前端主消费路径**

在双读结果一致的测试通过后，将聊天状态主路径切换为 AppEvent；goal、web-search、mcp 仅调用 Electron 定义的 RPC/权限接口，不直接管理全局状态。

- [ ] **步骤 5：运行完整验证**

运行：`npm --prefix electron-agent test -- --run`、`npm --prefix extensions exec vitest run` 和 `npm --prefix electron-agent run build`；预期现有 reducer、Pi client/manager、MCP、goal、web-search、multi-agent 测试全部 PASS，TypeScript 构建无错误。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/src electron-agent/electron/app/piRuntimeService.ts extensions/goal extensions/web-search extensions/mcp
git commit -m "feat: consume unified app events in renderer"
```

## 规格覆盖自检

- Thread/Turn/Item 数据模型：任务 1、2、8。
- 统一事件协议与回放：任务 1、2、8。
- Electron/Pi 边界：任务 2、3、4、5、6。
- 通用 system Pi 与按需生命周期：任务 3。
- 记忆统一数据库、scope 和跨项目策略：任务 4。
- MCP 中心治理与项目独立 Client：任务 5、8。
- Permission Profile：任务 5、6、8。
- OS 级沙箱策略和降级：任务 6。
- 插件 manifest、生命周期和故障隔离：任务 7。
- 非交互 Turn、ServiceTask、取消/恢复/重试：任务 3、8。
- `agent`、`goal`、`mcp`、`web-search` 边界：任务 5、7、8。
- Codex Cloud、远程容器、多租户等非目标：不创建对应模块或接口。

## 计划自检结果

- 已扫描计划中的“TODO/待定/后续实现/适当错误处理”等占位表达，均未使用。
- 所有跨任务引用的类型和方法在任务 1 或任务 3 中定义，名称保持一致。
- 每个任务都包含失败测试、失败验证、最小实现、通过验证和独立 commit；任务 8 负责最终回归验收。
