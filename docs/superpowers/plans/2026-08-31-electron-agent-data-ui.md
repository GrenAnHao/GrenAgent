# Electron Agent Data 管理面板实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `subagent-driven-development` 或 `executing-plans` 逐任务实现此计划。步骤使用复选框跟踪进度。

**目标：** 将 Electron Agent Data 空白入口改造成连接真实 Runtime/IPC 的可用管理中心。

**架构：** Renderer 通过 `src/lib/agentData.ts` 调用类型化 IPC；主进程把请求转为 Agent Data Runtime 方法；组件只负责展示状态、筛选和用户确认。概览、任务、Memory、Wiki、CodeGraph、审计诊断共享页面头部和加载/错误状态，但各模块保持独立数据查询。

**技术栈：** React 19、TypeScript、Ant Design/antd-style、lucide-react、Vitest、Electron IPC、SQLite Agent Data Runtime。

---

## 文件总览

**修改：**

- `electron-agent/electron/agentData/runtime.ts`：增加管理面板需要的只读 Memory/Wiki/CodeGraph 状态查询方法和任务创建入口。
- `electron-agent/electron/agentData/jobStore.ts`：增加任务按状态筛选、取消幂等和审计读取字段。
- `electron-agent/electron/ipc/register.ts`：注册模块查询和任务创建 IPC。
- `electron-agent/src/lib/agentData.ts`：补齐 Renderer 类型和 API。
- `electron-agent/src/features/agentData/AgentDataCenter.tsx`：重做页面壳、导航、概览和统一状态处理。
- `electron-agent/src/features/agentData/MemoryPanel.tsx`：实现 Memory L0-L3 列表、搜索、作用域和确认动作。
- `electron-agent/src/features/agentData/WikiPanel.tsx`：实现 Wiki 页面列表、搜索、来源和同步动作。
- `electron-agent/src/features/agentData/CodeRetrievalPanel.tsx`：实现 CodeGraph 状态、同步、检索和图谱入口。

**创建：**

- `electron-agent/src/features/agentData/JobsPanel.tsx`：任务表、筛选、进度、取消和详情。
- `electron-agent/src/features/agentData/AuditDiagnosticsPanel.tsx`：审计与诊断只读视图。
- `electron-agent/src/features/agentData/agentDataStyles.ts`：共享页面样式，避免组件内重复内联布局。

**测试：**

- `electron-agent/electron/agentData/runtime.test.ts`
- `electron-agent/electron/agentData/jobStore.test.ts`
- `electron-agent/electron/ipc/register.test.ts`
- `electron-agent/src/lib/agentData.test.ts`
- `electron-agent/src/features/agentData/AgentDataCenter.test.tsx`
- `electron-agent/src/features/agentData/MemoryPanel.test.tsx`
- `electron-agent/src/features/agentData/WikiPanel.test.tsx`
- `electron-agent/src/features/agentData/CodeRetrievalPanel.test.tsx`
- `electron-agent/src/features/agentData/JobsPanel.test.tsx`
- `electron-agent/src/features/agentData/AuditDiagnosticsPanel.test.tsx`

### 任务 1：扩展 Runtime 查询契约

**目标：** 面板能获取真实摘要，而不是在 Renderer 写死数字。

- [ ] **步骤 1：编写失败测试**

在 `runtime.test.ts` 增加以下契约：

```ts
await expect(client.request('memory.admin.overview', scope)).resolves.toMatchObject({ total: 0, byLevel: { L0: 0, L1: 0, L2: 0, L3: 0 } });
await expect(client.request('wiki.admin.overview', { workspace: '/workspace' })).resolves.toMatchObject({ pages: 0 });
await expect(client.request('codeRetrieval.admin.status', { workspace: '/workspace' })).resolves.toMatchObject({ indexed: false });
await expect(client.request('admin.jobs.list', { state: 'running' })).resolves.toEqual([]);
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd electron-agent; npx vitest run electron/agentData/runtime.test.ts electron/agentData/jobStore.test.ts`

预期：新增方法返回 `METHOD_NOT_FOUND` 或类型断言失败。

- [ ] **步骤 3：实现最少 Runtime 方法**

在 `runtime.ts` 路由中增加：

```ts
if (name === 'memory.admin.overview') return (p) => this.memory!.overview(readScope(p));
if (name === 'wiki.admin.overview') return (p) => this.wiki!.overview({ workspace: readString(p.workspace) });
if (name === 'codeRetrieval.admin.status') return (p) => ({ workspace: readString(p.workspace), indexed: false, state: 'unavailable', files: 0, nodes: 0, edges: 0 });
```

`MemoryStore.overview` 从 `memories` 聚合总数和各层数量；`WikiStore.overview` 从 `wiki_pages` 按工作区聚合页面数和最新更新时间。CodeGraph 状态先明确返回未连接状态，不伪造索引统计；真实 MCP 状态由独立适配器接入时覆盖。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd electron-agent; npx vitest run electron/agentData/runtime.test.ts electron/agentData/jobStore.test.ts`

预期：新增契约和原有 Runtime 测试全部通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/runtime.ts electron-agent/electron/agentData/memoryStore.ts electron-agent/electron/agentData/wikiStore.ts electron-agent/electron/agentData/runtime.test.ts
git commit -m "feat: expose agent data overview queries"
```

### 任务 2：补齐 IPC 和 Renderer API

**目标：** 所有面板动作经类型化 IPC 访问，不在组件中调用 `invoke` 字符串。

- [ ] **步骤 1：编写失败测试**

在 `register.test.ts` 和 `agentData.test.ts` 增加：

```ts
await invoke({}, { command: 'agentData_memory_overview', args: { userId: 'u', workspace: '/w' } });
expect(agentData.request).toHaveBeenCalledWith('memory.admin.overview', { userId: 'u', workspace: '/w' });
await agentDataApi.memory.overview({ userId: 'u', workspace: '/w' });
expect(spy).toHaveBeenCalledWith('agentData_memory_overview', { userId: 'u', workspace: '/w' });
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd electron-agent; npx vitest run electron/ipc/register.test.ts src/lib/agentData.test.ts`

预期：命令未注册或 API 方法不存在。

- [ ] **步骤 3：实现 IPC 映射和类型**

在 `register.ts` 增加 `agentData_memory_overview`、`agentData_wiki_overview`、`agentData_code_status`、`agentData_jobs_create`；在 `agentData.ts` 增加 `MemoryOverview`、`WikiOverview`、`CodeGraphStatus` 和对应函数。所有 workspace 参数由调用方显式传入，默认取当前工作区，不在 API 层写死路径。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd electron-agent; npx vitest run electron/ipc/register.test.ts src/lib/agentData.test.ts`

预期：IPC 和 Renderer API 测试通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/ipc/register.ts electron-agent/electron/ipc/commandCoverage.test.ts electron-agent/electron/ipc/register.test.ts electron-agent/src/lib/agentData.ts electron-agent/src/lib/agentData.test.ts
git commit -m "feat: wire agent data management ipc api"
```

### 任务 3：共享样式和 AgentDataCenter 概览

**目标：** 用接近现有 Electron 的深色、紧凑、细边框视觉替换现有内联占位布局。

- [ ] **步骤 1：编写失败组件测试**

在 `AgentDataCenter.test.tsx` 覆盖：

```tsx
vi.mock('../../lib/agentData', () => ({ agentDataApi: {
  status: vi.fn(), jobs: { list: vi.fn() }, memory: { overview: vi.fn() }, wiki: { overview: vi.fn() }, code: { status: vi.fn() },
}}));
it('renders overview KPIs from runtime data and switches views', async () => {
  render(<AgentDataCenter workspace="/workspace" />);
  expect(await screen.findByText('248')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Memory' }));
  expect(screen.getByTestId('memory-panel')).toBeInTheDocument();
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd electron-agent; npx vitest run src/features/agentData/AgentDataCenter.test.tsx`

预期：组件仍显示占位文本或缺少真实 KPI。

- [ ] **步骤 3：实现样式和页面壳**

建立 `agentDataStyles.ts`，使用 `createStyles` 定义 `root/head/kpis/card/table/toolbar/state`。`AgentDataCenter` 接收 `workspace?: string`，加载 status/jobs/三个 overview，渲染概览 KPI、模块状态、最近任务和活动；导航按钮切换独立面板，统一处理 `loading/error/closed/empty`。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd electron-agent; npx vitest run src/features/agentData/AgentDataCenter.test.tsx`

预期：概览数据来自 mock API，导航切换成功，失败态可见。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/agentData/agentDataStyles.ts electron-agent/src/features/agentData/AgentDataCenter.tsx electron-agent/src/features/agentData/AgentDataCenter.test.tsx
git commit -m "feat: build agent data center overview"
```

### 任务 4：JobsPanel 与任务操作

**目标：** 任务列表显示真实状态，并连接创建、取消和详情操作。

- [ ] **步骤 1：编写失败测试**

覆盖运行中、完成、失败、取消按钮和搜索筛选：

```tsx
expect(screen.getByText('Wiki 增量同步')).toBeInTheDocument();
await userEvent.click(screen.getByRole('button', { name: '取消' }));
expect(agentDataApi.jobs.cancel).toHaveBeenCalledWith('job-1');
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd electron-agent; npx vitest run src/features/agentData/JobsPanel.test.tsx`

预期：文件不存在或现有中心没有任务操作。

- [ ] **步骤 3：实现 JobsPanel**

实现搜索框、状态下拉、进度条、状态标签和操作列。取消按钮调用 `agentDataApi.jobs.cancel` 后重新加载；失败任务详情显示 `error`；创建任务由父组件传入 `onCreate(kind, workspace)`，成功后刷新列表。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd electron-agent; npx vitest run src/features/agentData/JobsPanel.test.tsx`

预期：任务列表、筛选和取消行为通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/agentData/JobsPanel.tsx electron-agent/src/features/agentData/JobsPanel.test.tsx electron-agent/src/lib/agentData.ts
git commit -m "feat: add agent data jobs workbench"
```

### 任务 5：Memory、Wiki 和 CodeGraph 工作台

**目标：** 三个面板均显示真实查询结果并提供可验证的模块动作。

- [ ] **步骤 1：编写失败测试**

分别覆盖：Memory 层级/作用域筛选和引用来源，Wiki 来源路径/搜索/同步，CodeGraph 未索引提示/状态/同步请求。

```tsx
expect(screen.getByText('Electron 版统一使用 TypeScript Agent Data Runtime')).toBeInTheDocument();
expect(screen.getByText('docs/architecture.md')).toBeInTheDocument();
expect(screen.getByText('CodeGraph 索引尚未连接')).toBeInTheDocument();
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd electron-agent; npx vitest run src/features/agentData/MemoryPanel.test.tsx src/features/agentData/WikiPanel.test.tsx src/features/agentData/CodeRetrievalPanel.test.tsx`

预期：当前三个占位组件无法满足断言。

- [ ] **步骤 3：实现 MemoryPanel**

调用 `memory.search`/`memory.overview`，用表格显示 level、content、scope、source、updatedAt；层级和文本筛选在组件状态中管理；重建/删除先调用确认回调，再触发任务或删除 API，完成后刷新。

- [ ] **步骤 4：实现 WikiPanel**

调用 `wiki.search`/`wiki.admin.overview`，显示页面标题、摘要、sourcePath、分块数和索引状态；同步按钮调用 `jobs.create({ kind: 'wiki.sync', workspace })` 并切换到任务视图；无结果显示工作区相关空态。

- [ ] **步骤 5：实现 CodeRetrievalPanel**

调用 `codeRetrieval.admin.status`，展示 indexed/state/files/nodes/edges；未初始化时显示 `codegraph init` 提示但不自动执行；同步创建 `codegraph.sync` 任务；快速检索调用已暴露的 `code_search` 适配器查询接口，结果显示文件和行号。

- [ ] **步骤 6：运行测试确认通过**

运行：`cd electron-agent; npx vitest run src/features/agentData/MemoryPanel.test.tsx src/features/agentData/WikiPanel.test.tsx src/features/agentData/CodeRetrievalPanel.test.tsx`

预期：三面板测试全部通过，loading/failed/empty 状态均有断言。

- [ ] **步骤 7：Commit**

```bash
git add electron-agent/src/features/agentData/MemoryPanel.tsx electron-agent/src/features/agentData/WikiPanel.tsx electron-agent/src/features/agentData/CodeRetrievalPanel.tsx electron-agent/src/features/agentData/*test.tsx
git commit -m "feat: connect memory wiki and codegraph workbenches"
```

### 任务 6：审计诊断、主应用接入与完整验证

**目标：** 管理操作可追溯，页面在真实 ModuleContainer 中可用，完成构建和回归验证。

- [ ] **步骤 1：编写失败测试**

在 `AuditDiagnosticsPanel.test.tsx` 覆盖审计动作、脱敏字段和诊断空态；在 `AgentDataCenter.test.tsx` 验证 `ModuleContainer` 渲染不再出现“通过接口浏览”占位文本。

- [ ] **步骤 2：实现审计诊断面板**

调用 `agentDataApi.audit()` 和 `diagnostics()`，以只读表格展示 action/detail/time；对 `token`、`apiKey`、`secret`、`credential` 键统一显示 `[redacted]`；诊断失败显示重试按钮。

- [ ] **步骤 3：接入当前工作区上下文**

从现有 session/workspace store 读取工作区路径传给 `AgentDataCenter`；不改变 ModuleRail 的模块 ID。页面头部刷新只刷新当前中心数据，聊天模块继续保活。

- [ ] **步骤 4：运行定向测试和构建**

运行：

```bash
cd electron-agent
npx vitest run src/features/agentData electron/agentData electron/ipc/register.test.ts src/lib/agentData.test.ts
npm run build
```

预期：面板、Runtime、IPC 测试通过，Electron TypeScript 和 Vite 构建退出码为 `0`。第三方依赖的 `use client` 警告可出现，但不能有构建错误。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/agentData electron-agent/src/features/workspace/ModuleContainer.tsx electron-agent/src/lib/agentData.ts
git commit -m "feat: finish electron agent data management ui"
```

## 计划自检

- 规格中的六类页面均有对应任务：概览/任务（任务 3、4）、Memory/Wiki/CodeGraph（任务 5）、审计诊断（任务 6）。
- 真实数据链路先于视觉组件：任务 1、2 在任务 3 之前完成。
- 所有新方法名和类型在任务 1、2 定义后复用，没有跨任务改名。
- 计划中没有未定义的泛化步骤；每个组件都有测试命令和明确断言。
- 完整图谱画布、独立 Runtime 子进程、Skill/Agent 资产仍明确排除，避免本次 UI 改造扩大范围。
