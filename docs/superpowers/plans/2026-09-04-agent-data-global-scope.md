# Agent 数据中心全局作用域重构 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把"Agent 数据"面板从"跟随当前对话的 workspace 强制过滤"改造成真正的全局管理中心，同时给 `wiki.sync` / `codegraph.sync` 两个空转的 job 补上真实执行器。

**架构：** 三类数据存储层都保留"来源项目"字段用于溯源，但读取默认不再按项目过滤。Memory/Wiki 默认全局查询 + 可选项目筛选器；CodeGraph 因符号空间不可合并，保留强制项目选择器，并新增主进程子进程池复用索引连接。Wiki 同步走"新任务 kind + 主进程编排器"（系统 worker 加载零扩展，只能收发文本 prompt）；CodeGraph 同步走主进程直接 spawn `codegraph` CLI。

**技术栈：** TypeScript、Electron 主进程、`node:sqlite`、React 19、antd-style、Vitest、`@modelcontextprotocol/sdk`（新增到 electron-agent）。

**设计依据：** `docs/superpowers/specs/2026-09-04-agent-data-global-scope-design.md`

---

## 文件总览

### 阶段一：Memory 默认全局读取

**修改：**
- `electron-agent/electron/app/memoryService.ts`：`completeExtraction()` 把 L2/L3 写入 `scope: 'global'`，L1 保持 project scope。
- `electron-agent/electron/agentData/memoryStore.ts`：`remove()` 放宽为按 `user_id` 判权（去掉 workspace 相等约束），使全局视图能删除任意项目的记录。
- `electron-agent/electron/agentData/runtime.ts`：新增 `readQueryScope()`（workspace 可缺省），用于 `memory.admin.overview` / `memory.search` 两个只读方法。
- `electron-agent/electron/ipc/register.ts`：三个 memory 命令转发 `projectId` / `includeOtherProjects`，`workspace` 变为可选。
- `electron-agent/src/lib/agentData.ts`：`MemoryScope` 补 `projectId` / `includeOtherProjects`，`MemoryRecord` 补 `sourceProjectId` / `scope`。
- `electron-agent/src/features/agentData/MemoryPanel.tsx`：默认全局展示、新增项目筛选器、显示记录来源项目。

**创建：**
- `electron-agent/src/features/agentData/useProjectOptions.ts`：从 session store 聚合项目选项（Memory/Wiki/Code 三个面板共用）。

**测试：**
- `electron-agent/electron/app/memoryService.test.ts`
- `electron-agent/electron/agentData/memoryStore.test.ts`
- `electron-agent/electron/agentData/runtime.test.ts`
- `electron-agent/electron/ipc/register.test.ts`
- `electron-agent/src/lib/agentData.test.ts`
- `electron-agent/src/features/agentData/MemoryPanel.test.tsx`

### 阶段二：Wiki 默认全局读取 + 同步执行器

**修改：**
- `electron-agent/electron/agentData/wikiStore.ts`：`search()` / `overview()` 的 workspace 变为可选；搜索结果新增 `workspace` 字段。
- `electron-agent/electron/agentData/jobStore.ts`：新增 `start()` / `progress()` / `complete()` / `fail()` / `hasActive()`。
- `electron-agent/electron/pi/systemWorkerManager.ts`：新增 `wiki_page_generate` kind（文本 prompt + 文本结果，不走 JSON 解析）。
- `electron-agent/electron/agentData/runtime.ts`：`wiki.search` / `wiki.admin.overview` 接受缺省 workspace；`admin.jobs.create` 接入执行器回调。
- `electron-agent/electron/ipc/register.ts`：wiki 命令的 workspace 变为可选。
- `electron-agent/electron/main.ts`：装配 `WikiSyncService` 并注入 runtime。
- `electron-agent/src/lib/agentData.ts`：`WikiOverview` / `WikiSearchResult` 类型调整。
- `electron-agent/src/features/agentData/WikiPanel.tsx`：默认全局展示、项目筛选器、显示来源项目。

**创建：**
- `electron-agent/electron/app/wikiSyncService.ts`：Wiki 同步编排器（扫描 → 逐页生成 → 写入 → 推进 job）。

**测试：**
- `electron-agent/electron/agentData/wikiStore.test.ts`
- `electron-agent/electron/agentData/jobStore.test.ts`
- `electron-agent/electron/pi/systemWorkerManager.test.ts`
- `electron-agent/electron/app/wikiSyncService.test.ts`
- `electron-agent/src/features/agentData/WikiPanel.test.tsx`

### 阶段三：CodeGraph 项目选择 + 同步执行器 + 实例池

**修改：**
- `electron-agent/package.json`：新增 `@modelcontextprotocol/sdk` 依赖。
- `electron-agent/electron/agentData/runtime.ts`：`codeRetrieval.admin.*` / `codeRetrieval.search` 从占位改为委派注入的 provider。
- `electron-agent/electron/ipc/register.ts`：新增 `agentData_code_projects`。
- `electron-agent/electron/main.ts`：装配 `CodeGraphService`。
- `electron-agent/src/lib/agentData.ts`：新增 `code.projects()`，`CodeGraphStatus` 补字段。
- `electron-agent/src/features/agentData/CodeRetrievalPanel.tsx`：强制项目选择器 + 未索引态同步入口。

**创建：**
- `electron-agent/electron/app/codeGraph/indexProbe.ts`：`.codegraph` 目录探测。
- `electron-agent/electron/app/codeGraph/syncRunner.ts`：spawn `codegraph init|sync`，可取消。
- `electron-agent/electron/app/codeGraph/instancePool.ts`：MCP 子进程池（惰性加载 + 空闲超时）。
- `electron-agent/electron/app/codeGraph/codeGraphService.ts`：聚合以上三者，对 runtime 暴露统一接口。

**测试：**
- `electron-agent/electron/app/codeGraph/indexProbe.test.ts`
- `electron-agent/electron/app/codeGraph/syncRunner.test.ts`
- `electron-agent/electron/app/codeGraph/instancePool.test.ts`
- `electron-agent/src/features/agentData/CodeRetrievalPanel.test.tsx`

### 阶段四：面板整合与取消语义

**修改：**
- `electron-agent/src/features/agentData/AgentDataCenter.tsx`：概览默认全局；不再把 `activeWorkspace` 作为强制过滤条件下传。
- `electron-agent/src/features/workspace/ModuleContainer.tsx`：`AgentDataCenter` 的 workspace 改为"初始默认值"语义。
- `electron-agent/electron/agentData/runtime.ts`：`admin.jobs.cancel` 接入两类执行器的取消。

**测试：**
- `electron-agent/src/features/agentData/AgentDataCenter.test.tsx`
- `electron-agent/src/features/workspace/ModuleContainer.test.tsx`
- `electron-agent/electron/app/wikiSyncService.test.ts`（取消分支）
- `electron-agent/electron/app/codeGraph/syncRunner.test.ts`（取消分支）

---

## 阶段一：Memory 默认全局读取

### 任务 1：L2/L3 写入全局作用域

**背景：** `MemoryService.completeExtraction()` 目前把 L1/L2/L3 全部用同一个 `capture.scope`（project scope）写入。L2 是跨会话提炼的情景摘要、L3 是长期认知，它们不该被锁在产生它们的那个项目里。

**文件：**
- 修改：`electron-agent/electron/app/memoryService.ts:44-49`
- 测试：`electron-agent/electron/app/memoryService.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `memoryService.test.ts` 的 `describe('MemoryService', ...)` 内追加：

```ts
  it('writes L1 into the source project but L2/L3 into global scope', async () => {
    const { db, store, service } = setup();
    const capture = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: prefer dark mode', fingerprint: 'fp1' });

    service.completeExtraction(capture.taskId!, { l1: { preference: 'dark' }, l2: 'scenario text', l3: 'persona text' });

    const rows = db.prepare('SELECT level, memory_scope as scope, project_id as projectId FROM memories ORDER BY level').all() as Array<{ level: number; scope: string; projectId: string }>;
    expect(rows).toEqual([
      { level: 1, scope: 'project', projectId: 'project-A' },
      { level: 2, scope: 'global', projectId: 'project-A' },
      { level: 3, scope: 'global', projectId: 'project-A' },
    ]);

    // 另一个项目的作用域也能读到这两层（全局），但读不到 L1（项目私有）。
    const other = { userId: 'u', projectId: 'project-B', workspace: '/repo-b' };
    expect((await service.search({ ...other, query: 'scenario' })).map((r) => r.level)).toEqual([2]);
    expect(await service.search({ ...other, query: 'preference' })).toHaveLength(0);
    db.close();
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run electron/app/memoryService.test.ts -t "global scope"`

预期：FAIL。L2/L3 的 `scope` 实际为 `'project'`，且跨项目搜索 `scenario` 返回空数组。

- [ ] **步骤 3：编写最少实现代码**

`memoryService.ts` 的 `completeExtraction()` 里，把 L2/L3 两行的 scope 换成显式 global（L1 那行不动）：

```ts
    const globalScope = { ...capture.scope, scope: 'global' as const };
    if (extraction.l1 !== undefined) writes.push(this.options.store.upsert(capture.scope, { level: 1, content: JSON.stringify(extraction.l1), source: capture.source }));
    if (extraction.l2) writes.push(this.options.store.upsert(globalScope, { level: 2, content: extraction.l2, source: capture.source }));
    if (extraction.l3) writes.push(this.options.store.upsert(globalScope, { level: 3, content: extraction.l3, source: capture.source }));
```

`commitCapture` 仍用 `capture.scope`（游标是按 session 记的，与写入层级的作用域无关）。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run electron/app/memoryService.test.ts`

预期：PASS，全部 5 个用例通过（原有 4 个 + 新增 1 个）。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/memoryService.ts electron-agent/electron/app/memoryService.test.ts
git commit -m "feat(memory): L2/L3 写入全局作用域，L1 保留项目归属"
```

### 任务 2：删除操作按用户判权

**背景：** `MemoryStore.remove()` 的 SQL 是 `WHERE id=? AND user_id=? AND (workspace=? OR memory_scope='global')`。全局视图会列出其它项目的 L1 记录，删除它们时 workspace 不匹配 → 静默删不掉（DELETE 影响 0 行、不报错）。记录 id 本身已经是 `hash(userId:project:scope:session:fingerprint)`，加上 `user_id=?` 已经足够判权，workspace 条件没有额外安全价值。

**文件：**
- 修改：`electron-agent/electron/agentData/memoryStore.ts:104`
- 测试：`electron-agent/electron/agentData/memoryStore.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `memoryStore.test.ts` 的 `describe('MemoryStore', ...)` 内追加：

```ts
  it('removes a record owned by the user even when queried from another project scope', () => {
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    const recordInB = store.upsert({ userId: 'u', projectId: 'project-B', workspace: '/b' }, { level: 1, content: 'b fact' });

    // 全局视图停留在 project-A，却要删掉 project-B 的记录。
    store.remove({ userId: 'u', workspace: '/a' }, recordInB.id);

    expect(store.search({ userId: 'u', workspace: '/a', includeOtherProjects: true }, 'fact')).toHaveLength(0);
    db.close();
  });

  it('does not remove a record owned by a different user', () => {
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    const mine = store.upsert({ userId: 'u', workspace: '/a' }, { level: 1, content: 'mine' });

    store.remove({ userId: 'intruder', workspace: '/a' }, mine.id);

    expect(store.search({ userId: 'u', workspace: '/a' }, 'mine')).toHaveLength(1);
    db.close();
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run electron/agentData/memoryStore.test.ts -t "another project scope"`

预期：FAIL。第一个用例断言 0 条却拿到 1 条（记录没被删掉）。

- [ ] **步骤 3：编写最少实现代码**

`memoryStore.ts` 的 `remove()` 换成：

```ts
  remove(scope: MemoryScope, id: string): void {
    // id 已经是 hash(userId:project:memoryScope:session:fingerprint)，配合 user_id 足以判权。
    // 不再约束 workspace：全局视图会列出其它项目的记录，带 workspace 条件会导致删除静默失败。
    this.db.prepare('DELETE FROM memories WHERE id=? AND user_id=?').run(id, scope.userId);
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run electron/agentData/memoryStore.test.ts`

预期：PASS。注意 `stores project and global scope metadata` 这个既有用例偶发失败（同毫秒时间戳下 `ORDER BY updated_at DESC` 排序不稳定）与本改动无关，重跑即过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/memoryStore.ts electron-agent/electron/agentData/memoryStore.test.ts
git commit -m "fix(memory): 删除按用户判权，修复全局视图跨项目删除静默失败"
```

### 任务 3：只读 RPC 接受缺省 workspace

**背景：** `runtime.ts` 的 `readScope()` 用 `readString(value.workspace)` 强制要求非空 workspace。但全局视图没有"当前项目"可传，而 `MemoryStore.search()` / `overview()` 内部只用 `projectId(scope)`（= `scope.projectId ?? scope.workspace`）和 `includeOtherProjects`，从不直接读 `scope.workspace`。所以只读路径可以安全地接受缺省 workspace。写入路径（`memory.upsert` / `memory.capture` / `memory.delete`）仍要求 workspace，不改。

**文件：**
- 修改：`electron-agent/electron/agentData/runtime.ts:161-168`（`memoryMethod` 的 overview/search 分支）与文件末尾的 `readScope` 附近
- 测试：`electron-agent/electron/agentData/runtime.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `runtime.test.ts` 追加一个用例：

```ts
  it('answers memory overview and search globally when no workspace is supplied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-global-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db') });
    const client = new AgentDataClient(await runtime.start());

    await client.request('memory.upsert', { userId: 'u', workspace: '/repo-a', level: 1, content: 'alpha fact' });
    await client.request('memory.upsert', { userId: 'u', workspace: '/repo-b', level: 1, content: 'beta fact' });

    await expect(client.request('memory.admin.overview', { userId: 'u', includeOtherProjects: true }))
      .resolves.toMatchObject({ total: 2, byLevel: { L0: 0, L1: 2, L2: 0, L3: 0 } });
    await expect(client.request<Array<{ content: string }>>('memory.search', { userId: 'u', includeOtherProjects: true, query: 'fact', limit: 10 }))
      .resolves.toHaveLength(2);

    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run electron/agentData/runtime.test.ts -t "globally when no workspace"`

预期：FAIL，抛 `INVALID_PARAMS`（`string parameter is required`）。

- [ ] **步骤 3：编写最少实现代码**

在 `runtime.ts` 的 `readScope` 旁边新增只读版本：

```ts
/**
 * 只读查询作用域：workspace 可缺省（全局视图没有"当前项目"）。
 * MemoryStore.search/overview 只用 projectId(scope) 与 includeOtherProjects，不直接读 workspace，
 * 因此缺省时传 '' 是安全的；写入路径仍用 readScope 强制要求 workspace。
 */
function readQueryScope(value: Record<string, unknown>): import('./memoryStore').MemoryScope {
  return {
    userId: readString(value.userId),
    workspace: typeof value.workspace === 'string' && value.workspace.trim() ? value.workspace : '',
    projectId: value.projectId === undefined ? undefined : readString(value.projectId),
    sessionId: value.sessionId === undefined ? undefined : readString(value.sessionId),
    includeOtherProjects: value.includeOtherProjects === true,
  };
}
```

把 `memoryMethod` 里两个只读分支换成用它（注意 `memory.search` 原本强制用 `readString(params.workspace)` 兜 projectId，改为不再兜底，交给 `projectId(scope)` 自然回落）：

```ts
    if (name === 'memory.search') return (params) => this.memoryService!.search({ ...readQueryScope(params), projectId: typeof params.projectId === 'string' ? params.projectId : (typeof params.workspace === 'string' ? params.workspace : ''), query: readString(params.query), limit: typeof params.limit === 'number' ? params.limit : 20 });
    if (name === 'memory.admin.overview') return (params) => this.memory!.overview(readQueryScope(params));
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run electron/agentData/runtime.test.ts`

预期：PASS，含既有的 `routes memory extraction through the configured system task executor` 等用例全部不回归。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/runtime.ts electron-agent/electron/agentData/runtime.test.ts
git commit -m "feat(memory): 只读 RPC 接受缺省 workspace 以支持全局查询"
```

### 任务 4：IPC 与渲染层类型透出全局参数

**背景：** 渲染层 `MemoryScope` 类型只有 `{ userId, workspace, sessionId? }`，`register.ts` 的转发也只挑这三个字段，导致底层早已支持的 `includeOtherProjects` / `projectId` 在 UI 侧完全不可达。

**文件：**
- 修改：`electron-agent/electron/ipc/register.ts:141-146`（overview）、`:160-166`（search）、`:167-171`（delete）
- 修改：`electron-agent/src/lib/agentData.ts:7`（`MemoryScope`）、`:9`（`MemoryRecord`）
- 测试：`electron-agent/electron/ipc/register.test.ts`、`electron-agent/src/lib/agentData.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `register.test.ts` 的 `routes Agent Data module queries and job creation with explicit scope` 用例内追加：

```ts
    await expect(invoke({}, { command: 'agentData_memory_overview', args: { userId: 'u', includeOtherProjects: true } })).resolves.toEqual({
      method: 'memory.admin.overview', params: { userId: 'u', includeOtherProjects: true },
    });
    await expect(invoke({}, { command: 'agentData_memory_search', args: { userId: 'u', projectId: '/w', query: 'x', limit: 10 } })).resolves.toEqual({
      method: 'memory.search', params: { userId: 'u', projectId: '/w', query: 'x', limit: 10 },
    });
```

在 `src/lib/agentData.test.ts` 的 `exposes typed module queries and job creation` 用例内追加：

```ts
    await agentDataApi.memory.overview({ userId: 'u', includeOtherProjects: true });
    expect(spy).toHaveBeenLastCalledWith('agentData_memory_overview', { userId: 'u', includeOtherProjects: true });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run electron/ipc/register.test.ts src/lib/agentData.test.ts`

预期：FAIL。IPC 侧抛 `workspace must be a non-empty string`；渲染层侧 TypeScript 报 `includeOtherProjects` 不在 `MemoryScope` 上。

- [ ] **步骤 3：实现 IPC 转发**

`register.ts` 三个 memory 命令改成（`workspace` 可选、新增两个字段的条件转发）：

```ts
    registerCommand('agentData_memory_overview', (_event, args) => services.agentData!.request('memory.admin.overview', {
      userId: readString(args, 'userId'),
      ...(args.workspace === undefined ? {} : { workspace: readString(args, 'workspace') }),
      ...(args.projectId === undefined ? {} : { projectId: readString(args, 'projectId') }),
      ...(args.sessionId === undefined ? {} : { sessionId: readString(args, 'sessionId') }),
      ...(args.includeOtherProjects === true ? { includeOtherProjects: true } : {}),
    }));
```

```ts
    registerCommand('agentData_memory_search', (_event, args) => services.agentData!.request('memory.search', {
      userId: readString(args, 'userId'),
      ...(args.workspace === undefined ? {} : { workspace: readString(args, 'workspace') }),
      ...(args.projectId === undefined ? {} : { projectId: readString(args, 'projectId') }),
      ...(args.sessionId === undefined ? {} : { sessionId: readString(args, 'sessionId') }),
      ...(args.includeOtherProjects === true ? { includeOtherProjects: true } : {}),
      query: readString(args, 'query'),
      limit: readPositiveInteger(args, 'limit', 50),
    }));
```

`agentData_memory_delete` 保持要求 `workspace`（`memory.delete` 走写入路径的 `readScope`），不改。

- [ ] **步骤 4：实现渲染层类型**

`src/lib/agentData.ts`：

```ts
export interface MemoryScope { userId: string; workspace?: string; projectId?: string; sessionId?: string; includeOtherProjects?: boolean }
export interface MemoryRecord { id: string; level: 0 | 1 | 2 | 3; content: string; source?: string; sourceProjectId?: string; scope?: 'global' | 'project'; createdAt: number; updatedAt: number }
```

`memory.delete` 的入参类型改为显式要求 workspace：

```ts
    delete: (scope: { userId: string; workspace: string }, id: string) => invoke<void>('agentData_memory_delete', { ...scope, id }),
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd electron-agent; npx vitest run electron/ipc/register.test.ts src/lib/agentData.test.ts electron/ipc/commandCoverage.test.ts`

预期：PASS，命令覆盖测试不变（没有新增/删除命令名）。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/ipc/register.ts electron-agent/electron/ipc/register.test.ts electron-agent/src/lib/agentData.ts electron-agent/src/lib/agentData.test.ts
git commit -m "feat(memory): IPC 与渲染层类型透出 projectId/includeOtherProjects"
```

### 任务 5：项目选项 hook

**背景：** Memory / Wiki / Code 三个面板都需要一个"项目下拉选项"数据源。侧边栏已有 `useProjectGroups()`（聚合 `registeredProjects` + 有会话的 cwd，排除 works 临时目录），但它带了置顶/隐藏/关键字过滤等侧栏语义，直接复用会让面板受侧栏搜索框影响。抽一个只做"路径 + 显示名"的轻量 hook。

**文件：**
- 创建：`electron-agent/src/features/agentData/useProjectOptions.ts`
- 测试：`electron-agent/src/features/agentData/useProjectOptions.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `useProjectOptions.test.ts`：

```ts
// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectOptions } from './useProjectOptions';
import { useSessionStore } from '../../store';

beforeEach(() => {
  useSessionStore.setState({
    allSessions: [
      { id: '1', path: '/s/1.jsonl', cwd: 'D:/proj/alpha', timestamp: '2026-09-01T00:00:00Z', name: null },
      { id: '2', path: '/s/2.jsonl', cwd: 'D:/home/.pi/agent/works/abc', timestamp: '2026-09-02T00:00:00Z', name: null },
    ],
    optimisticSessions: [],
    deletedSessionPaths: [],
    registeredProjects: ['D:/proj/beta'],
    worksDir: 'D:/home/.pi/agent/works',
    activeWorkspace: 'D:/proj/alpha',
  });
});

describe('useProjectOptions', () => {
  it('lists project cwds with display names and excludes scratch conversations', () => {
    const { result } = renderHook(() => useProjectOptions());
    expect(result.current).toEqual([
      { cwd: 'D:/proj/alpha', name: 'alpha' },
      { cwd: 'D:/proj/beta', name: 'beta' },
    ]);
  });

  it('includes the active workspace even when it has no session yet', () => {
    useSessionStore.setState({ activeWorkspace: 'D:/proj/gamma' });
    const { result } = renderHook(() => useProjectOptions());
    expect(result.current.map((option) => option.cwd)).toContain('D:/proj/gamma');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run src/features/agentData/useProjectOptions.test.ts`

预期：FAIL，模块 `./useProjectOptions` 不存在。

- [ ] **步骤 3：编写实现**

创建 `electron-agent/src/features/agentData/useProjectOptions.ts`：

```ts
import { useMemo } from 'react';
import { useSessionStore } from '../../store';
import { isUnder, pathsEquivalent } from '../../lib/pathUtils';

export interface ProjectOption { cwd: string; name: string }

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

/**
 * Agent 数据面板的项目下拉选项：仅"路径 + 显示名"，按路径排序。
 * 刻意不复用 useProjectGroups——后者带侧栏的置顶/隐藏/关键字过滤语义，
 * 面板的筛选器不应该被侧栏搜索框影响。
 */
export function useProjectOptions(): ProjectOption[] {
  const allSessions = useSessionStore((state) => state.allSessions);
  const registeredProjects = useSessionStore((state) => state.registeredProjects);
  const activeWorkspace = useSessionStore((state) => state.activeWorkspace);
  const worksDir = useSessionStore((state) => state.worksDir);

  return useMemo(() => {
    const candidates = [
      ...allSessions.map((session) => session.cwd ?? ''),
      ...registeredProjects,
      activeWorkspace,
    ].filter((cwd) => cwd && !(worksDir && isUnder(cwd, worksDir)));

    const unique: string[] = [];
    for (const cwd of candidates) {
      if (!unique.some((existing) => pathsEquivalent(existing, cwd))) unique.push(cwd);
    }
    return unique.sort((a, b) => a.localeCompare(b)).map((cwd) => ({ cwd, name: basename(cwd) }));
  }, [allSessions, registeredProjects, activeWorkspace, worksDir]);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run src/features/agentData/useProjectOptions.test.ts`

预期：PASS，2 个用例通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/agentData/useProjectOptions.ts electron-agent/src/features/agentData/useProjectOptions.test.ts
git commit -m "feat(agent-data): 新增面板项目选项 hook"
```

### 任务 6：MemoryPanel 默认全局 + 项目筛选器

**背景：** `MemoryPanel` 现在 `if (!userId || !workspace) { setLoading(false); return; }` 直接罢工，且 useEffect 依赖 `workspace` → 切对话即重查。改成默认全局、workspace 只作为可选筛选。

**文件：**
- 修改：`electron-agent/src/features/agentData/MemoryPanel.tsx`
- 测试：`electron-agent/src/features/agentData/MemoryPanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

把 `MemoryPanel.test.tsx` 整体替换为：

```tsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPanel } from './MemoryPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { memory: { overview: vi.fn(), search: vi.fn(), delete: vi.fn() } },
}));
vi.mock('./useProjectOptions', () => ({
  useProjectOptions: () => [{ cwd: 'D:/proj/alpha', name: 'alpha' }, { cwd: 'D:/proj/beta', name: 'beta' }],
}));
import { agentDataApi } from '../../lib/agentData';

describe('MemoryPanel', () => {
  beforeEach(() => {
    vi.mocked(agentDataApi.memory.overview).mockResolvedValue({ total: 1, byLevel: { L0: 1, L1: 0, L2: 0, L3: 0 } });
    vi.mocked(agentDataApi.memory.search).mockResolvedValue([{
      id: 'memory-1', level: 2, content: 'Electron 版统一使用 TypeScript Agent Data Runtime',
      source: 'session:s1', scope: 'global', createdAt: 1, updatedAt: 2,
    }]);
  });

  it('queries every project by default without requiring a workspace', async () => {
    render(<MemoryPanel userId="u" />);
    await waitFor(() => expect(agentDataApi.memory.overview).toHaveBeenCalledWith({ userId: 'u', includeOtherProjects: true }));
    fireEvent.change(screen.getByLabelText('搜索记忆'), { target: { value: 'TypeScript' } });
    expect(await screen.findByText('Electron 版统一使用 TypeScript Agent Data Runtime')).toBeTruthy();
    expect(agentDataApi.memory.search).toHaveBeenCalledWith({ userId: 'u', includeOtherProjects: true }, 'TypeScript', 50);
  });

  it('narrows the query to one project when the filter is set', async () => {
    render(<MemoryPanel userId="u" />);
    fireEvent.change(screen.getByLabelText('项目范围'), { target: { value: 'D:/proj/beta' } });
    await waitFor(() => expect(agentDataApi.memory.overview).toHaveBeenLastCalledWith({ userId: 'u', projectId: 'D:/proj/beta' }));
  });

  it('keeps the panel filter when the initial workspace prop changes', async () => {
    const { rerender } = render(<MemoryPanel userId="u" initialProject="D:/proj/alpha" />);
    await waitFor(() => expect(agentDataApi.memory.overview).toHaveBeenLastCalledWith({ userId: 'u', projectId: 'D:/proj/alpha' }));
    fireEvent.change(screen.getByLabelText('项目范围'), { target: { value: '' } });
    await waitFor(() => expect(agentDataApi.memory.overview).toHaveBeenLastCalledWith({ userId: 'u', includeOtherProjects: true }));

    rerender(<MemoryPanel userId="u" initialProject="D:/proj/beta" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agentDataApi.memory.overview).toHaveBeenLastCalledWith({ userId: 'u', includeOtherProjects: true });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run src/features/agentData/MemoryPanel.test.tsx`

预期：FAIL。当前组件缺少 `workspace` 时不发请求，也没有"项目范围"下拉。

- [ ] **步骤 3：编写实现**

把 `MemoryPanel.tsx` 替换为：

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Search, Trash2 } from 'lucide-react';
import { agentDataApi, type MemoryOverview, type MemoryRecord, type MemoryScope } from '../../lib/agentData';
import { styles } from './agentDataStyles';
import { useProjectOptions } from './useProjectOptions';

interface MemoryPanelProps {
  userId?: string;
  /** 仅作为筛选器的初始值；用户手动切换后不再跟随其变化。 */
  initialProject?: string;
}

export function MemoryPanel({ userId, initialProject }: MemoryPanelProps) {
  const projects = useProjectOptions();
  const [project, setProject] = useState<string>(initialProject ?? '');
  const [overview, setOverview] = useState<MemoryOverview>();
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<'all' | '0' | '1' | '2' | '3'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // project 为空 = 全局：用 includeOtherProjects 让底层放开项目边界。
  const scope: MemoryScope | undefined = useMemo(
    () => (userId ? (project ? { userId, projectId: project } : { userId, includeOtherProjects: true }) : undefined),
    [userId, project],
  );

  useEffect(() => {
    if (!scope) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void agentDataApi.memory.overview(scope)
      .then((value) => { if (!cancelled) setOverview(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope]);

  useEffect(() => {
    if (!scope || !query.trim()) { setRecords([]); return; }
    let cancelled = false;
    void agentDataApi.memory.search(scope, query.trim(), 50)
      .then((value) => { if (!cancelled) setRecords(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [scope, query]);

  const visible = useMemo(() => records.filter((record) => level === 'all' || record.level === Number(level)), [records, level]);

  const remove = async (record: MemoryRecord) => {
    if (!userId || !window.confirm('确认删除这条记忆？')) return;
    // 删除走写入路径，必须带 workspace：全局条目用 '.' 占位，项目条目用其来源项目。
    const workspace = record.sourceProjectId ?? project ?? '.';
    try {
      await agentDataApi.memory.delete({ userId, workspace: workspace || '.' }, record.id);
      setRecords((current) => current.filter((item) => item.id !== record.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const scopeLabel = project ? projects.find((option) => option.cwd === project)?.name ?? project : '全部项目';

  return <section data-testid="memory-panel">
    <div className={styles.sectionHeading}><h3 className={styles.heading}>Memory L0-L3</h3><span className={styles.hint}>{overview?.total ?? '-'} 条 · {scopeLabel}</span></div>
    <div className={styles.toolbar}>
      <div className={styles.input} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Search size={13} />
        <input aria-label="搜索记忆" placeholder="搜索记忆内容" value={query} onChange={(event) => setQuery(event.target.value)} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'inherit' }} />
      </div>
      <select className={styles.select} aria-label="项目范围" value={project} onChange={(event) => setProject(event.target.value)}>
        <option value="">全部项目</option>
        {projects.map((option) => <option key={option.cwd} value={option.cwd}>{option.name}</option>)}
      </select>
      <select className={styles.select} aria-label="记忆层级" value={level} onChange={(event) => setLevel(event.target.value as typeof level)}>
        <option value="all">全部层级</option>
        <option value="0">L0 对话</option>
        <option value="1">L1 原子</option>
        <option value="2">L2 场景</option>
        <option value="3">L3 画像</option>
      </select>
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {loading ? <div className={styles.state}>正在加载 Memory...</div>
      : !userId ? <div className={styles.state}>未绑定用户</div>
      : visible.length === 0 ? <div className={styles.state}>{query ? '暂无匹配记忆' : '输入关键词搜索记忆'}</div>
      : <table className={styles.table}>
        <thead><tr><th>层级</th><th>内容</th><th>来源</th><th>归属</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>{visible.map((record) => <tr key={record.id}>
          <td>L{record.level}</td>
          <td>{record.content}</td>
          <td>{record.source ?? '未记录'}</td>
          <td>{record.scope === 'global' ? '全局' : record.sourceProjectId ?? '未记录'}</td>
          <td>{new Date(record.updatedAt).toLocaleString()}</td>
          <td><button type="button" className={styles.actionButton} aria-label="删除" onClick={() => void remove(record)}><Trash2 size={12} />删除</button></td>
        </tr>)}</tbody>
      </table>}
  </section>;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run src/features/agentData/MemoryPanel.test.tsx`

预期：PASS，3 个用例通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/agentData/MemoryPanel.tsx electron-agent/src/features/agentData/MemoryPanel.test.tsx
git commit -m "feat(memory): 面板默认全局展示并新增项目筛选器"
```

---

## 阶段二：Wiki 默认全局读取 + 同步执行器

### 任务 7：WikiStore 支持全局查询

**背景：** `WikiStore.search()` 的 SQL 写死 `WHERE f.workspace=?`，`overview()` 写死 `WHERE workspace=?`，没有全局选项。`PRIMARY KEY(workspace, page)` 保持不变（不同项目的同名页面不能互相覆盖），只放开查询边界，并把 `workspace` 加进搜索结果供 UI 显示来源。

**文件：**
- 修改：`electron-agent/electron/agentData/wikiStore.ts:4`（`WikiScope`）、`:27`（`search`）、`:32`（`overview`）
- 测试：`electron-agent/electron/agentData/wikiStore.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `wikiStore.test.ts` 的 `describe('WikiStore', ...)` 内追加：

```ts
  it('searches every workspace when no workspace is supplied and reports each page origin', () => {
    const db = new DatabaseSync(':memory:'); const store = new WikiStore(db);
    store.replacePage({ workspace: '/a' }, 'guide', 'Guide A', '# API\nsearchable alpha');
    store.replacePage({ workspace: '/b' }, 'guide', 'Guide B', '# API\nsearchable beta');

    const all = store.search({}, 'searchable');
    expect(all).toHaveLength(2);
    expect(all.map((row) => row.workspace).sort()).toEqual(['/a', '/b']);
    expect(store.search({ workspace: '/a' }, 'searchable')).toHaveLength(1);
    db.close();
  });

  it('aggregates the overview across every workspace when scoped globally', () => {
    const db = new DatabaseSync(':memory:'); const store = new WikiStore(db);
    store.replacePage({ workspace: '/a' }, 'one', 'One', 'body');
    store.replacePage({ workspace: '/b' }, 'two', 'Two', 'body');

    expect(store.overview({})).toMatchObject({ pages: 2 });
    expect(store.overview({ workspace: '/a' })).toMatchObject({ pages: 1 });
    db.close();
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run electron/agentData/wikiStore.test.ts`

预期：FAIL。TypeScript 报 `{}` 不满足 `WikiScope`（缺 `workspace`）。

- [ ] **步骤 3：编写实现**

`wikiStore.ts` 改三处。类型与返回值：

```ts
/** 查询作用域：workspace 缺省表示跨全部项目（写入路径仍必须给定 workspace）。 */
export interface WikiScope { workspace?: string }
export interface WikiWriteScope { workspace: string }
export interface WikiSearchHit { workspace: string; page: string; title: string; snippet: string; sourcePath: string; chunks: number }
```

`replacePage` / `deleteWorkspace` 的参数类型换成 `WikiWriteScope`（内部实现不变）。`search`：

```ts
  search(scope: WikiScope, query: string, limit = 20): WikiSearchHit[] {
    const bounded = Math.max(1, Math.min(limit, 100));
    const select = "SELECT f.workspace,f.page,f.title,snippet(wiki_fts,3,'', '', '...', 24) as snippet,p.source_path as sourcePath,p.content FROM wiki_fts f JOIN wiki_pages p ON p.workspace=f.workspace AND p.page=f.page";
    const rows = (scope.workspace
      ? this.db.prepare(`${select} WHERE f.workspace=? AND wiki_fts MATCH ? LIMIT ?`).all(scope.workspace, query.trim(), bounded)
      : this.db.prepare(`${select} WHERE wiki_fts MATCH ? LIMIT ?`).all(query.trim(), bounded)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      workspace: String(row.workspace),
      page: String(row.page),
      title: String(row.title),
      snippet: String(row.snippet),
      sourcePath: String(row.sourcePath),
      chunks: chunkMarkdown(String(row.content), String(row.sourcePath), String(row.title)).length,
    }));
  }
```

`overview`：

```ts
  overview(scope: WikiScope): WikiOverview {
    const row = (scope.workspace
      ? this.db.prepare('SELECT count(*) as pages, max(updated_at) as latestUpdatedAt FROM wiki_pages WHERE workspace=?').get(scope.workspace)
      : this.db.prepare('SELECT count(*) as pages, max(updated_at) as latestUpdatedAt FROM wiki_pages').get()) as { pages: number; latestUpdatedAt: number | null };
    return { pages: Number(row.pages), latestUpdatedAt: row.latestUpdatedAt == null ? null : Number(row.latestUpdatedAt) };
  }
```

- [ ] **步骤 4：更新 runtime 与 IPC 的 workspace 可选性**

`runtime.ts` 的 `wikiMethod` 两个只读分支：

```ts
    if (name === 'wiki.search') return (params) => this.wiki!.search(readWikiQueryScope(params), readString(params.query), typeof params.limit === 'number' ? params.limit : 20);
    if (name === 'wiki.admin.overview') return (params) => this.wiki!.overview(readWikiQueryScope(params));
```

在文件末尾的辅助函数区新增：

```ts
function readWikiQueryScope(value: Record<string, unknown>): import('./wikiStore').WikiScope {
  return typeof value.workspace === 'string' && value.workspace.trim() ? { workspace: value.workspace } : {};
}
```

`register.ts` 两个 wiki 命令的 workspace 改为可选：

```ts
    registerCommand('agentData_wiki_overview', (_event, args) => services.agentData!.request('wiki.admin.overview', {
      ...(args.workspace === undefined ? {} : { workspace: readString(args, 'workspace') }),
    }));
    registerCommand('agentData_wiki_search', (_event, args) => services.agentData!.request('wiki.search', {
      ...(args.workspace === undefined ? {} : { workspace: readString(args, 'workspace') }),
      query: readString(args, 'query'),
      limit: readPositiveInteger(args, 'limit', 50),
    }));
```

`src/lib/agentData.ts` 对应调整：

```ts
export interface WikiSearchResult { workspace: string; page: string; title: string; snippet: string; sourcePath: string; chunks: number }
```

```ts
  wiki: {
    overview: (workspace?: string) => invoke<WikiOverview>('agentData_wiki_overview', workspace === undefined ? {} : { workspace }),
    search: (workspace: string | undefined, query: string, limit = 50) => invoke<WikiSearchResult[]>('agentData_wiki_search', { ...(workspace === undefined ? {} : { workspace }), query, limit }),
  },
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd electron-agent; npx vitest run electron/agentData/wikiStore.test.ts electron/agentData/runtime.test.ts electron/ipc/register.test.ts src/lib/agentData.test.ts`

预期：PASS。`runtime.test.ts` 里既有的 `wiki.admin.overview` 断言（带 workspace）仍成立；`agentData.test.ts` 里 `agentDataApi.wiki.overview('/w')` 的断言仍是 `{ workspace: '/w' }`。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/agentData/wikiStore.ts electron-agent/electron/agentData/wikiStore.test.ts electron-agent/electron/agentData/runtime.ts electron-agent/electron/ipc/register.ts electron-agent/src/lib/agentData.ts
git commit -m "feat(wiki): 查询支持全局作用域并返回页面来源项目"
```

### 任务 8：JobStore 状态推进方法

**背景：** `JobStore` 只有 `create` / `get` / `list` / `cancel`，没有任何把 job 从 `pending` 推进到 `running` / `completed` / `failed` 的方法，也没有更新 `progress` 的入口。执行器要落地必须先补这些。另外需要 `hasActive()` 供 CodeGraph 同步做并发拒绝（避免两个 `codegraph sync` 子进程并发写同一个 `.codegraph/codegraph.db`）。

**文件：**
- 修改：`electron-agent/electron/agentData/jobStore.ts`
- 测试：`electron-agent/electron/agentData/jobStore.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `jobStore.test.ts` 追加：

```ts
  it('advances a job through running, progress, and completion', () => {
    const db = new DatabaseSync(':memory:');
    const store = new JobStore(db);
    const job = store.create({ kind: 'wiki.sync', workspace: '/repo' });

    expect(store.start(job.id)).toMatchObject({ state: 'running', progress: 0 });
    expect(store.progress(job.id, 40)).toMatchObject({ state: 'running', progress: 40 });
    expect(store.progress(job.id, 999)).toMatchObject({ progress: 100 });
    expect(store.complete(job.id)).toMatchObject({ state: 'completed', progress: 100 });
    db.close();
  });

  it('records a failure reason and refuses to advance a cancelled job', () => {
    const db = new DatabaseSync(':memory:');
    const store = new JobStore(db);
    const failing = store.create({ kind: 'codegraph.sync', workspace: '/repo' });
    store.start(failing.id);
    expect(store.fail(failing.id, 'codegraph exited with 1')).toMatchObject({ state: 'failed', error: 'codegraph exited with 1' });

    const cancelled = store.create({ kind: 'codegraph.sync', workspace: '/other' });
    store.cancel(cancelled.id);
    expect(store.start(cancelled.id)).toMatchObject({ state: 'cancelled' });
    expect(store.progress(cancelled.id, 50)).toMatchObject({ state: 'cancelled', progress: 0 });
    db.close();
  });

  it('reports whether a workspace already has an active job of a kind', () => {
    const db = new DatabaseSync(':memory:');
    const store = new JobStore(db);
    const job = store.create({ kind: 'codegraph.sync', workspace: '/repo' });

    expect(store.hasActive('codegraph.sync', '/repo')).toBe(true);
    expect(store.hasActive('codegraph.sync', '/other')).toBe(false);
    expect(store.hasActive('wiki.sync', '/repo')).toBe(false);
    store.complete(job.id);
    expect(store.hasActive('codegraph.sync', '/repo')).toBe(false);
    db.close();
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run electron/agentData/jobStore.test.ts`

预期：FAIL，`store.start is not a function`。

- [ ] **步骤 3：编写实现**

在 `jobStore.ts` 的 `cancel()` 之后插入：

```ts
  /** pending → running。已取消/已结束的 job 不再推进，原样返回。 */
  start(id: string): Job | undefined {
    this.db.prepare("UPDATE agent_jobs SET state='running',updated_at=? WHERE id=? AND state='pending'").run(Date.now(), id);
    return this.get(id);
  }

  /** 更新进度（clamp 到 0..100）。仅对 running 生效，避免给已取消的 job 写进度。 */
  progress(id: string, value: number): Job | undefined {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    this.db.prepare("UPDATE agent_jobs SET progress=?,updated_at=? WHERE id=? AND state='running'").run(clamped, Date.now(), id);
    return this.get(id);
  }

  complete(id: string): Job | undefined {
    this.db.prepare("UPDATE agent_jobs SET state='completed',progress=100,updated_at=? WHERE id=? AND state IN ('pending','running')").run(Date.now(), id);
    this.record('job.complete', { id });
    return this.get(id);
  }

  fail(id: string, error: string): Job | undefined {
    this.db.prepare("UPDATE agent_jobs SET state='failed',error=?,updated_at=? WHERE id=? AND state IN ('pending','running')").run(error.slice(0, 2000), Date.now(), id);
    this.record('job.fail', { id, error: error.slice(0, 200) });
    return this.get(id);
  }

  /** 该 workspace 是否已有同 kind 的未结束 job（供并发拒绝）。 */
  hasActive(kind: string, workspace: string): boolean {
    const row = this.db.prepare("SELECT count(*) as count FROM agent_jobs WHERE kind=? AND workspace=? AND state IN ('pending','running')").get(kind, workspace) as { count: number };
    return Number(row.count) > 0;
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run electron/agentData/jobStore.test.ts`

预期：PASS，4 个用例（原有 1 个 + 新增 3 个）。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agentData/jobStore.ts electron-agent/electron/agentData/jobStore.test.ts
git commit -m "feat(jobs): 新增 job 状态推进与并发查询方法"
```

### 任务 9：系统 worker 支持文本输出的 wiki 页面生成

**背景：** `SystemWorkerManager` 拉起的 pi 子进程带 `PI_SYSTEM_WORKER=1`，`cli/src/runtime.ts` 会让它加载零扩展 —— 所以系统 worker 里没有任何工具可调，只能收发文本 prompt。`serviceTaskPrompt()` 目前对非 `memory_extract` 的 kind 统一要求"返回严格 JSON"，`parseWorkerOutput()` 也无条件 `JSON.parse`。Wiki 页面是 Markdown 文本，需要一个不走 JSON 的分支。

**文件：**
- 修改：`electron-agent/electron/pi/systemWorkerManager.ts`
- 测试：`electron-agent/electron/pi/systemWorkerManager.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `systemWorkerManager.test.ts` 追加：

```ts
  it('asks for markdown and returns raw text for wiki page generation', async () => {
    let handlers: PiProcessOptions | undefined;
    const client = { send: vi.fn(async () => undefined), respondUi: vi.fn(), close: vi.fn() };
    const manager = new SystemWorkerManager({
      processCommand: { command: 'pi', args: ['--mode', 'rpc'] },
      createClient: vi.fn((_key, _command, options) => { handlers = options; return client as never; }),
    });

    const running = manager.run({ id: 'wiki', kind: 'wiki_page_generate', input: { sourcePath: 'README.md', source: '# Source' } });
    await vi.waitFor(() => expect(client.send).toHaveBeenCalled());
    handlers?.onEvent?.('__system__', { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: '# Generated\n\nBody' }] }] });

    await expect(running).resolves.toBe('# Generated\n\nBody');
    const prompt = String(client.send.mock.calls[0][0].message);
    expect(prompt).toContain('Markdown');
    expect(prompt).not.toContain('JSON only');
  });

  it('still parses JSON for memory extraction after adding text kinds', async () => {
    let handlers: PiProcessOptions | undefined;
    const client = { send: vi.fn(async () => undefined), respondUi: vi.fn(), close: vi.fn() };
    const manager = new SystemWorkerManager({
      processCommand: { command: 'pi', args: ['--mode', 'rpc'] },
      createClient: vi.fn((_key, _command, options) => { handlers = options; return client as never; }),
    });

    const running = manager.run({ id: 'memory', kind: 'memory_extract', input: { delta: 'x' } });
    await vi.waitFor(() => expect(client.send).toHaveBeenCalled());
    handlers?.onEvent?.('__system__', { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: '{"l1":{"a":1}}' }] }] });

    await expect(running).resolves.toEqual({ l1: { a: 1 } });
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run electron/pi/systemWorkerManager.test.ts`

预期：FAIL。`wiki_page_generate` 的结果被 `JSON.parse` 拒绝，抛 `system Pi returned invalid JSON`。

- [ ] **步骤 3：编写实现**

`systemWorkerManager.ts` 顶部（`SystemWorkerTask` 之后）加一个 kind 白名单和 prompt 表：

```ts
/** 输出为纯文本（而非 JSON）的任务 kind：结果原样回传，不做 JSON 解析。 */
const TEXT_OUTPUT_KINDS = new Set(['wiki_page_generate']);

/** 各 kind 的指令。未列出的 kind 统一要求返回严格 JSON 对象。 */
const KIND_INSTRUCTIONS: Record<string, string> = {
  memory_extract: 'Extract durable memory as strict JSON with optional keys l1 (object), l2 (string), and l3 (string). Return JSON only.',
  // 与 extensions/wiki-rag/sync.ts 的 SYSTEM 文案保持一致：输出必须是可直接落盘的 Markdown。
  wiki_page_generate: 'Write a concise Markdown knowledge page from the supplied source. Preserve important names, behavior, and references. Return Markdown only.',
};
```

`serviceTaskPrompt()` 换成：

```ts
function serviceTaskPrompt(task: SystemWorkerTask): string {
  const instruction = KIND_INSTRUCTIONS[task.kind] ?? 'Complete the service task and return a strict JSON object only.';
  return `${instruction}\nTask kind: ${task.kind}\nInput: ${JSON.stringify(task.input)}`;
}
```

`parseWorkerOutput()` 增加 kind 参数：

```ts
function parseWorkerOutput(value: unknown, kind?: string): unknown {
  if (!Array.isArray(value)) throw new Error('system Pi returned no messages');
  const assistant = [...value].reverse().find((message) => isRecord(message) && message.role === 'assistant');
  if (!assistant || !Array.isArray(assistant.content)) throw new Error('system Pi returned no assistant output');
  const text = assistant.content.filter(isRecord).filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('').trim();
  if (kind && TEXT_OUTPUT_KINDS.has(kind)) {
    if (!text) throw new Error('system Pi returned empty text');
    return text;
  }
  const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(json); } catch { throw new Error('system Pi returned invalid JSON'); }
}
```

类内记录当前任务 kind（`private current?: string;` 声明旁边加一行），并在 `run()` 设置、在 `handleEvent()` 使用：

```ts
  private currentKind?: string;
```

`run()` 的循环里，把 `this.current = task.id;` 改成：

```ts
      state.attempts += 1; state.status = 'running'; this.current = task.id; this.currentKind = task.kind;
```

`handleEvent()` 里的解析调用改成：

```ts
      const value = parseWorkerOutput(event.messages, this.currentKind);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run electron/pi/systemWorkerManager.test.ts`

预期：PASS，5 个用例（原有 3 个 + 新增 2 个）全部通过。

- [ ] **步骤 5：注册任务定义**

`electron/app/appServer/serviceTaskRegistry.ts` 的 `BUILTIN_SERVICE_TASKS` 追加一条（Wiki 页面生成可能比记忆抽取慢，超时给 60 秒）：

```ts
  { kind: 'wiki_page_generate', inputSchema: anyObject, outputSchema: z.custom<unknown>(() => true), timeoutMs: 60_000, maxAttempts: 2, capabilities: ['llm_completion'] },
```

注意 `outputSchema` 不能用 `anyObject`：这个 kind 的输出是字符串，`z.record` 会校验失败。

- [ ] **步骤 6：运行测试验证注册表通过**

运行：`cd electron-agent; npx vitest run electron/app/appServer/serviceTaskRegistry.test.ts electron/app/appServer/taskQueue.test.ts`

预期：PASS，既有注册表测试不回归。

- [ ] **步骤 7：Commit**

```bash
git add electron-agent/electron/pi/systemWorkerManager.ts electron-agent/electron/pi/systemWorkerManager.test.ts electron-agent/electron/app/appServer/serviceTaskRegistry.ts
git commit -m "feat(worker): 新增 wiki_page_generate 文本输出任务 kind"
```

### 任务 10：WikiSyncService 编排器

**背景：** `wiki.sync` job 现在创建后无人消费。这个编排器负责整条链路：扫描工作区 Markdown → 逐个文件请求系统 worker 生成页面 → 写入 `wiki.replace` → 推进 job 进度。全部依赖通过构造函数注入，便于在不 spawn 任何进程的前提下单测。

取消是协作式的：编排器持有一个 `cancelled` 集合，取消时置位；文件循环在处理下一个文件前检查，命中则不再继续并把 job 落定为 `cancelled`。当前正在生成的那个文件允许自然完成（或触发 `wiki_page_generate` 已有的 60 秒超时），不强杀。

**文件：**
- 创建：`electron-agent/electron/app/wikiSyncService.ts`
- 测试：`electron-agent/electron/app/wikiSyncService.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/app/wikiSyncService.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { WikiSyncService, scanWorkspaceMarkdown, type WikiSyncPageInput, type WikiSyncServiceOptions } from './wikiSyncService';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function deps(overrides: Partial<WikiSyncServiceOptions> = {}) {
  const jobs = {
    start: vi.fn(),
    progress: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    markCancelled: vi.fn(),
    cancelled: vi.fn<(id: string) => boolean>(() => false),
  };
  const writes: WikiSyncPageInput[] = [];
  const service = new WikiSyncService({
    jobs,
    scan: vi.fn(async () => ['README.md', 'docs/guide.md']),
    readSource: vi.fn(async (_workspace: string, path: string) => `# source of ${path}`),
    generate: vi.fn(async (source: string) => `# generated from ${source}`),
    writePage: vi.fn(async (input: WikiSyncPageInput) => { writes.push(input); }),
    ...overrides,
  });
  return { service, jobs, writes };
}

describe('WikiSyncService', () => {
  it('generates one page per markdown file and advances job progress', async () => {
    const { service, jobs, writes } = deps();

    await service.run('job-1', '/repo');

    expect(jobs.start).toHaveBeenCalledWith('job-1');
    expect(writes).toEqual([
      { workspace: '/repo', page: 'README.md', title: 'README', content: '# generated from # source of README.md', sourcePath: 'README.md' },
      { workspace: '/repo', page: 'docs/guide.md', title: 'guide', content: '# generated from # source of docs/guide.md', sourcePath: 'docs/guide.md' },
    ]);
    expect(jobs.progress.mock.calls).toEqual([['job-1', 50], ['job-1', 100]]);
    expect(jobs.complete).toHaveBeenCalledWith('job-1');
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it('completes immediately when the workspace has no markdown', async () => {
    const { service, jobs, writes } = deps({ scan: vi.fn(async () => []) });

    await service.run('job-1', '/repo');

    expect(writes).toEqual([]);
    expect(jobs.complete).toHaveBeenCalledWith('job-1');
  });

  it('fails the job and keeps earlier pages when one file cannot be generated', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('# ok')
      .mockRejectedValueOnce(new Error('model offline'));
    const { service, jobs, writes } = deps({ generate });

    await service.run('job-1', '/repo');

    expect(writes).toHaveLength(1);
    expect(jobs.fail).toHaveBeenCalledWith('job-1', expect.stringContaining('model offline'));
    expect(jobs.complete).not.toHaveBeenCalled();
  });

  it('stops before the next file once the job is cancelled and marks it cancelled', async () => {
    const { service, jobs, writes } = deps();
    jobs.cancelled.mockImplementation(() => writes.length >= 1);

    await service.run('job-1', '/repo');

    expect(writes).toHaveLength(1);
    expect(jobs.markCancelled).toHaveBeenCalledWith('job-1');
    expect(jobs.complete).not.toHaveBeenCalled();
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it('never writes a page after cancellation was requested mid-generation', async () => {
    // 取消发生在第一个文件"已生成、未写入"的窗口内：这一页也不能落盘，
    // 否则会出现"状态已取消但仍在写文件"的竞态。
    let cancelled = false;
    const { service, jobs, writes } = deps({
      generate: vi.fn(async (source: string) => { cancelled = true; return `# generated from ${source}`; }),
    });
    jobs.cancelled.mockImplementation(() => cancelled);

    await service.run('job-1', '/repo');

    expect(writes).toHaveLength(0);
    expect(jobs.markCancelled).toHaveBeenCalledWith('job-1');
  });
});

describe('scanWorkspaceMarkdown', () => {
  it('lists markdown recursively and skips runtime directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wiki-sync-scan-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# Readme');
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide');
    await writeFile(join(root, 'node_modules', 'pkg', 'ignored.md'), '# Ignored');
    await writeFile(join(root, '.git', 'ignored.md'), '# Ignored');

    await expect(scanWorkspaceMarkdown(root)).resolves.toEqual(['README.md', 'docs/guide.md']);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run electron/app/wikiSyncService.test.ts`

预期：FAIL，模块 `./wikiSyncService` 不存在。

- [ ] **步骤 3：编写实现**

创建 `electron-agent/electron/app/wikiSyncService.ts`：

```ts
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export interface WikiSyncJobPort {
  start(id: string): unknown;
  progress(id: string, value: number): unknown;
  complete(id: string): unknown;
  fail(id: string, error: string): unknown;
  /** 编排器确认已停止后，由它把 job 状态落定为 cancelled。 */
  markCancelled(id: string): unknown;
  /** 该 job 是否已被请求取消（协作式取消的检查点）。 */
  cancelled(id: string): boolean;
}

export interface WikiSyncPageInput { workspace: string; page: string; title: string; content: string; sourcePath: string }

export interface WikiSyncServiceOptions {
  jobs: WikiSyncJobPort;
  /** 枚举工作区内的 Markdown 相对路径。 */
  scan: (workspace: string) => Promise<string[]>;
  /** 读取工作区内某个相对路径的内容。 */
  readSource: (workspace: string, relativePath: string) => Promise<string>;
  /** 调用系统 worker 生成页面 Markdown。 */
  generate: (source: string, relativePath: string) => Promise<string>;
  /** 写入 Agent Data Runtime（wiki.replace）。 */
  writePage: (input: WikiSyncPageInput) => Promise<void>;
}

/**
 * Wiki 同步编排器。
 *
 * 刻意不 import extensions/wiki-rag：系统 worker 加载零扩展（PI_SYSTEM_WORKER=1），
 * 扩展里的工具在这条链路上不可达；而且两个包本来就不能互相引用。
 * 扫描逻辑与 extensions/wiki-rag/sync.ts 的 scanWorkspaceMarkdown 行为对齐。
 */
export class WikiSyncService {
  constructor(private readonly options: WikiSyncServiceOptions) {}

  async run(jobId: string, workspace: string): Promise<void> {
    const { jobs } = this.options;
    jobs.start(jobId);
    try {
      const files = await this.options.scan(workspace);
      for (const [index, file] of files.entries()) {
        // 检查点一：不开始处理下一个文件。
        if (jobs.cancelled(jobId)) { jobs.markCancelled(jobId); return; }
        const source = await this.options.readSource(workspace, file);
        const content = await this.options.generate(source, file);
        // 检查点二：生成期间被取消时，这一页也不写入。
        // 少了这一步就会出现"状态已取消但仍在写文件"的竞态（生成是耗时调用，窗口很大）。
        if (jobs.cancelled(jobId)) { jobs.markCancelled(jobId); return; }
        await this.options.writePage({ workspace, page: file, title: titleFromPage(file), content, sourcePath: file });
        jobs.progress(jobId, ((index + 1) / files.length) * 100);
      }
      if (jobs.cancelled(jobId)) { jobs.markCancelled(jobId); return; }
      jobs.complete(jobId);
    } catch (error) {
      if (jobs.cancelled(jobId)) { jobs.markCancelled(jobId); return; }
      jobs.fail(jobId, error instanceof Error ? error.message : String(error));
    }
  }
}

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.pi']);

/** 枚举工作区内的 Markdown 相对路径（POSIX 分隔符，已排序）。 */
export async function scanWorkspaceMarkdown(workspace: string): Promise<string[]> {
  const root = resolve(workspace);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => (entry.parentPath ? relative(root, resolve(entry.parentPath, entry.name)) : entry.name).replace(/\\/g, '/'))
    .filter((path) => path && !path.split('/').some((part) => SKIPPED_DIRECTORIES.has(part)))
    .sort();
}

/** 读取工作区内的源文件，拒绝越出工作区边界的路径。 */
export async function readWorkspaceSource(workspace: string, relativePath: string): Promise<string> {
  const root = resolve(workspace);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('sourcePath must stay inside workspace');
  return readFile(target, 'utf8');
}

function titleFromPage(page: string): string {
  const name = page.replace(/\\/g, '/').split('/').pop() ?? page;
  return name.replace(/\.[^.]+$/, '') || 'Untitled';
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run electron/app/wikiSyncService.test.ts`

预期：PASS，5 个用例通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/wikiSyncService.ts electron-agent/electron/app/wikiSyncService.test.ts
git commit -m "feat(wiki): 新增同步编排器，逐页生成并推进 job"
```

### 任务 11：把 Wiki 同步接进 runtime 与主进程

**背景：** `admin.jobs.create` 现在只写一行数据库记录。要让创建即触发执行，需要给 runtime 注入一个"job 执行器"回调，并在 `main.ts` 里把 `WikiSyncService` 装配起来（依赖 `systemWorker` 与 `wiki.replace`）。

**文件：**
- 修改：`electron-agent/electron/agentData/runtime.ts`（新增 `jobRunners` 选项 + `admin.jobs.create` / `admin.jobs.cancel` 接线）
- 修改：`electron-agent/electron/main.ts`（装配）
- 测试：`electron-agent/electron/agentData/runtime.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `runtime.test.ts` 追加：

```ts
  it('dispatches a created job to its registered runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-jobrunner-'));
    const started: Array<{ id: string; workspace: string }> = [];
    const runtime = new AgentDataRuntime({
      dataPath: join(dir, 'data.db'),
      jobRunners: { 'wiki.sync': { run: (id, workspace) => { started.push({ id, workspace }); return Promise.resolve(); }, cancel: () => {} } },
    });
    const client = new AgentDataClient(await runtime.start());

    const job = await client.request<{ id: string }>('admin.jobs.create', { kind: 'wiki.sync', workspace: '/repo' });
    await vi.waitFor(() => expect(started).toEqual([{ id: job.id, workspace: '/repo' }]));

    // 同 workspace 同 kind 并发创建被拒绝（避免两个同步进程写同一份索引）。
    await expect(client.request('admin.jobs.create', { kind: 'wiki.sync', workspace: '/repo' })).rejects.toMatchObject({ code: 'JOB_ALREADY_RUNNING' });
    // 没有注册 runner 的 kind 仍然只落库，不报错、不做并发拒绝。
    await expect(client.request('admin.jobs.create', { kind: 'unknown.kind', workspace: '/repo' })).resolves.toMatchObject({ state: 'pending' });

    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('defers the cancelled state to the runner so no work happens after it lands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-jobcancel-'));
    const cancelRequests: string[] = [];
    const runtime = new AgentDataRuntime({
      dataPath: join(dir, 'data.db'),
      jobRunners: { 'wiki.sync': { run: () => new Promise(() => {}), cancel: (id) => { cancelRequests.push(id); } } },
    });
    const client = new AgentDataClient(await runtime.start());
    const job = await client.request<{ id: string }>('admin.jobs.create', { kind: 'wiki.sync', workspace: '/repo' });

    // 取消只是"请求"：runner 收到通知，状态还没落定。
    await client.request('admin.jobs.cancel', { id: job.id });
    expect(cancelRequests).toEqual([job.id]);
    await expect(client.request('admin.jobs.get', { id: job.id })).resolves.toMatchObject({ state: 'pending' });

    // runner 确认停止后才写状态。
    await client.request('admin.jobs.markCancelled', { id: job.id });
    await expect(client.request('admin.jobs.get', { id: job.id })).resolves.toMatchObject({ state: 'cancelled' });

    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('cancels a runner-less job immediately because nothing is running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-jobcancel-none-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db') });
    const client = new AgentDataClient(await runtime.start());
    const job = await client.request<{ id: string }>('admin.jobs.create', { kind: 'unknown.kind', workspace: '/repo' });

    await expect(client.request('admin.jobs.cancel', { id: job.id })).resolves.toMatchObject({ state: 'cancelled' });

    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });
```

同时把 `runtime.test.ts` 顶部的 import 补上 `vi`：

```ts
import { describe, expect, it, vi } from 'vitest';
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run electron/agentData/runtime.test.ts -t "registered runner"`

预期：FAIL。`jobRunners` 不是合法选项（TypeScript 报错），且 `started` 始终为空。

- [ ] **步骤 3：实现 runtime 接线**

`runtime.ts` 的选项接口新增：

```ts
export interface AgentDataJobRunner {
  run(jobId: string, workspace: string): Promise<void>;
  cancel(jobId: string): void;
}

export interface AgentDataRuntimeOptions {
  dataPath: string;
  methods?: Record<string, AgentDataMethod>;
  stdin?: NodeJS.ReadableStream;
  executeServiceTask?: (task: ServiceTask) => Promise<unknown>;
  /** 按 job kind 注册的执行器：创建即派发，取消时通知。未注册的 kind 只落库。 */
  jobRunners?: Record<string, AgentDataJobRunner>;
}
```

`adminMethod` 的两个分支改成：

```ts
    if (name === 'admin.jobs.cancel') return (p) => {
      const id = readString(p.id);
      const job = this.jobs!.get(id);
      const runner = job ? this.options.jobRunners?.[job.kind] : undefined;
      if (!runner) return this.jobs!.cancel(id);
      // 有执行器时取消只是"请求"：状态由执行器确认停止后通过 admin.jobs.markCancelled 落定，
      // 避免出现"状态已取消但后台还在写文件"。
      runner.cancel(id);
      return this.jobs!.get(id);
    };
    if (name === 'admin.jobs.markCancelled') return (p) => this.jobs!.cancel(readString(p.id));
    if (name === 'admin.jobs.create') return (p) => {
      const kind = readString(p.kind);
      const workspace = readString(p.workspace);
      const runner = this.options.jobRunners?.[kind];
      // 同 workspace 同 kind 已有未结束任务时拒绝：避免两个同步进程并发写同一份索引。
      if (runner && this.jobs!.hasActive(kind, workspace)) throw new RpcError('JOB_ALREADY_RUNNING', `${kind} is already running for this workspace`);
      const job = this.jobs!.create({ kind, workspace });
      // fire-and-forget：执行器自己把状态写回 agent_jobs，创建调用不等它完成。
      if (runner) void runner.run(job.id, workspace).catch((error) => this.jobs!.fail(job.id, error instanceof Error ? error.message : String(error)));
      return job;
    };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run electron/agentData/runtime.test.ts`

预期：PASS。既有 `filters admin jobs by requested state` 用例（`kind: 'wiki-sync'`，注意是连字符不是点号，不会命中 runner）不受影响。

- [ ] **步骤 5：在 main.ts 装配**

`main.ts` 里 `agentData = new AgentDataService({...})` 之前先声明一个可变引用（因为编排器要用到 `agentData.request`，而 `agentData` 此时还没构造完，用惰性读取打破循环）：

```ts
    const wikiSync = new WikiSyncService({
      jobs: {
        start: (id) => void agentData.request('admin.jobs.start', { id }),
        progress: (id, value) => void agentData.request('admin.jobs.progress', { id, value }),
        complete: (id) => void agentData.request('admin.jobs.complete', { id }),
        fail: (id, error) => void agentData.request('admin.jobs.fail', { id, error }),
        markCancelled: (id) => void agentData.request('admin.jobs.markCancelled', { id }),
        cancelled: (id) => wikiCancelled.has(id),
      },
      scan: (workspace) => scanWorkspaceMarkdown(workspace),
      readSource: (workspace, path) => readWorkspaceSource(workspace, path),
      generate: (source, path) => systemWorker.run({ id: `wiki-${randomUUID()}`, kind: 'wiki_page_generate', input: { sourcePath: path, source } }).then((value) => String(value)),
      writePage: (input) => agentData.request('wiki.replace', { ...input }),
    });
```

顶部补 import：

```ts
import { randomUUID } from "node:crypto";
import { WikiSyncService, scanWorkspaceMarkdown, readWorkspaceSource } from "./app/wikiSyncService";
```

并在 `agentData` 声明附近加取消标记集合：

```ts
    const wikiCancelled = new Set<string>();
```

把 `jobRunners` 传给 `AgentDataService`：

```ts
      jobRunners: {
        'wiki.sync': {
          run: async (id, workspace) => { wikiCancelled.delete(id); await wikiSync.run(id, workspace); wikiCancelled.delete(id); },
          cancel: (id) => { wikiCancelled.add(id); },
        },
      },
```

- [ ] **步骤 6：补 runtime 的 job 状态推进 RPC**

上一步的编排器通过 RPC 推进 job 状态，需要在 `runtime.ts` 的 `adminMethod` 里暴露这四个方法：

```ts
    if (name === 'admin.jobs.start') return (p) => this.jobs!.start(readString(p.id));
    if (name === 'admin.jobs.progress') return (p) => this.jobs!.progress(readString(p.id), typeof p.value === 'number' ? p.value : 0);
    if (name === 'admin.jobs.complete') return (p) => this.jobs!.complete(readString(p.id));
    if (name === 'admin.jobs.fail') return (p) => this.jobs!.fail(readString(p.id), readString(p.error));
```

这四个方法加上上一步的 `admin.jobs.markCancelled` 只在主进程内部使用，不注册对应的 Electron IPC 命令（渲染层不应该能直接改 job 状态）。

- [ ] **步骤 7：运行测试与构建验证**

运行：

```bash
cd electron-agent
npx vitest run electron/agentData electron/app/wikiSyncService.test.ts electron/pi/systemWorkerManager.test.ts
npm run build
```

预期：测试全部 PASS；`npm run build`（`tsc -p tsconfig.json && electron-vite build`）退出码 0。第三方依赖的 `use client` 警告可以出现，但不能有 TypeScript 错误。

- [ ] **步骤 8：Commit**

```bash
git add electron-agent/electron/agentData/runtime.ts electron-agent/electron/agentData/runtime.test.ts electron-agent/electron/main.ts
git commit -m "feat(wiki): 创建 wiki.sync job 即派发执行器"
```

### 任务 12：WikiPanel 默认全局 + 项目筛选器

**文件：**
- 修改：`electron-agent/src/features/agentData/WikiPanel.tsx`
- 测试：`electron-agent/src/features/agentData/WikiPanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

把 `WikiPanel.test.tsx` 整体替换为：

```tsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WikiPanel } from './WikiPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { wiki: { overview: vi.fn(), search: vi.fn() }, jobs: { create: vi.fn() } },
}));
vi.mock('./useProjectOptions', () => ({
  useProjectOptions: () => [{ cwd: 'D:/proj/alpha', name: 'alpha' }, { cwd: 'D:/proj/beta', name: 'beta' }],
}));
import { agentDataApi } from '../../lib/agentData';

describe('WikiPanel', () => {
  beforeEach(() => {
    vi.mocked(agentDataApi.wiki.overview).mockResolvedValue({ pages: 2, latestUpdatedAt: 2 });
    vi.mocked(agentDataApi.wiki.search).mockResolvedValue([{
      workspace: 'D:/proj/beta', page: 'architecture', title: 'Architecture',
      snippet: 'Agent Data Runtime', sourcePath: 'docs/architecture.md', chunks: 3,
    }]);
    vi.mocked(agentDataApi.jobs.create).mockResolvedValue({ id: 'job-1', kind: 'wiki.sync', workspace: 'D:/proj/alpha', state: 'pending', progress: 0, createdAt: 1, updatedAt: 1 });
  });

  it('searches every project by default and shows each page origin', async () => {
    render(<WikiPanel />);
    await waitFor(() => expect(agentDataApi.wiki.overview).toHaveBeenCalledWith(undefined));
    fireEvent.change(screen.getByLabelText('搜索 Wiki'), { target: { value: 'Agent Data' } });
    expect(await screen.findByText('docs/architecture.md')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    expect(agentDataApi.wiki.search).toHaveBeenCalledWith(undefined, 'Agent Data', 50);
  });

  it('narrows to one project and syncs that project', async () => {
    const onJobCreated = vi.fn();
    render(<WikiPanel onJobCreated={onJobCreated} />);
    fireEvent.change(screen.getByLabelText('项目范围'), { target: { value: 'D:/proj/alpha' } });
    await waitFor(() => expect(agentDataApi.wiki.overview).toHaveBeenLastCalledWith('D:/proj/alpha'));

    fireEvent.click(screen.getByRole('button', { name: '同步 Wiki' }));
    await waitFor(() => expect(agentDataApi.jobs.create).toHaveBeenCalledWith({ kind: 'wiki.sync', workspace: 'D:/proj/alpha' }));
    expect(onJobCreated).toHaveBeenCalled();
  });

  it('disables sync while the scope is global because sync targets one project', async () => {
    render(<WikiPanel />);
    expect(screen.getByRole('button', { name: '同步 Wiki' }).hasAttribute('disabled')).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run src/features/agentData/WikiPanel.test.tsx`

预期：FAIL。当前组件缺 `workspace` 时显示"未绑定工作区"，也没有项目筛选器和来源列。

- [ ] **步骤 3：编写实现**

把 `WikiPanel.tsx` 替换为：

```tsx
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { agentDataApi, type WikiOverview, type WikiSearchResult } from '../../lib/agentData';
import { styles } from './agentDataStyles';
import { useProjectOptions } from './useProjectOptions';

interface WikiPanelProps {
  /** 仅作为筛选器的初始值；用户手动切换后不再跟随其变化。 */
  initialProject?: string;
  onJobCreated?: () => void;
}

export function WikiPanel({ initialProject, onJobCreated }: WikiPanelProps) {
  const projects = useProjectOptions();
  const [project, setProject] = useState<string>(initialProject ?? '');
  const [overview, setOverview] = useState<WikiOverview>();
  const [results, setResults] = useState<WikiSearchResult[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string>();

  // 空字符串 = 全局：不传 workspace，让底层跨全部项目查询。
  const scope = useMemo(() => (project ? project : undefined), [project]);
  const nameOf = (workspace: string) => projects.find((option) => option.cwd === workspace)?.name ?? workspace;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void agentDataApi.wiki.overview(scope)
      .then((value) => { if (!cancelled) setOverview(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope]);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    let cancelled = false;
    void agentDataApi.wiki.search(scope, query.trim(), 50)
      .then((value) => { if (!cancelled) setResults(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [scope, query]);

  // 同步是"对一个项目扫描生成"，全局视图下没有明确目标，因此必须先选定项目。
  const sync = async () => {
    if (!project) return;
    setSyncing(true);
    try { await agentDataApi.jobs.create({ kind: 'wiki.sync', workspace: project }); onJobCreated?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSyncing(false); }
  };

  return <section data-testid="wiki-panel">
    <div className={styles.sectionHeading}><h3 className={styles.heading}>Wiki RAG</h3><span className={styles.hint}>{overview?.pages ?? '-'} 页 · {project ? nameOf(project) : '全部项目'}</span></div>
    <div className={styles.toolbar}>
      <div className={styles.input} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Search size={13} />
        <input aria-label="搜索 Wiki" placeholder="搜索 Wiki 页面" value={query} onChange={(event) => setQuery(event.target.value)} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'inherit' }} />
      </div>
      <select className={styles.select} aria-label="项目范围" value={project} onChange={(event) => setProject(event.target.value)}>
        <option value="">全部项目</option>
        {projects.map((option) => <option key={option.cwd} value={option.cwd}>{option.name}</option>)}
      </select>
      <button type="button" className={styles.actionButton} onClick={() => void sync()} disabled={!project || syncing} title={project ? '扫描该项目的 Markdown 并生成页面' : '请先选择一个项目'}>
        <RefreshCw size={12} />同步 Wiki
      </button>
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {loading ? <div className={styles.state}>正在加载 Wiki...</div>
      : results.length === 0 ? <div className={styles.state}>{query ? '暂无匹配页面' : '输入关键词搜索 Wiki'}</div>
      : <table className={styles.table}>
        <thead><tr><th>页面</th><th>摘要</th><th>项目</th><th>来源</th><th>分块</th></tr></thead>
        <tbody>{results.map((result) => <tr key={`${result.workspace}:${result.page}`}>
          <td>{result.title}</td>
          <td>{result.snippet}</td>
          <td>{nameOf(result.workspace)}</td>
          <td>{result.sourcePath}</td>
          <td>{result.chunks} 个分块</td>
        </tr>)}</tbody>
      </table>}
  </section>;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run src/features/agentData/WikiPanel.test.tsx`

预期：PASS，3 个用例通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/agentData/WikiPanel.tsx electron-agent/src/features/agentData/WikiPanel.test.tsx
git commit -m "feat(wiki): 面板默认全局展示并新增项目筛选器"
```

---

## 阶段三：CodeGraph 项目选择 + 同步执行器 + 实例池

### 任务 13：索引探测

**背景：** 不新增持久化注册表。"哪些项目已建 CodeGraph 索引"通过运行时探测 `<项目路径>/.codegraph` 目录是否存在得出（纯文件系统检查，无需打开索引）。这个判断已经内嵌在 `extensions/code-retrieval/mcpClient.ts::connectCodeGraph()` 里，这里把它提升为一个可批量查询的主进程能力。

**文件：**
- 创建：`electron-agent/electron/app/codeGraph/indexProbe.ts`
- 测试：`electron-agent/electron/app/codeGraph/indexProbe.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/app/codeGraph/indexProbe.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIndexed, probeProjects } from './indexProbe';

describe('CodeGraph index probe', () => {
  it('detects an initialized workspace by its .codegraph directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-probe-'));
    expect(isIndexed(root)).toBe(false);
    mkdirSync(join(root, '.codegraph'));
    expect(isIndexed(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('treats a .codegraph file (not directory) as not indexed', () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-probe-file-'));
    writeFileSync(join(root, '.codegraph'), 'not a directory');
    expect(isIndexed(root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports indexed state for every supplied workspace', () => {
    const indexed = mkdtempSync(join(tmpdir(), 'cg-probe-a-'));
    const bare = mkdtempSync(join(tmpdir(), 'cg-probe-b-'));
    mkdirSync(join(indexed, '.codegraph'));

    expect(probeProjects([indexed, bare, '  '])).toEqual([
      { workspace: indexed, indexed: true },
      { workspace: bare, indexed: false },
    ]);

    rmSync(indexed, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run electron/app/codeGraph/indexProbe.test.ts`

预期：FAIL，模块 `./indexProbe` 不存在。

- [ ] **步骤 3：编写实现**

创建 `electron-agent/electron/app/codeGraph/indexProbe.ts`：

```ts
import { statSync } from 'node:fs';
import { join } from 'node:path';

export interface ProjectIndexState { workspace: string; indexed: boolean }

/** 该工作区是否已建立 CodeGraph 索引（存在 .codegraph 目录）。 */
export function isIndexed(workspace: string): boolean {
  if (!workspace.trim()) return false;
  try {
    return statSync(join(workspace, '.codegraph')).isDirectory();
  } catch {
    return false;
  }
}

/** 批量探测：空白路径被跳过，其余按输入顺序返回索引状态。 */
export function probeProjects(workspaces: string[]): ProjectIndexState[] {
  return workspaces
    .filter((workspace) => workspace.trim())
    .map((workspace) => ({ workspace, indexed: isIndexed(workspace) }));
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run electron/app/codeGraph/indexProbe.test.ts`

预期：PASS，3 个用例通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/codeGraph/indexProbe.ts electron-agent/electron/app/codeGraph/indexProbe.test.ts
git commit -m "feat(codegraph): 新增索引状态探测"
```

### 任务 14：同步执行器（spawn codegraph CLI）

**背景：** CodeGraph 同步不需要 LLM，是纯子进程调用。`.codegraph` 不存在 → `codegraph init`（建索引）；已存在 → `codegraph sync`（增量）。命令沿用 `extensions/code-retrieval/mcpClient.ts` 的 `GREN_CODEGRAPH_COMMAND` 覆盖机制保持可配置。取消时直接 kill 子进程（`.codegraph` 可能处于不完整状态，下次同步会覆盖，不需要回滚）。

**文件：**
- 创建：`electron-agent/electron/app/codeGraph/syncRunner.ts`
- 测试：`electron-agent/electron/app/codeGraph/syncRunner.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/app/codeGraph/syncRunner.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { CodeGraphSyncRunner, resolveSyncCommand } from './syncRunner';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: ReturnType<typeof vi.fn>; pid?: number };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 4242;
  return child;
}

describe('resolveSyncCommand', () => {
  it('initializes a bare workspace and syncs an initialized one', () => {
    expect(resolveSyncCommand('/repo', false)).toEqual({ command: 'codegraph', args: ['init', '--path', '/repo'] });
    expect(resolveSyncCommand('/repo', true)).toEqual({ command: 'codegraph', args: ['sync', '--path', '/repo'] });
  });

  it('honours the GREN_CODEGRAPH_COMMAND override', () => {
    expect(resolveSyncCommand('/repo', true, 'node ./cg.js')).toEqual({ command: 'node', args: ['./cg.js', 'sync', '--path', '/repo'] });
  });
});

describe('CodeGraphSyncRunner', () => {
  it('resolves when the CLI exits with zero and reports which command ran', async () => {
    const child = fakeChild();
    const runner = new CodeGraphSyncRunner({ isIndexed: () => true, spawnImpl: vi.fn(() => child as never) });

    const running = runner.run('job-1', '/repo');
    child.emit('close', 0);

    await expect(running).resolves.toEqual({ mode: 'sync' });
  });

  it('rejects with the stderr tail when the CLI fails', async () => {
    const child = fakeChild();
    const runner = new CodeGraphSyncRunner({ isIndexed: () => false, spawnImpl: vi.fn(() => child as never) });

    const running = runner.run('job-1', '/repo');
    child.stderr.emit('data', 'fatal: cannot parse file\n');
    child.emit('close', 1);

    await expect(running).rejects.toThrow('cannot parse file');
  });

  it('rejects when the CLI is missing entirely', async () => {
    const child = fakeChild();
    const runner = new CodeGraphSyncRunner({ isIndexed: () => true, spawnImpl: vi.fn(() => child as never) });

    const running = runner.run('job-1', '/repo');
    child.emit('error', Object.assign(new Error('spawn codegraph ENOENT'), { code: 'ENOENT' }));

    await expect(running).rejects.toThrow(/codegraph/);
  });

  it('kills the child process when the job is cancelled', async () => {
    const child = fakeChild();
    const killTree = vi.fn(async () => {});
    const runner = new CodeGraphSyncRunner({ isIndexed: () => true, spawnImpl: vi.fn(() => child as never), killTree });

    const running = runner.run('job-1', '/repo');
    runner.cancel('job-1');
    child.emit('close', null);

    await expect(running).rejects.toThrow('cancelled');
    expect(killTree).toHaveBeenCalledWith(4242);
  });

  it('ignores cancellation for an unknown job id', () => {
    const runner = new CodeGraphSyncRunner({ isIndexed: () => true, spawnImpl: vi.fn() });
    expect(() => runner.cancel('missing')).not.toThrow();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run electron/app/codeGraph/syncRunner.test.ts`

预期：FAIL，模块 `./syncRunner` 不存在。

- [ ] **步骤 3：编写实现**

创建 `electron-agent/electron/app/codeGraph/syncRunner.ts`：

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { processRegistry } from '../processRegistry';
import { isIndexed as defaultIsIndexed } from './indexProbe';

export type SyncMode = 'init' | 'sync';
export interface SyncResult { mode: SyncMode }

export interface CodeGraphSyncRunnerOptions {
  isIndexed?: (workspace: string) => boolean;
  spawnImpl?: typeof spawn;
  killTree?: (pid: number) => Promise<void>;
  /** 覆盖 codegraph 命令（默认读 GREN_CODEGRAPH_COMMAND，与 code-retrieval 扩展一致）。 */
  commandOverride?: () => string | undefined;
}

/** 解析要执行的命令：未建索引 → init，已建索引 → sync（增量）。 */
export function resolveSyncCommand(workspace: string, indexed: boolean, override?: string): { command: string; args: string[] } {
  const action = indexed ? 'sync' : 'init';
  const configured = override?.trim();
  if (configured) {
    const parts = configured.split(/\s+/);
    return { command: parts[0], args: [...parts.slice(1), action, '--path', workspace] };
  }
  return { command: 'codegraph', args: [action, '--path', workspace] };
}

/** 运行 codegraph CLI 完成一次索引建立/同步。同一时刻每个 job 一个子进程。 */
export class CodeGraphSyncRunner {
  private readonly running = new Map<string, { child: ChildProcessWithoutNullStreams; cancelled: boolean }>();

  constructor(private readonly options: CodeGraphSyncRunnerOptions = {}) {}

  run(jobId: string, workspace: string): Promise<SyncResult> {
    const indexed = (this.options.isIndexed ?? defaultIsIndexed)(workspace);
    const override = (this.options.commandOverride ?? (() => process.env.GREN_CODEGRAPH_COMMAND))();
    const { command, args } = resolveSyncCommand(workspace, indexed, override);
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const child = spawnImpl(command, args, { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    const entry = { child, cancelled: false };
    this.running.set(jobId, entry);
    processRegistry.register(child, `codegraph:${workspace}`);

    return new Promise<SyncResult>((resolve, reject) => {
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
      child.once('error', (error: NodeJS.ErrnoException) => {
        this.running.delete(jobId);
        reject(error.code === 'ENOENT'
          ? new Error(`codegraph CLI not found (tried "${command}"); install it or set GREN_CODEGRAPH_COMMAND`)
          : error);
      });
      child.once('close', (code) => {
        const wasCancelled = this.running.get(jobId)?.cancelled ?? false;
        this.running.delete(jobId);
        if (wasCancelled) { reject(new Error('codegraph sync was cancelled')); return; }
        if (code === 0) { resolve({ mode: indexed ? 'sync' : 'init' }); return; }
        reject(new Error(`codegraph ${indexed ? 'sync' : 'init'} exited (${code}): ${stderr.trim().slice(-500) || 'no stderr output'}`));
      });
    });
  }

  /** 请求取消：标记后杀掉进程树，close 回调会把 promise reject 成 cancelled。 */
  cancel(jobId: string): void {
    const entry = this.running.get(jobId);
    if (!entry) return;
    entry.cancelled = true;
    const pid = entry.child.pid;
    if (pid) void (this.options.killTree ?? ((value: number) => processRegistry.killTree(value)))(pid);
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run electron/app/codeGraph/syncRunner.test.ts`

预期：PASS，5 个用例通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/codeGraph/syncRunner.ts electron-agent/electron/app/codeGraph/syncRunner.test.ts
git commit -m "feat(codegraph): 新增同步执行器，支持 init/sync 与取消"
```

### 任务 15：MCP 实例池

**背景：** 现在每次查询都要现开一个 `codegraph serve --mcp` 子进程、查完立刻 `close()`（见 `extensions/code-retrieval/tools.ts` 的 `finally { await client.close(); }`）。改成按 workspace 键控的池子：惰性拉起、常驻复用、空闲 15 分钟自动关闭；同步完成后主动失效对应连接，保证下次读到最新索引。

主进程需要 MCP 客户端能力，`electron-agent/package.json` 目前没有这个依赖，本任务顺带加上（版本与 `extensions/package.json` 一致）。

**文件：**
- 修改：`electron-agent/package.json`
- 创建：`electron-agent/electron/app/codeGraph/instancePool.ts`
- 测试：`electron-agent/electron/app/codeGraph/instancePool.test.ts`

- [ ] **步骤 1：添加依赖**

运行：

```bash
cd electron-agent
npm install --save @modelcontextprotocol/sdk@^1.29.0
```

预期：`package.json` 的 `dependencies` 新增 `"@modelcontextprotocol/sdk": "^1.29.0"`，安装成功退出码 0。

- [ ] **步骤 2：编写失败的测试**

创建 `electron-agent/electron/app/codeGraph/instancePool.test.ts`（用注入的 connect 假实现，不真的 spawn）：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeGraphInstancePool } from './instancePool';

function fakeClient() {
  return { callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })), close: vi.fn(async () => {}) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('CodeGraphInstancePool', () => {
  it('connects once per workspace and reuses the connection', async () => {
    const clients = [fakeClient(), fakeClient()];
    const connect = vi.fn(async () => clients[connect.mock.calls.length - 1]);
    const pool = new CodeGraphInstancePool({ connect, idleTimeoutMs: 1000 });

    await pool.call('/repo', 'codegraph_search', { query: 'a' });
    await pool.call('/repo', 'codegraph_search', { query: 'b' });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(clients[0].callTool).toHaveBeenCalledTimes(2);
  });

  it('keeps separate connections per workspace', async () => {
    const connect = vi.fn(async () => fakeClient());
    const pool = new CodeGraphInstancePool({ connect, idleTimeoutMs: 1000 });

    await pool.call('/repo-a', 'codegraph_search', {});
    await pool.call('/repo-b', 'codegraph_search', {});

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenNthCalledWith(1, '/repo-a');
    expect(connect).toHaveBeenNthCalledWith(2, '/repo-b');
  });

  it('closes an idle connection after the timeout and reconnects on demand', async () => {
    const clients = [fakeClient(), fakeClient()];
    const connect = vi.fn(async () => clients[connect.mock.calls.length - 1]);
    const pool = new CodeGraphInstancePool({ connect, idleTimeoutMs: 1000 });

    await pool.call('/repo', 'codegraph_search', {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients[0].close).toHaveBeenCalledTimes(1);

    await pool.call('/repo', 'codegraph_search', {});
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('invalidates a workspace so the next call sees a fresh index', async () => {
    const clients = [fakeClient(), fakeClient()];
    const connect = vi.fn(async () => clients[connect.mock.calls.length - 1]);
    const pool = new CodeGraphInstancePool({ connect, idleTimeoutMs: 1000 });

    await pool.call('/repo', 'codegraph_search', {});
    await pool.invalidate('/repo');
    expect(clients[0].close).toHaveBeenCalledTimes(1);

    await pool.call('/repo', 'codegraph_search', {});
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed connection', async () => {
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('index not initialized'))
      .mockResolvedValueOnce(fakeClient());
    const pool = new CodeGraphInstancePool({ connect, idleTimeoutMs: 1000 });

    await expect(pool.call('/repo', 'codegraph_search', {})).rejects.toThrow('index not initialized');
    await expect(pool.call('/repo', 'codegraph_search', {})).resolves.toBeDefined();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('closes every connection on shutdown', async () => {
    const clients = [fakeClient(), fakeClient()];
    const connect = vi.fn(async () => clients[connect.mock.calls.length - 1]);
    const pool = new CodeGraphInstancePool({ connect, idleTimeoutMs: 1000 });

    await pool.call('/repo-a', 'codegraph_search', {});
    await pool.call('/repo-b', 'codegraph_search', {});
    await pool.closeAll();

    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(clients[1].close).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd electron-agent; npx vitest run electron/app/codeGraph/instancePool.test.ts`

预期：FAIL，模块 `./instancePool` 不存在。

- [ ] **步骤 4：编写实现**

创建 `electron-agent/electron/app/codeGraph/instancePool.ts`：

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface CodeGraphConnection {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface CodeGraphInstancePoolOptions {
  connect?: (workspace: string) => Promise<CodeGraphConnection>;
  /** 空闲多久后关闭子进程释放资源。默认 15 分钟。 */
  idleTimeoutMs?: number;
}

interface PoolEntry { connection: CodeGraphConnection; timer?: ReturnType<typeof setTimeout> }

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * 按 workspace 键控的 CodeGraph MCP 连接池。
 *
 * 与扩展侧「每次查询现开现关」不同：这里惰性拉起后常驻复用，空闲超时才关闭。
 * 同步完成后必须调用 invalidate()，否则池里的连接仍持有旧索引句柄。
 */
export class CodeGraphInstancePool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly pending = new Map<string, Promise<CodeGraphConnection>>();
  private readonly idleTimeoutMs: number;
  private readonly connectImpl: (workspace: string) => Promise<CodeGraphConnection>;

  constructor(options: CodeGraphInstancePoolOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.connectImpl = options.connect ?? connectCodeGraphMcp;
  }

  async call(workspace: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const connection = await this.acquire(workspace);
    try {
      return await connection.callTool(tool, { projectPath: workspace, ...args });
    } finally {
      this.scheduleIdleClose(workspace);
    }
  }

  /** 关闭并丢弃该 workspace 的连接（同步完成后调用，保证下次读到新索引）。 */
  async invalidate(workspace: string): Promise<void> {
    const entry = this.entries.get(workspace);
    if (!entry) return;
    this.entries.delete(workspace);
    if (entry.timer) clearTimeout(entry.timer);
    await entry.connection.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    const workspaces = [...this.entries.keys()];
    await Promise.all(workspaces.map((workspace) => this.invalidate(workspace)));
  }

  private async acquire(workspace: string): Promise<CodeGraphConnection> {
    const existing = this.entries.get(workspace);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = undefined;
      return existing.connection;
    }
    // 并发首次调用共享同一次连接尝试；失败不落池，下次重试。
    const inFlight = this.pending.get(workspace) ?? this.connectImpl(workspace).finally(() => this.pending.delete(workspace));
    this.pending.set(workspace, inFlight);
    const connection = await inFlight;
    if (!this.entries.has(workspace)) this.entries.set(workspace, { connection });
    return connection;
  }

  private scheduleIdleClose(workspace: string): void {
    const entry = this.entries.get(workspace);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void this.invalidate(workspace); }, this.idleTimeoutMs);
  }
}

/** 真实连接：拉起 `codegraph serve --mcp` 并按 stdio MCP 协议握手。 */
async function connectCodeGraphMcp(workspace: string): Promise<CodeGraphConnection> {
  if (!workspace.trim()) throw new Error('workspace is required');
  if (!existsSync(join(workspace, '.codegraph'))) throw new Error('CodeGraph index is not initialized for this workspace');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const configured = process.env.GREN_CODEGRAPH_COMMAND?.trim();
  const parts = configured ? configured.split(/\s+/) : ['codegraph', 'serve', '--mcp', '--path', workspace];
  const transport = new StdioClientTransport({
    command: parts[0],
    args: configured ? [...parts.slice(1), 'serve', '--mcp', '--path', workspace] : parts.slice(1),
    cwd: workspace,
    env: { ...process.env, GREN_CODEGRAPH_WORKSPACE: workspace } as Record<string, string>,
  });
  const client = new Client({ name: 'electron-agent-code-retrieval', version: '0.1.0' });
  await client.connect(transport);
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    close: () => client.close(),
  };
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd electron-agent; npx vitest run electron/app/codeGraph/instancePool.test.ts`

预期：PASS，6 个用例通过。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/package.json electron-agent/package-lock.json electron-agent/electron/app/codeGraph/instancePool.ts electron-agent/electron/app/codeGraph/instancePool.test.ts
git commit -m "feat(codegraph): 新增 MCP 实例池，惰性加载并空闲超时回收"
```

### 任务 16：CodeGraphService 聚合与 runtime 接线

**背景：** 把探测、同步、实例池聚合成一个服务，替换 `runtime.ts` 里 `codeRetrieval.admin.status` / `codeRetrieval.search` 两个硬编码占位符（现在恒返回 `{connected:false}`），并新增 `codeRetrieval.admin.projects` 供面板的项目选择器使用。

**文件：**
- 创建：`electron-agent/electron/app/codeGraph/codeGraphService.ts`
- 修改：`electron-agent/electron/agentData/runtime.ts`（`adminMethod` 的两个 codeRetrieval 分支 + 新增 provider 选项）
- 修改：`electron-agent/electron/ipc/register.ts`、`electron-agent/electron/ipc/commandCoverage.test.ts`
- 修改：`electron-agent/src/lib/agentData.ts`
- 修改：`electron-agent/electron/main.ts`
- 测试：`electron-agent/electron/agentData/runtime.test.ts`、`electron-agent/electron/ipc/register.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `runtime.test.ts` 追加：

```ts
  it('delegates code retrieval queries to the injected provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-code-'));
    const runtime = new AgentDataRuntime({
      dataPath: join(dir, 'data.db'),
      codeRetrieval: {
        projects: () => [{ workspace: '/repo', indexed: true }, { workspace: '/bare', indexed: false }],
        status: (workspace) => ({ workspace, connected: true, indexed: true, files: 12, nodes: 34, edges: 56 }),
        search: async (workspace, query) => ({ workspace, available: true, results: [{ file: 'src/a.ts', line: 3, symbol: query }] }),
      },
    });
    const client = new AgentDataClient(await runtime.start());

    await expect(client.request('codeRetrieval.admin.projects')).resolves.toEqual([
      { workspace: '/repo', indexed: true }, { workspace: '/bare', indexed: false },
    ]);
    await expect(client.request('codeRetrieval.admin.status', { workspace: '/repo' })).resolves.toMatchObject({ indexed: true, files: 12 });
    await expect(client.request('codeRetrieval.search', { workspace: '/repo', query: 'parse', limit: 5 }))
      .resolves.toMatchObject({ available: true, results: [{ symbol: 'parse' }] });

    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('reports code retrieval as unavailable when no provider is injected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-code-none-'));
    const runtime = new AgentDataRuntime({ dataPath: join(dir, 'data.db') });
    const client = new AgentDataClient(await runtime.start());

    await expect(client.request('codeRetrieval.admin.projects')).resolves.toEqual([]);
    await expect(client.request('codeRetrieval.admin.status', { workspace: '/repo' })).resolves.toMatchObject({ connected: false, indexed: false });

    await client.close(); runtime.close(); rmSync(dir, { recursive: true, force: true });
  });
```

在 `register.test.ts` 的 module queries 用例内追加：

```ts
    await expect(invoke({}, { command: 'agentData_code_projects', args: {} })).resolves.toEqual({
      method: 'codeRetrieval.admin.projects', params: {},
    });
```

在 `commandCoverage.test.ts` 的 `expectedCommands` 数组里追加 `'agentData_code_projects'`。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run electron/agentData/runtime.test.ts electron/ipc/register.test.ts electron/ipc/commandCoverage.test.ts`

预期：FAIL。`codeRetrieval` 不是合法选项；`codeRetrieval.admin.projects` 与 `agentData_code_projects` 都不存在。

- [ ] **步骤 3：实现 CodeGraphService**

创建 `electron-agent/electron/app/codeGraph/codeGraphService.ts`：

```ts
import { CodeGraphInstancePool } from './instancePool';
import { CodeGraphSyncRunner } from './syncRunner';
import { isIndexed, probeProjects, type ProjectIndexState } from './indexProbe';

export interface CodeGraphStatusView {
  workspace: string;
  connected: boolean;
  indexed: boolean;
  state?: string;
  files?: number;
  nodes?: number;
  edges?: number;
}

export interface CodeSearchHit { file: string; line?: number; symbol?: string; snippet?: string }
export interface CodeSearchView { workspace: string; available: boolean; results: CodeSearchHit[]; message?: string }

export interface CodeGraphServiceOptions {
  /** 已注册项目路径的提供者（由渲染层通过 IPC 报送，主进程不自行猜测项目集合）。 */
  listWorkspaces: () => string[];
  pool?: CodeGraphInstancePool;
  syncRunner?: CodeGraphSyncRunner;
}

/** 聚合索引探测、同步执行与查询连接池，作为 runtime 的 codeRetrieval provider。 */
export class CodeGraphService {
  private readonly pool: CodeGraphInstancePool;
  private readonly syncRunner: CodeGraphSyncRunner;

  constructor(private readonly options: CodeGraphServiceOptions) {
    this.pool = options.pool ?? new CodeGraphInstancePool();
    this.syncRunner = options.syncRunner ?? new CodeGraphSyncRunner();
  }

  projects(): ProjectIndexState[] {
    return probeProjects(this.options.listWorkspaces());
  }

  status(workspace: string): CodeGraphStatusView {
    const indexed = isIndexed(workspace);
    return { workspace, connected: indexed, indexed, state: indexed ? 'indexed' : 'unavailable' };
  }

  async search(workspace: string, query: string, limit: number): Promise<CodeSearchView> {
    if (!isIndexed(workspace)) {
      return { workspace, available: false, results: [], message: 'CodeGraph index is not initialized for this workspace' };
    }
    try {
      const raw = await this.pool.call(workspace, 'codegraph_search', { query, limit });
      return { workspace, available: true, results: parseHits(raw) };
    } catch (error) {
      return { workspace, available: false, results: [], message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 供 runtime 的 jobRunners 使用：同步完成后让池子丢弃旧连接。 */
  async runSync(jobId: string, workspace: string): Promise<void> {
    await this.syncRunner.run(jobId, workspace);
    await this.pool.invalidate(workspace);
  }

  cancelSync(jobId: string): void {
    this.syncRunner.cancel(jobId);
  }

  close(): Promise<void> {
    return this.pool.closeAll();
  }
}

/**
 * CodeGraph MCP 返回 `{ content: [{ type:'text', text }] }`，text 里是它自己的
 * 格式化输出。这里只做保守解析：能解析成 JSON 数组就按结构取字段，否则按
 * `path:line` 前缀逐行提取，解析不出来就返回空列表（由 UI 显示"无结果"）。
 */
function parseHits(raw: unknown): CodeSearchHit[] {
  const text = extractText(raw);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item) => (item && typeof item === 'object' ? [toHit(item as Record<string, unknown>)] : []));
    }
  } catch {
    // 非 JSON：走行解析。
  }
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*([^\s:]+):(\d+)\s*(.*)$/.exec(line);
    return match ? [{ file: match[1], line: Number(match[2]), snippet: match[3] || undefined }] : [];
  });
}

function extractText(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { text: string } => Boolean(block) && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function toHit(item: Record<string, unknown>): CodeSearchHit {
  return {
    file: typeof item.file === 'string' ? item.file : typeof item.path === 'string' ? item.path : '',
    line: typeof item.line === 'number' ? item.line : undefined,
    symbol: typeof item.symbol === 'string' ? item.symbol : typeof item.name === 'string' ? item.name : undefined,
    snippet: typeof item.snippet === 'string' ? item.snippet : undefined,
  };
}
```

- [ ] **步骤 4：实现 runtime 接线**

`runtime.ts` 选项新增：

```ts
export interface AgentDataCodeRetrievalProvider {
  projects(): Array<{ workspace: string; indexed: boolean }>;
  status(workspace: string): Record<string, unknown>;
  search(workspace: string, query: string, limit: number): Promise<Record<string, unknown>>;
}
```

加进 `AgentDataRuntimeOptions`：`codeRetrieval?: AgentDataCodeRetrievalProvider;`

`adminMethod` 的两个占位分支替换为：

```ts
    if (name === 'codeRetrieval.admin.projects') return () => this.options.codeRetrieval?.projects() ?? [];
    if (name === 'codeRetrieval.admin.status') return (p) => {
      const workspace = typeof p.workspace === 'string' ? p.workspace : '';
      return this.options.codeRetrieval?.status(workspace) ?? { workspace, connected: false, indexed: false, state: 'unavailable' };
    };
    if (name === 'codeRetrieval.search') return (p) => {
      const workspace = readString(p.workspace);
      const query = readString(p.query);
      const limit = typeof p.limit === 'number' ? p.limit : 20;
      return this.options.codeRetrieval?.search(workspace, query, limit)
        ?? { workspace, available: false, results: [], message: 'CodeGraph is not available' };
    };
```

- [ ] **步骤 5：实现 IPC 与渲染层 API**

`register.ts` 新增命令：

```ts
    registerCommand('agentData_code_projects', () => services.agentData!.request('codeRetrieval.admin.projects'));
```

`src/lib/agentData.ts`：

```ts
export interface CodeGraphProject { workspace: string; indexed: boolean }
```

在 `code` 命名空间加：

```ts
    projects: () => invoke<CodeGraphProject[]>('agentData_code_projects'),
```

- [ ] **步骤 6：在 main.ts 装配**

`main.ts` 顶部 import：

```ts
import { CodeGraphService } from "./app/codeGraph/codeGraphService";
```

在 `agentData` 构造之前创建服务（项目列表由渲染层通过 `open_workspace` 报送过的 workspace 累积，直接复用 `PiRuntimeService` 已知的集合过于间接，这里用一个显式集合，`open_workspace`/`warm_workspace` 时登记）：

```ts
    const knownWorkspaces = new Set<string>();
    const codeGraph = new CodeGraphService({ listWorkspaces: () => [...knownWorkspaces] });
```

把 provider 与 job runner 一起传给 `AgentDataService`：

```ts
      codeRetrieval: {
        projects: () => codeGraph.projects(),
        status: (workspace) => codeGraph.status(workspace) as unknown as Record<string, unknown>,
        search: (workspace, query, limit) => codeGraph.search(workspace, query, limit) as unknown as Promise<Record<string, unknown>>,
      },
在 `jobRunners` 里追加 `codegraph.sync`（`wiki.sync` 那条在任务 11 已写好，保持不动）。这个 runner 自己写全部终态，因此不依赖 `admin.jobs.create` 里的兜底 `.catch`：

```ts
        'codegraph.sync': {
          run: async (id, workspace) => {
            await agentData.request('admin.jobs.start', { id });
            try {
              await codeGraph.runSync(id, workspace);
              await agentData.request('admin.jobs.complete', { id });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              // cancelSync() 只 kill 进程、不写状态，所以取消会以 rejection 形式到达这里；
              // 必须落成 cancelled 而不是 failed。
              if (message.includes('cancelled')) await agentData.request('admin.jobs.markCancelled', { id });
              else await agentData.request('admin.jobs.fail', { id, error: message });
            }
          },
          cancel: (id) => codeGraph.cancelSync(id),
        },
```

在 `registerIpcHandlers` 里 `pi:` 服务的 `openWorkspace` 之后登记路径 —— 最简做法是在 `registerIpcHandlers` 调用前包一层：把 `pi: piRuntime = new PiRuntimeService({...})` 的 `resolveWorkspace` 回调改为顺带登记：

```ts
        resolveWorkspace: async (path) => {
          const resolved = await workspace.ensureWorkspace(path);
          knownWorkspaces.add(resolved);
          return resolved;
        },
```

并在 `before-quit` 里加上池子清理：

```ts
      void codeGraph.close();
```

- [ ] **步骤 7：运行测试与构建验证**

运行：

```bash
cd electron-agent
npx vitest run electron/agentData electron/app/codeGraph electron/ipc
npm run build
```

预期：全部 PASS，构建退出码 0。

- [ ] **步骤 8：Commit**

```bash
git add electron-agent/electron/app/codeGraph/codeGraphService.ts electron-agent/electron/agentData/runtime.ts electron-agent/electron/agentData/runtime.test.ts electron-agent/electron/ipc electron-agent/src/lib/agentData.ts electron-agent/electron/main.ts
git commit -m "feat(codegraph): 接入真实索引状态、检索与同步执行器"
```

### 任务 17：CodeRetrievalPanel 强制项目选择器

**背景：** 代码符号图不能跨仓库合并，所以这个面板与 Memory/Wiki 不同：项目选择器是必选项。选择器要列出**全部**已注册项目（不只是已索引的），未索引的项目选中后显示同步入口，否则用户无法给一个非当前活跃的项目建索引。

**文件：**
- 修改：`electron-agent/src/features/agentData/CodeRetrievalPanel.tsx`
- 测试：`electron-agent/src/features/agentData/CodeRetrievalPanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

把 `CodeRetrievalPanel.test.tsx` 整体替换为：

```tsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeRetrievalPanel } from './CodeRetrievalPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { code: { projects: vi.fn(), status: vi.fn(), search: vi.fn() }, jobs: { create: vi.fn() } },
}));
vi.mock('./useProjectOptions', () => ({
  useProjectOptions: () => [{ cwd: 'D:/proj/alpha', name: 'alpha' }, { cwd: 'D:/proj/beta', name: 'beta' }],
}));
import { agentDataApi } from '../../lib/agentData';

describe('CodeRetrievalPanel', () => {
  beforeEach(() => {
    vi.mocked(agentDataApi.code.projects).mockResolvedValue([
      { workspace: 'D:/proj/alpha', indexed: true },
      { workspace: 'D:/proj/beta', indexed: false },
    ]);
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/proj/alpha', connected: true, indexed: true, state: 'indexed', files: 12, nodes: 34, edges: 56 });
    vi.mocked(agentDataApi.code.search).mockResolvedValue({ workspace: 'D:/proj/alpha', available: true, results: [{ file: 'src/a.ts', line: 3, symbol: 'parse' }] });
    vi.mocked(agentDataApi.jobs.create).mockResolvedValue({ id: 'job-1', kind: 'codegraph.sync', workspace: 'D:/proj/beta', state: 'pending', progress: 0, createdAt: 1, updatedAt: 1 });
  });

  it('requires an explicit project before showing anything', async () => {
    render(<CodeRetrievalPanel />);
    expect(await screen.findByText('请选择一个项目')).toBeTruthy();
    expect(agentDataApi.code.status).not.toHaveBeenCalled();
  });

  it('queries the selected indexed project', async () => {
    render(<CodeRetrievalPanel />);
    await waitFor(() => expect(agentDataApi.code.projects).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/proj/alpha' } });

    await waitFor(() => expect(agentDataApi.code.status).toHaveBeenCalledWith('D:/proj/alpha'));
    fireEvent.change(screen.getByLabelText('搜索代码'), { target: { value: 'parse' } });
    expect(await screen.findByText('src/a.ts')).toBeTruthy();
  });

  it('offers to index a selected project that has no index yet', async () => {
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/proj/beta', connected: false, indexed: false, state: 'unavailable' });
    render(<CodeRetrievalPanel />);
    await waitFor(() => expect(agentDataApi.code.projects).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/proj/beta' } });

    expect(await screen.findByText('该项目尚未建立 CodeGraph 索引')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '同步索引' }));
    // 同步目标是当前选中项目，而不是应用的活跃工作区。
    await waitFor(() => expect(agentDataApi.jobs.create).toHaveBeenCalledWith({ kind: 'codegraph.sync', workspace: 'D:/proj/beta' }));
  });

  it('preselects the initial project but keeps manual choices afterwards', async () => {
    const { rerender } = render(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    await waitFor(() => expect(agentDataApi.code.status).toHaveBeenCalledWith('D:/proj/alpha'));

    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:/proj/beta' } });
    await waitFor(() => expect(agentDataApi.code.status).toHaveBeenLastCalledWith('D:/proj/beta'));

    rerender(<CodeRetrievalPanel initialProject="D:/proj/alpha" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agentDataApi.code.status).toHaveBeenLastCalledWith('D:/proj/beta');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run src/features/agentData/CodeRetrievalPanel.test.tsx`

预期：FAIL。当前组件没有项目选择器，也没有 `code.projects` 调用。

- [ ] **步骤 3：编写实现**

把 `CodeRetrievalPanel.tsx` 替换为：

```tsx
import { useEffect, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { agentDataApi, type CodeGraphProject, type CodeGraphStatus, type CodeSearchResult } from '../../lib/agentData';
import { styles } from './agentDataStyles';
import { useProjectOptions } from './useProjectOptions';

interface CodeRetrievalPanelProps {
  /** 仅作为选择器的初始值；用户手动切换后不再跟随其变化。 */
  initialProject?: string;
  onJobCreated?: () => void;
}

export function CodeRetrievalPanel({ initialProject, onJobCreated }: CodeRetrievalPanelProps) {
  const options = useProjectOptions();
  // 代码符号图不能跨仓库合并，所以这里是「必选」而不是「筛选」。
  const [project, setProject] = useState<string>(initialProject ?? '');
  const [indexState, setIndexState] = useState<CodeGraphProject[]>([]);
  const [status, setStatus] = useState<CodeGraphStatus>();
  const [results, setResults] = useState<CodeSearchResult[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void agentDataApi.code.projects()
      .then((value) => { if (!cancelled) setIndexState(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!project) { setStatus(undefined); return; }
    let cancelled = false;
    setLoading(true);
    void agentDataApi.code.status(project)
      .then((value) => { if (!cancelled) setStatus(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [project]);

  useEffect(() => {
    if (!project || !status?.indexed || !query.trim()) { setResults([]); return; }
    let cancelled = false;
    void agentDataApi.code.search(project, query.trim(), 20)
      .then((value) => { if (!cancelled) { setResults(value.results); if (!value.available && value.message) setError(value.message); } })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [project, status?.indexed, query]);

  const sync = async () => {
    if (!project) return;
    setSyncing(true);
    try { await agentDataApi.jobs.create({ kind: 'codegraph.sync', workspace: project }); onJobCreated?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSyncing(false); }
  };

  const indexedOf = (cwd: string) => indexState.find((entry) => entry.workspace === cwd)?.indexed ?? false;

  return <section data-testid="code-retrieval-panel">
    <div className={styles.sectionHeading}><h3 className={styles.heading}>Code Retrieval</h3><span className={styles.hint}>{project || '未选择项目'}</span></div>
    <div className={styles.toolbar}>
      <select className={styles.select} aria-label="项目" value={project} onChange={(event) => setProject(event.target.value)}>
        <option value="">请选择项目</option>
        {options.map((option) => <option key={option.cwd} value={option.cwd}>{option.name}{indexedOf(option.cwd) ? '' : '（未索引）'}</option>)}
      </select>
      {project ? <button type="button" className={styles.actionButton} onClick={() => void sync()} disabled={syncing}><RefreshCw size={12} />同步索引</button> : null}
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {!project ? <div className={styles.state}>请选择一个项目</div>
      : loading ? <div className={styles.state}>正在检查 CodeGraph...</div>
      : !status?.indexed ? <div className={styles.state}><strong>该项目尚未建立 CodeGraph 索引</strong><div>点「同步索引」为该项目建立索引。</div></div>
      : <>
        <div className={styles.statusGrid}><div className={styles.card}>
          <div className={styles.statusRow}><span className={styles.statusName}>索引状态</span><span className={styles.statusValue}>{status.state ?? 'indexed'}</span></div>
          <div className={styles.statusRow}><span className={styles.statusName}>文件 / 节点 / 边</span><span className={styles.statusValue}>{status.files ?? 0} / {status.nodes ?? 0} / {status.edges ?? 0}</span></div>
        </div></div>
        <div className={styles.toolbar}><div className={styles.input} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Search size={13} />
          <input aria-label="搜索代码" placeholder="搜索文件或符号" value={query} onChange={(event) => setQuery(event.target.value)} style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'inherit' }} />
        </div></div>
        {results.length === 0 ? <div className={styles.state}>输入关键词检索代码</div>
          : <table className={styles.table}>
            <thead><tr><th>文件</th><th>行号</th><th>符号</th><th>内容</th></tr></thead>
            <tbody>{results.map((result, index) => <tr key={`${result.file}:${result.line ?? index}`}>
              <td>{result.file}</td><td>{result.line ?? '-'}</td><td>{result.symbol ?? '-'}</td><td>{result.snippet ?? ''}</td>
            </tr>)}</tbody>
          </table>}
      </>}
  </section>;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run src/features/agentData/CodeRetrievalPanel.test.tsx`

预期：PASS，4 个用例通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/agentData/CodeRetrievalPanel.tsx electron-agent/src/features/agentData/CodeRetrievalPanel.test.tsx
git commit -m "feat(codegraph): 面板改为强制项目选择器并支持为未索引项目建索引"
```

---

## 阶段四：面板整合与解耦

### 任务 18：AgentDataCenter 概览默认全局并与对话切换解耦

**背景：** `AgentDataCenter.refresh()` 目前 `if (userId && workspace)` 才请求三个 overview，`useEffect(..., [userId, workspace])` 让切对话即整面板重查。改成：概览默认全局（Memory/Wiki 不再需要 workspace），Code 卡片显式要求选定项目；`workspace` 只作为子面板筛选器的初始值下传，不再作为 effect 依赖。

**文件：**
- 修改：`electron-agent/src/features/agentData/AgentDataCenter.tsx`
- 测试：`electron-agent/src/features/agentData/AgentDataCenter.test.tsx`

- [ ] **步骤 1：编写失败的测试**

把 `AgentDataCenter.test.tsx` 整体替换为：

```tsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDataCenter } from './AgentDataCenter';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: {
    status: vi.fn(),
    jobs: { list: vi.fn(), create: vi.fn(), cancel: vi.fn() },
    memory: { overview: vi.fn(), search: vi.fn(), delete: vi.fn() },
    wiki: { overview: vi.fn(), search: vi.fn() },
    code: { projects: vi.fn(), status: vi.fn(), search: vi.fn() },
  },
}));
vi.mock('./useProjectOptions', () => ({
  useProjectOptions: () => [{ cwd: 'D:/proj/alpha', name: 'alpha' }],
}));
import { agentDataApi } from '../../lib/agentData';

describe('AgentDataCenter', () => {
  beforeEach(() => {
    vi.mocked(agentDataApi.status).mockResolvedValue({ state: 'ready', version: 1 });
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue([]);
    vi.mocked(agentDataApi.memory.overview).mockResolvedValue({ total: 248, byLevel: { L0: 120, L1: 64, L2: 48, L3: 16 } });
    vi.mocked(agentDataApi.memory.search).mockResolvedValue([]);
    vi.mocked(agentDataApi.wiki.overview).mockResolvedValue({ pages: 12, latestUpdatedAt: 100 });
    vi.mocked(agentDataApi.wiki.search).mockResolvedValue([]);
    vi.mocked(agentDataApi.code.projects).mockResolvedValue([]);
  });

  it('loads global memory and wiki overviews without any workspace', async () => {
    render(<AgentDataCenter userId="u" />);
    expect(await screen.findByText('248')).toBeTruthy();
    expect(agentDataApi.memory.overview).toHaveBeenCalledWith({ userId: 'u', includeOtherProjects: true });
    expect(agentDataApi.wiki.overview).toHaveBeenCalledWith(undefined);
    // Code 概览不预取：它需要用户先选项目。
    expect(agentDataApi.code.status).not.toHaveBeenCalled();
  });

  it('does not refetch when the initial workspace prop changes', async () => {
    const { rerender } = render(<AgentDataCenter userId="u" initialProject="D:/proj/alpha" />);
    await waitFor(() => expect(agentDataApi.memory.overview).toHaveBeenCalledTimes(1));

    rerender(<AgentDataCenter userId="u" initialProject="D:/proj/beta" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agentDataApi.memory.overview).toHaveBeenCalledTimes(1);
  });

  it('switches views and surfaces runtime failures', async () => {
    render(<AgentDataCenter userId="u" />);
    expect(await screen.findByText('248')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
    expect(screen.getByTestId('memory-panel')).toBeTruthy();
  });

  it('shows runtime failures in the shared error state', async () => {
    vi.mocked(agentDataApi.status).mockRejectedValueOnce(new Error('runtime unavailable'));
    render(<AgentDataCenter userId="u" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('runtime unavailable'));
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run src/features/agentData/AgentDataCenter.test.tsx`

预期：FAIL。当前组件缺 `workspace` 时把三个 overview 置为 null，且 `initialProject` 不是它的 prop。

- [ ] **步骤 3：编写实现**

修改 `AgentDataCenter.tsx`。props 与状态：

```tsx
interface AgentDataCenterProps {
  userId?: string;
  /** 仅作为各子面板筛选器的初始值；面板打开后不再跟随对话/项目切换。 */
  initialProject?: string;
}
```

`refresh()` 里的条件分支去掉，改为始终请求全局概览（Code 不预取）：

```tsx
  const refresh = async () => {
    setLoading(true);
    try {
      setError(undefined);
      const [nextStatus, nextJobs] = await Promise.all([agentDataApi.status(), agentDataApi.jobs.list()]);
      setStatus(nextStatus);
      setJobs(nextJobs);
      // Memory/Wiki 默认统计全部项目；Code 需要显式选定项目，概览里不预取。
      const [nextMemory, nextWiki] = await Promise.all([
        userId ? agentDataApi.memory.overview({ userId, includeOtherProjects: true }) : Promise.resolve(null),
        agentDataApi.wiki.overview(undefined),
      ]);
      setMemory(nextMemory);
      setWiki(nextWiki);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  // 刻意只依赖 userId：initialProject 变化（用户在侧栏切对话）不应该重查整个面板。
  useEffect(() => { void refresh(); }, [userId]);
```

删掉 `code` 状态与 `agentDataApi.code.status` 调用；把三个子面板的 props 换成新签名：

```tsx
        {tab === 'memory' && !loading ? <MemoryPanel userId={userId} initialProject={initialProject} /> : null}
        {tab === 'wiki' && !loading ? <WikiPanel initialProject={initialProject} onJobCreated={() => setTab('jobs')} /> : null}
        {tab === 'code' && !loading ? <CodeRetrievalPanel initialProject={initialProject} onJobCreated={() => setTab('jobs')} /> : null}
```

`Overview` 的 Code 卡片改为提示选择项目，`workspace` 相关文案换成全局口径：

```tsx
function Overview({ status, jobs, memory, wiki }: { status: AgentDataStatus | null; jobs: AgentJob[]; memory: MemoryOverview | null; wiki: WikiOverview | null }) {
  return <>
    <div className={styles.sectionHeading}><h3 className={styles.heading}>数据概览</h3><span className={styles.hint}>全部项目</span></div>
    <div className={styles.kpis}>
      <Kpi label="Memory" value={memory?.total ?? '-'} meta={memory ? `L0-L3 · ${memory.byLevel.L0}/${memory.byLevel.L1}/${memory.byLevel.L2}/${memory.byLevel.L3}` : '未加载'} />
      <Kpi label="Wiki 页面" value={wiki?.pages ?? '-'} meta={wiki ? formatTime(wiki.latestUpdatedAt) : '未加载'} />
      <Kpi label="Code 索引" value="—" meta="在 Code Retrieval 选择项目查看" />
      <Kpi label="任务" value={jobs.length} meta={status?.state === 'ready' ? 'Runtime 就绪' : 'Runtime 未就绪'} />
    </div>
    <div className={styles.sectionHeading}><h3 className={styles.heading}>模块状态</h3></div>
    <div className={styles.statusGrid}>
      <StatusCard name="Memory Runtime" value={memory ? 'ready' : '未加载'} />
      <StatusCard name="Wiki 索引" value={wiki ? `${wiki.pages} pages` : '未加载'} />
      <StatusCard name="Code Retrieval" value="按项目查看" />
    </div>
    <div className={styles.sectionHeading}><h3 className={styles.heading}>最近任务</h3><span className={styles.hint}>{jobs.length} 项</span></div>
    <JobsPreview jobs={jobs} />
  </>;
}
```

对应地更新 `Overview` 的调用点（去掉 `code` 与 `workspace` 两个 prop），以及顶部 header 的副标题：

```tsx
          <div className={styles.subtitle}>全部项目 · {jobs.length} 个任务</div>
```

同时移除文件顶部不再使用的 `CodeGraphStatus` 类型 import。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run src/features/agentData/AgentDataCenter.test.tsx`

预期：PASS，4 个用例通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/agentData/AgentDataCenter.tsx electron-agent/src/features/agentData/AgentDataCenter.test.tsx
git commit -m "feat(agent-data): 概览默认全局并与对话切换解耦"
```

### 任务 19：ModuleContainer 传参语义调整

**背景：** `ModuleContainer` 现在传 `workspace={workspace || undefined}`，语义是"强制过滤条件"。改成 `initialProject`，语义是"面板筛选器的初始值"。

**文件：**
- 修改：`electron-agent/src/features/workspace/ModuleContainer.tsx:24`
- 测试：`electron-agent/src/features/workspace/ModuleContainer.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`ModuleContainer.test.tsx` 里把 mock 与断言换成新 prop 名：

```tsx
vi.mock('../agentData/AgentDataCenter', () => ({ AgentDataCenter: ({ userId, initialProject }: { userId?: string; initialProject?: string }) => <div>AGENT_DATA:{userId}:{initialProject}</div> }));
```

```tsx
  it('passes the active workspace as the panel initial project', () => {
    useModuleStore.setState({ activeModule: 'agentData' });
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.getByText('AGENT_DATA:local:/workspace')).toBeTruthy();
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run src/features/workspace/ModuleContainer.test.tsx`

预期：FAIL，渲染出 `AGENT_DATA:local:`（`initialProject` 为 undefined，因为组件仍传 `workspace`）。

- [ ] **步骤 3：编写实现**

`ModuleContainer.tsx` 的 `agentData` 分支：

```tsx
    case 'agentData':
      // 只作为面板筛选器的初始值：面板打开后不跟随对话/项目切换（见 AgentDataCenter 注释）。
      return <AgentDataCenter userId="local" initialProject={workspace || undefined} />;
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run src/features/workspace/ModuleContainer.test.tsx`

预期：PASS，全部用例通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/workspace/ModuleContainer.tsx electron-agent/src/features/workspace/ModuleContainer.test.tsx
git commit -m "refactor(agent-data): workspace 传参语义改为筛选器初始值"
```

### 任务 20：JobsPanel 适配全局语义

**背景：** `JobsPanel` 的"创建任务"表单目前依赖父组件传入的 `workspace`（`if (onCreate && workspace)` 才渲染）。父组件不再持有"当前工作区"这个强制概念，创建任务的入口应该从 Wiki/Code 两个面板发起（它们各自知道目标项目）。把 JobsPanel 收敛成纯粹的"列表 + 取消"。

**文件：**
- 修改：`electron-agent/src/features/agentData/JobsPanel.tsx`
- 修改：`electron-agent/src/features/agentData/AgentDataCenter.tsx`（去掉 `onCreate`/`workspace` 传参）
- 测试：`electron-agent/src/features/agentData/JobsPanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

把 `JobsPanel.test.tsx` 整体替换为：

```tsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsPanel } from './JobsPanel';

vi.mock('../../lib/agentData', () => ({
  agentDataApi: { jobs: { list: vi.fn(), cancel: vi.fn() } },
}));
import { agentDataApi } from '../../lib/agentData';

const jobs = [
  { id: 'job-1', kind: 'wiki.sync', workspace: 'D:/proj/alpha', state: 'running' as const, progress: 40, createdAt: 1, updatedAt: 2 },
  { id: 'job-2', kind: 'codegraph.sync', workspace: 'D:/proj/beta', state: 'failed' as const, progress: 0, error: 'codegraph exited (1)', createdAt: 1, updatedAt: 3 },
];

describe('JobsPanel', () => {
  beforeEach(() => {
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue(jobs);
    vi.mocked(agentDataApi.jobs.cancel).mockResolvedValue(jobs[0]);
  });

  it('lists jobs from every workspace with their progress and failure reason', () => {
    render(<JobsPanel jobs={jobs} />);
    expect(screen.getByText('wiki.sync')).toBeTruthy();
    expect(screen.getByText('D:/proj/beta')).toBeTruthy();
    expect(screen.getByText('codegraph exited (1)')).toBeTruthy();
    expect(screen.getByText('40%')).toBeTruthy();
  });

  it('cancels a running job and refreshes', async () => {
    const onRefresh = vi.fn();
    render(<JobsPanel jobs={jobs} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: /取消/ }));
    await waitFor(() => expect(agentDataApi.jobs.cancel).toHaveBeenCalledWith('job-1'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('filters by state', () => {
    render(<JobsPanel jobs={jobs} />);
    fireEvent.change(screen.getByLabelText('任务状态'), { target: { value: 'failed' } });
    expect(screen.queryByText('wiki.sync')).toBeNull();
    expect(screen.getByText('codegraph.sync')).toBeTruthy();
  });

  it('does not offer a create form because sync is triggered from its own module', () => {
    render(<JobsPanel jobs={jobs} />);
    expect(screen.queryByRole('button', { name: '创建任务' })).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run src/features/agentData/JobsPanel.test.tsx`

预期：FAIL。取消按钮的 accessible name 是 `取消`（含图标），`onCreate` 分支仍在类型里。

- [ ] **步骤 3：编写实现**

`JobsPanel.tsx` 的 props 去掉 `workspace` 与 `onCreate`：

```tsx
interface JobsPanelProps {
  jobs?: AgentJob[];
  onRefresh?: () => Promise<void> | void;
}

export function JobsPanel({ jobs: inputJobs, onRefresh }: JobsPanelProps) {
```

删除 `creating` / `newKind` 两个 state、`create()` 函数，以及工具栏里的创建表单片段（`{onCreate && workspace ? <>...</> : null}` 整段）。搜索占位文案改为"搜索任务或项目"。其余（状态筛选、进度条、取消）不动。

`AgentDataCenter.tsx` 的 jobs tab 调用同步简化：

```tsx
        {tab === 'jobs' && !loading ? <JobsPanel jobs={jobs} onRefresh={refresh} /> : null}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run src/features/agentData/JobsPanel.test.tsx src/features/agentData/AgentDataCenter.test.tsx`

预期：PASS，两个测试文件全部通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/agentData/JobsPanel.tsx electron-agent/src/features/agentData/JobsPanel.test.tsx electron-agent/src/features/agentData/AgentDataCenter.tsx
git commit -m "refactor(jobs): 任务面板收敛为列表与取消，创建入口交给各模块"
```

### 任务 21：全量验证

- [ ] **步骤 1：运行 electron-agent 全量测试**

运行：

```bash
cd electron-agent
npx vitest run
```

预期：全部 PASS。已知例外：`electron/agentData/memoryStore.test.ts` 的 `stores project and global scope metadata and filters across projects` 用例是既有 flaky（同毫秒时间戳下 `ORDER BY updated_at DESC` 排序不稳定），与本次改动无关；若失败请重跑该文件确认，不要为它改生产代码。

- [ ] **步骤 2：运行 extensions 测试确认未被波及**

运行：

```bash
cd extensions
npx vitest run
```

预期：全部 PASS。本计划没有修改任何扩展代码（Wiki 同步走主进程编排器，不碰 `extensions/wiki-rag`），此步只为确认没有意外破坏。

- [ ] **步骤 3：构建验证**

运行：

```bash
cd electron-agent
npm run build
```

预期：`tsc -p tsconfig.json` 与 `electron-vite build` 均退出码 0。第三方依赖的 `use client` 警告可以出现，但不能有 TypeScript 错误。

- [ ] **步骤 4：人工验收清单**

启动应用（`cd electron-agent; npm run dev`），逐项确认：

1. 打开"Agent 数据" → 概览显示 Memory/Wiki 的全局统计，不再出现"未绑定工作区"。
2. 停在 Memory tab，回到"对话"切换到另一个项目，再切回"Agent 数据" → Memory 仍是全局视图（不被动切成某个项目）。
3. Memory tab 的"项目范围"选一个项目 → 列表只剩该项目的 L1 + 全部全局 L2/L3；"归属"列能看到"全局"或来源项目名。
4. Wiki tab 默认全局搜索能跨项目命中，结果表"项目"列显示来源；选定项目后"同步 Wiki"可点击，任务 tab 能看到 job 从 pending → running → completed，进度递增。
5. Code tab 不选项目时显示"请选择一个项目"；选一个未索引的项目显示"该项目尚未建立 CodeGraph 索引"并可点"同步索引"；同步完成后该项目变为可检索。
6. 任务 tab 对一个 running 的 job 点"取消" → 状态变为已取消，且后台进程真的停止（同步不再继续推进进度）。

- [ ] **步骤 5：Commit（若人工验收发现需要修补）**

```bash
git add -A electron-agent
git commit -m "fix(agent-data): 人工验收修补"
```

---

## 计划自检

**规格覆盖度：**

| 设计文档章节 | 对应任务 |
| --- | --- |
| 3.1 L2/L3 写入 global | 任务 1 |
| 3.2 读取默认全局（类型 + IPC 透出） | 任务 3、4 |
| 3.3 Memory 面板筛选器 | 任务 5、6 |
| 4.1 Wiki 写入不变 | 无需改动（任务 7 只改查询，`replacePage` 保持 `PRIMARY KEY(workspace,page)`） |
| 4.2 Wiki 读取默认全局 | 任务 7 |
| 4.3 Wiki 同步执行器 | 任务 8（job 状态方法）、9（worker kind）、10（编排器）、11（接线） |
| 5.1 索引运行时探测 | 任务 13 |
| 5.2 CodeGraph 同步执行器 + 并发拒绝 | 任务 14、11（`hasActive` 拒绝逻辑在 `admin.jobs.create`）、16 |
| 5.3 实例池 | 任务 15 |
| 5.4 强制项目选择器 | 任务 17 |
| 6 取消真正终止后台工作 | 任务 10（Wiki 双检查点协作式取消）、14（CodeGraph kill 子进程）、11（`admin.jobs.cancel` 改为"请求"语义，终态由执行器通过 `admin.jobs.markCancelled` 落定）、16（CodeGraph 把取消 rejection 落成 cancelled 而非 failed） |
| 7 面板信息架构 | 任务 18、19、20 |
| 10 测试范围 | 各任务的测试步骤 + 任务 21 全量验证 |

**额外发现并纳入的必需项（设计文档未单列，但缺了会有 bug）：**
- 任务 2：`MemoryStore.remove()` 的 workspace 约束会让全局视图跨项目删除静默失败。
- 任务 20：`JobsPanel` 的创建表单依赖父组件的 `workspace`，与"父组件不再持有强制工作区"冲突。

**占位符扫描：** 无"待定"/"TODO"/"类似任务 N"/"添加适当的错误处理"。每个代码步骤都给出了完整可粘贴的代码，每个测试步骤都给出了完整测试代码与预期失败信息。

**类型一致性核对：**
- `MemoryScope`（渲染层，任务 4 定义 `{ userId; workspace?; projectId?; sessionId?; includeOtherProjects? }`）在任务 6 的 `MemoryPanel` 中按此构造，字段名一致。
- `WikiScope` / `WikiWriteScope` / `WikiSearchHit`（任务 7 定义）在任务 12 的面板中按 `WikiSearchResult`（渲染层同构类型）消费，`workspace` 字段贯通。
- `WikiSyncJobPort` 的六个方法（`start`/`progress`/`complete`/`fail`/`markCancelled`/`cancelled`，任务 10 定义）在任务 11 的 `main.ts` 装配处逐一实现：前四个映射到任务 8 的同名 `JobStore` 方法，`markCancelled` 映射到 `admin.jobs.markCancelled`（内部调 `JobStore.cancel`），`cancelled` 由 `wikiCancelled` 集合实现。
- `CodeGraphInstancePool` 的 `call`/`invalidate`/`closeAll`（任务 15 定义）在任务 16 的 `CodeGraphService` 中按此调用。
- `CodeGraphSyncRunner` 的 `run`/`cancel`（任务 14 定义）在任务 16 中按此调用。
- `AgentDataJobRunner` 的 `run(jobId, workspace)`/`cancel(jobId)`（任务 11 定义）在任务 11（wiki）与任务 16（codegraph）两处装配签名一致。
- `initialProject` 这个 prop 名在任务 6、12、17、18、19 五处保持一致（不曾出现 `initialWorkspace` 等变体）。

**范围检查：** 本计划聚焦"Agent 数据面板的作用域模型 + 两个同步执行器"，可以在一个实现周期内完成并独立验证。设计文档第 9 节列出的排除项（Team/ACL、LLM 驱动的场景合并、跨项目二次提炼、统一资产列表、CLI 自动安装、精细进度解析）在本计划中均无对应任务，未被夹带进来。
