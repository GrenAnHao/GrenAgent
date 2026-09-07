# Agent 数据工作台第三阶段：Memory 与代码详情实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让用户浏览、阅读和维护真实 Memory 记录，并在明确的代码项目中查看源码与调用关系。

**架构：** Memory 管理继续使用 `MemoryStore` / `MemoryService`，通过第二阶段的主进程 `requestAdmin` 接入；既有 Agent 搜索和捕获接口保持兼容。代码面板接入既有七种只读 CodeGraph RPC，不修改共享工具协议或实例池。两面板消费第一阶段的任务监视 Context，刷新时保留用户正在阅读或编辑的内容。

**技术栈：** TypeScript、React、Ant Design / Lobe、Node SQLite、Electron IPC、Vitest / Testing Library。

**执行状态（2026-09-05）：任务 1–8 已完成。** 下方原步骤与代码块保留为实施依据，不从示例复选框重新执行；实际接口细节、审查修复与最终验证见文末交付记录。

---

## 执行边界与前置条件

- 设计依据：`docs/superpowers/specs/2026-09-05-agent-data-workbench-design.md` 第 3、5、7、11 节。
- 本文件是实施计划。编写计划期间不执行数据库迁移、安装、索引构建、模型调用、提交或工作区清理。
- 第一阶段已交付面板保活、`visible`、项目显示选项和 `AgentDataTaskProvider.tsx`。使用 `useProjectOptions()`，不引入持久化项目目录注册表；选项只能来自真实项目，不能把临时会话目录补回列表。
- 第二阶段已交付 `AgentDataRuntime.requestAdmin<T>(method, params={})`、`AgentDataService.requestAdmin<T>` 及 `AgentDataRuntimeOptions.validateProject?: (workspace: string) => Promise<string>`。校验函数在主进程执行 `realpath`、目录检查与临时会话根排除，返回规范化路径；不创建目录。Memory 复用该装配，不改变自动捕获临时会话的规则。
- 新增 Memory 管理方法只接受主进程的管理调用；不能通过 `params.admin`、`includeOtherProjects` 或省略项目扩大项目端权限。所有 Store 查询和按 ID 写入都包含 `user_id`。
- 运行下列命令前将目录切至 `electron-agent`，检查 `node_modules/.bin/vitest.cmd` 与 `node_modules/.bin/tsc.cmd`；本次计划编写不安装依赖。实施时运行 `npm test -- <测试路径>` 与任务 8 的类型检查命令；依赖缺失不算红测成功。
- 实施人员保留工作区已有改动；本计划不要求提交。每个任务验收后用精确路径检查 diff，再进入下一任务。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `electron-agent/electron/agentData/memoryContracts.ts`（新） | 管理页输入、分页、所有权和版本 DTO；不复写旧 `MemoryScope` |
| `electron-agent/electron/agentData/memoryStore.ts` | 游标查询、捕获原文读取、稳定 ID 人工写入、旧表兼容和自动版本保护 |
| `electron-agent/electron/app/memoryService.ts` | 管理 API 编排、项目校验；保留捕获队列与提炼流程 |
| `electron-agent/electron/agentData/runtime.ts` | 管理路由进入 `requestAdmin`，与 socket 的旧 Memory 方法分开 |
| `electron-agent/electron/ipc/register.ts`、`electron-agent/electron/ipc/contracts.ts` | 管理命令与只读 CodeGraph 命令桥接、DTO 类型导出 |
| `electron-agent/src/lib/agentData.ts` | 新增类型化 Memory 方法与 CodeGraph `call`，保留旧方法 |
| `electron-agent/src/features/agentData/useMemoryBrowser.ts`（新） | 50 条分页、300ms 防抖、请求代次、后台刷新状态 |
| `electron-agent/src/features/agentData/MemoryList.tsx`（新） | 两行摘要、记忆/捕获列表、选中与加载更多 |
| `electron-agent/src/features/agentData/MemoryDetail.tsx`（新） | 可读 JSON、完整文本、来源状态及只读捕获详情 |
| `electron-agent/src/features/agentData/MemoryEditor.tsx`（新） | 新增、归属选择、人工保存、冲突草稿与键盘行为 |
| `electron-agent/src/features/agentData/memoryPresentation.ts`（新） | 内容呈现和已存在会话匹配的纯函数 |
| `electron-agent/src/features/agentData/MemoryPanel.tsx` | 组合列表/详情/编辑，保存筛选与选择，消费任务刷新版本 |
| `electron-agent/src/features/agentData/codeResult.ts`（新） | 只读 MCP 结果解包；保留原始结果与未知值 |
| `electron-agent/src/features/agentData/CodeProjectList.tsx`、`electron-agent/src/features/agentData/CodeSourceDetail.tsx`、`electron-agent/src/features/agentData/CodeRelations.tsx`（新） | 真实项目列表、源码行定位、调用者/被调用者/影响列表 |
| `electron-agent/src/features/agentData/CodeRetrievalPanel.tsx` | 项目内查询、请求隔离、索引任务跟踪 |
| `electron-agent/src/features/agentData/agentDataStyles.ts` | 现有主题 token 下的列表/详情布局与窄屏行为 |
| `electron-agent/src/App.tsx`、`electron-agent/src/features/workspace/ModuleContainer.tsx`、`electron-agent/src/features/agentData/AgentDataCenter.tsx` | 透传现有会话打开回调；不新造会话路径或另建文件 Dock |

测试文件与其被测文件同目录，按下方任务列出的文件创建或扩展。

## Contracts：先固定名字与语义

在 `memoryContracts.ts` 单一定义基础 `MemoryRecord`，`memoryStore.ts` 导入并 re-export，renderer 通过 `ipc/contracts.ts` 的 type-only 导出复用，删除 renderer 那份重复 interface。基础字段及可选性保持原样，旧 `search/upsert` 继续返回基础类型。新管理 DTO 命名 `ManagedMemoryRecord`，版本与人工标记只在该 DTO 中必填，旧调用者和无关 mock 不需要补字段。旧 L0 仍是旧记忆记录，捕获列表不向 `memories` 插入 L0。

```ts
export type MemoryOwner = { scope: 'global' } | { scope: 'project'; projectId: string };
export type MemoryFilter = { scope: 'all' } | MemoryOwner;
export type MemoryLevel = 0 | 1 | 2 | 3;
export type MemoryOrigin = 'automatic' | 'manual';
export interface MemoryRecord {
  id: string; level: MemoryLevel; content: string; source?: string;
  sourceProjectId?: string; scope?: 'global' | 'project';
  createdAt: number; updatedAt: number;
}
export interface ManagedMemoryRecord extends MemoryRecord {
  scope: 'global' | 'project';
  sourceSessionId?: string; sourceWorkspace?: string;
  revision: number;
  origin: MemoryOrigin; contentHash: string;
}
export interface MemoryListInput {
  userId: string; filter: MemoryFilter; query?: string; level?: MemoryLevel;
  cursor?: string; limit?: number;
}
export interface MemoryPage<T> { items: T[]; nextCursor?: string }
export interface MemoryReadInput { userId: string; id: string }
export interface MemoryDraft {
  content: string; level: MemoryLevel; owner: MemoryOwner; source?: string;
}
export interface MemoryCreateInput { userId: string; draft: MemoryDraft }
export interface MemoryUpdateInput extends MemoryCreateInput {
  id: string; expectedRevision: number;
}
export interface MemoryConversation {
  id: string; source: string; sourceSessionId?: string; workspace: string;
  sourceProjectId: string; snippet: string; updatedAt: number;
}
export interface MemoryConversationDetail extends MemoryConversation { transcript: string }
export type MemoryItem =
  | { kind: 'memory'; record: ManagedMemoryRecord }
  | { kind: 'conversation'; record: MemoryConversation };
```

管理 API / Store / Service 命名固定如下；Store 同步返回，Service 与 renderer 返回 Promise。`memory.search`、`memory.capture`、`memory.conversations.search` 继续使用原有参数和结果，空查询浏览调用新 `list`。

| renderer 方法 | 管理 RPC | Store / Service 方法与返回值 |
| --- | --- | --- |
| `memory.list(input)` | `memory.list` | `list(input): MemoryPage<ManagedMemoryRecord>` |
| `memory.read(input)` | `memory.read` | `read(input): ManagedMemoryRecord` |
| `memory.create(input)` | `memory.create` | `create(input): ManagedMemoryRecord` |
| `memory.update(input)` | `memory.update` | `update(input): ManagedMemoryRecord` |
| `memory.delete({userId, workspace?}, id)` | `memory.delete` | 管理分支调用 `remove({userId, workspace:''}, id)`；兼容旧签名，删除不涉及捕获表 |
| `memory.conversations.list(input)` | `memory.conversations.list` | `listConversations(input): MemoryPage<MemoryConversation>` |
| `memory.conversations.read(input)` | `memory.conversations.read` | `readConversation(input): MemoryConversationDetail` |

`read/update` 对未知 ID 或其它用户记录统一返回 `NOT_FOUND`；过期保存返回 `VERSION_CONFLICT`。`create` 只允许 L1/L2/L3；旧 L0 仍可阅读，编辑旧 L0 时保持原 level，不提供新建 L0。`draft.owner` 必填；更新不得从当前聊天项目补值。

UI 的固定接口：

```ts
// useMemoryBrowser.ts
export interface MemoryBrowserInput {
  userId?: string; filter: MemoryFilter; query: string; level?: MemoryLevel;
  kind: 'memory' | 'conversation'; visible: boolean; reloadVersion: number;
}
// 返回 items: MemoryItem[], nextCursor?: string, loading: boolean,
// refreshing: boolean, error?: string, loadMore(): Promise<void>, refresh(): Promise<void>。

// MemoryList.tsx
export interface MemoryListProps {
  items: MemoryItem[]; selectedId?: string; nextCursor?: string; refreshing: boolean;
  onSelect(item: MemoryItem): void; onLoadMore(): void;
}
// MemoryEditor.tsx
export interface MemoryEditorProps {
  userId: string; record?: ManagedMemoryRecord; projects: Array<{cwd: string; name: string}>;
  onSaved(record: ManagedMemoryRecord): void; onCancel(): void;
}
// MemoryDetail.tsx：捕获详情没有 onEdit/onDelete 控件。
export type MemoryDetailProps = {
  value: {kind:'memory';record:ManagedMemoryRecord} |
         {kind:'conversation';record:MemoryConversationDetail};
  onEdit?: () => void; onDelete?: () => void;
  onOpenSession?: (cwd:string, path:string) => void;
};
```

`AgentDataTaskProvider.tsx` 提供无参 `useAgentDataTaskMonitor()`，返回 `{jobs, refresh, track(id), watchedTaskVersion, error?}`。第一阶段的 track 用 `useCallback([activeView])` 绑定回调生成时的面板，不从 latest ref 读取归属。创建按钮 handler 在 await 前捕获该回调，任务返回后调用它，立即刷新并跟踪终态；用户等待创建时切标签也不会改变归属。`watchedTaskVersion` 是跟踪任务首次到达终态时递增的全局数字。本阶段不创建第二个 interval，也不把新任务创建后跳转任务标签。

Code 类型在 `src/lib/agentData.ts` 增加，保持 `electron/agentData/codeRetrievalProtocol.ts` 的七工具协议原样。它们是 renderer 的输入类型，`call` 结果仍是 `unknown`，不声明不存在的统一关系图 schema。

```ts
export type CodeKind='function'|'method'|'class'|'interface'|'type'|'variable'|'route'|'component';
export type CodeSymbolArgs={symbol:string;file?:string;limit?:number;depth?:number};
export type CodeNodeArgs=({symbol:string;file?:string}|{file:string;symbol?:string}) &
  {includeCode?:boolean;offset?:number;limit?:number;symbolsOnly?:boolean;line?:number;depth?:number};
export interface CodeArgsByTool {
  codegraph_search:{query:string;kind?:CodeKind;limit?:number};
  codegraph_explore:{query:string;maxFiles?:number;limit?:number};
  codegraph_callers:CodeSymbolArgs; codegraph_callees:CodeSymbolArgs;
  codegraph_impact:CodeSymbolArgs; codegraph_node:CodeNodeArgs;
  codegraph_files:{path?:string;pattern?:string;format?:'tree'|'flat'|'grouped';includeMetadata?:boolean;maxDepth?:number};
}
export type CodeTool=keyof CodeArgsByTool;
export type CodeRetrievalRequest={
  [T in CodeTool]:{workspace:string;tool:T;args:CodeArgsByTool[T]}
}[CodeTool];
// codeResult.ts 的 UI 视图；raw 永远保留，未识别和真实空集分别表示。
export interface CodeResultRow {file?:string;line?:number;symbol?:string;snippet?:string}
export interface CodeResultView {
  rows:CodeResultRow[];text?:string;raw:unknown;isError:boolean;
  recognition:'rows'|'text'|'unknown';message?:string;
}
// decodeCodeResult(tool:CodeTool,raw:unknown):CodeResultView
// CodeSourceDetailProps={workspace:string;file:string;line?:number;onClose?:()=>void}
// CodeRelationsProps={workspace:string;symbol:string;file?:string;visible:boolean}
```

### 任务 1：Memory 的最近记录与捕获原文游标 API

**文件：** 创建 `electron-agent/electron/agentData/memoryContracts.ts`、`electron-agent/electron/agentData/memoryStore.browse.test.ts`；修改 `electron-agent/electron/agentData/memoryStore.ts` 的类型、列表/读取与索引；修改 `electron-agent/electron/ipc/contracts.ts` 的类型导出。

- [ ] **1. 写红测。** 将以下完整测试放入 `memoryStore.browse.test.ts`。

```ts
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { MemoryStore } from './memoryStore';

it('pages empty-query memories and reads captures without crossing users', () => {
  const db = new DatabaseSync(':memory:');
  const now = vi.spyOn(Date, 'now').mockReturnValue(100);
  try {
    const store = new MemoryStore(db);
    for (let i = 0; i < 51; i++)
      store.upsert({userId:'u',workspace:'/a'}, {level:1,content:`fact ${i}`});
    store.upsert({userId:'other',workspace:'/a'}, {level:1,content:'private'});
    const input = {userId:'u',filter:{scope:'all' as const},query:'',limit:50};
    const a = store.list(input);
    const b = store.list({...input,cursor:a.nextCursor});
    expect(a.items).toHaveLength(50);
    expect(b.items).toHaveLength(1);
    expect(new Set([...a.items,...b.items].map(r => r.id)).size).toBe(51);
    expect(b.nextCursor).toBeUndefined();
    expect(store.list({...input,query:'%'}).items).toEqual([]);
    expect(() => store.read({userId:'other',id:a.items[0].id})).toThrow('memory not found');
    store.capture({userId:'u',workspace:'/a',sessionId:'s'}, 'session:s', 'user: raw only', 'fp');
    const captures = store.listConversations(input);
    expect(captures.items).toHaveLength(1);
    expect(captures.items[0]).not.toHaveProperty('transcript');
    expect(store.readConversation({userId:'u',id:captures.items[0].id}).transcript).toBe('user: raw only');
    expect(store.list({...input,query:'raw only'}).items).toEqual([]);
    expect(store.listConversations({...input,userId:'other'}).items).toEqual([]);
    expect(() => store.list({...input,query:'fact',cursor:a.nextCursor})).toThrow('invalid memory cursor');
  } finally { now.mockRestore(); db.close(); }
});
```

- [ ] **2. 运行红测。** `npm test -- electron/agentData/memoryStore.browse.test.ts`；预期 `store.list is not a function`。不能把 SQLite 无法加载算作该失败。
- [ ] **3. 实现 Store 查询。** `memories` 与 `memory_captures` 各增 `(user_id, updated_at DESC, 主键 DESC)` 索引。查询使用 `limit+1` 判定下一页，输入 limit 默认 50、范围 1..50。排序固定为 `updated_at DESC,id DESC`。游标是 base64url JSON `{v:1,updatedAt,id,filterHash}`；`filterHash` 对 `userId/filter/query.trim().toLowerCase()/level/kind` 的固定顺序 JSON 求 hash。解码检查字段类型、有限时间戳、版本与 filterHash，失败抛 `RpcError('INVALID_PARAMS','invalid memory cursor')`。

```sql
-- 把此条件追加到同一份 user/filter/query/level WHERE 后，不能用 OFFSET。
AND (updated_at < ? OR (updated_at = ? AND id < ?))
ORDER BY updated_at DESC, id DESC LIMIT ?
-- 记忆查询用 instr(lower(content), ?)；捕获查询用 instr(lower(transcript), ?)。
-- 空字符串不追加关键词条件，% 和 _ 都按普通文本查找。
```

过滤规则明确写在 Store：`all` 只加 `user_id=?`；`global` 加 `memory_scope='global'`；`project` 加 `memory_scope='project' AND COALESCE(project_id,workspace)=?`。管理页选某项目时不混入全局记录；旧 Agent `search` 仍召回项目与全局。捕获没有全局层，`global` 返回空页；`project` 使用 `COALESCE(project_id,workspace)`。捕获摘要取命中前最多 200 字与后续片段，总长最多 1200；空查询取开头。详情按 `user_id+capture_key` 返回原文，不删 pending，不发提炼任务。任务 2 尚未增加新列时，映射旧记录返回 revision=1、origin=automatic 和现算 contentHash；任务 2 完成后改为读取已回填列。session_id/workspace 映射为 sourceSessionId/sourceWorkspace，不把 owner 和捕获来源混成一个字段。
- [ ] **4. 运行绿测。** `npm test -- electron/agentData/memoryStore.browse.test.ts electron/agentData/memoryStore.test.ts`。追加同一文件中的断言覆盖项目 A/B 与全局过滤、越权读捕获、非法游标、51 个同毫秒捕获分页；使用测试内相同的 `DatabaseSync(':memory:')` 和 `store.capture` 构造，不引用外部夹具。预期新旧测试通过。
- [ ] **5. 验收。** 空查询首屏 50 条；下一页无重复 ID；不跨 user；捕获原文不占 Memory L0 计数。检查 `git diff -- electron/agentData/memoryStore.ts electron/ipc/contracts.ts`。

### 任务 2：稳定 ID、人工保护与旧 fingerprint 兼容

**文件：** 修改 `electron-agent/electron/agentData/memoryStore.ts`；创建 `electron-agent/electron/agentData/memoryStore.manual.test.ts`；扩展 `electron-agent/electron/agentData/memoryStore.test.ts` 的旧表测试。

- [ ] **1. 写红测。** 新测试明确覆盖“自动条目连续两次被人工改写后重新提炼原内容”。

```ts
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { MemoryStore } from './memoryStore';

it('keeps each edited ID and allocates an automatic slot without overwriting humans', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new MemoryStore(db);
    const scope = {userId:'u',workspace:'/a',projectId:'/a',sessionId:'s'};
    const draft = (content:string) => ({content,level:1 as const,owner:{scope:'project' as const,projectId:'/a'}});
    const originalId = store.upsert(scope,{level:1,content:'generated'}).id;
    const original = store.read({userId:'u',id:originalId});
    const manual1 = store.update({userId:'u',id:original.id,expectedRevision:original.revision,draft:draft('edited one')});
    const auto1Id = store.upsert(scope,{level:1,content:'generated'}).id;
    const auto1 = store.read({userId:'u',id:auto1Id});
    const manual2 = store.update({userId:'u',id:auto1.id,expectedRevision:auto1.revision,draft:draft('edited two')});
    const auto2 = store.upsert(scope,{level:1,content:'generated'});
    expect(new Set([manual1.id,manual2.id,auto2.id]).size).toBe(3);
    expect(manual1.id).toBe(original.id);
    expect(manual1).toMatchObject({origin:'manual',revision:2});
    expect(store.upsert(scope,{level:1,content:'generated'}).id).toBe(auto2.id);
    expect(store.read({userId:'u',id:manual1.id}).content).toBe('edited one');
    expect(store.read({userId:'u',id:manual2.id}).content).toBe('edited two');
    expect(() => store.update({userId:'u',id:manual1.id,expectedRevision:1,draft:draft('stale')})).toThrow('memory version conflict');
    expect(() => store.update({userId:'other',id:manual1.id,expectedRevision:2,draft:draft('attack')})).toThrow('memory not found');
    const row = db.prepare('SELECT fingerprint,content_hash FROM memories WHERE id=?').get(manual1.id);
    expect(row).toMatchObject({fingerprint:`manual:${manual1.id}`,content_hash:createHash('sha256').update('1:edited one').digest('hex').slice(0,32)});
    expect(new MemoryStore(db).read({userId:'u',id:manual1.id}).revision).toBe(2);
  } finally { db.close(); }
});
```

- [ ] **2. 运行红测。** `npm test -- electron/agentData/memoryStore.manual.test.ts`；预期 `store.update is not a function`。
- [ ] **3. 实现原子写入。** 用现有 `ensureColumn` 增加 `origin TEXT NOT NULL DEFAULT 'automatic'`、`revision INTEGER NOT NULL DEFAULT 1`、`content_hash TEXT NOT NULL DEFAULT ''`。只为 `content_hash=''` 的旧行计算内容 hash；不改旧 `id/fingerprint`，不重建旧 UNIQUE，不合并旧重复记录。再开数据库不递增 revision。

```ts
function contentHash(level:number, content:string):string {
  return createHash('sha256').update(`${level}:${content}`).digest('hex').slice(0,32);
}
// fingerprint 是去重键；人工版本改用独立命名空间，内容完整性另由 content_hash 表示。
function manualFingerprint(id:string):string { return `manual:${id}`; }
```

`create` 用 `randomUUID()` 产生稳定 ID，内容 trim 后非空，`origin='manual'`、`revision=1`、fingerprint=`manual:${id}`。项目创建的 `workspace/project_id` 均使用 Service 校验后的路径；全局创建存 `workspace=''`、`project_id=NULL`、`memory_scope='global'`，不借用 `'.'` 或临时会话目录。

`update` 在 `BEGIN IMMEDIATE` 内按 `user_id+id` 读取并比较 `expectedRevision`。所有权只更新 `project_id/memory_scope`；保留已有 `workspace/session_id` 的捕获来源语义。source 字段未变化时保留来源；source 被用户改为自由文本时清空 `session_id`，不凭新文本声明存在会话。一次 UPDATE 写入 `content/level/source/project_id/memory_scope/fingerprint/content_hash/origin/revision/updated_at`，WHERE 仍包含 `id/user_id/revision`；`changes!==1` 回滚并抛 `VERSION_CONFLICT`。成功提交后 read 返回同一 ID。SQL 核心如下，参数全部使用绑定值：

```sql
UPDATE memories SET content=?,level=?,source=?,project_id=?,memory_scope=?,
  session_id=?,fingerprint=?,content_hash=?,origin='manual',revision=revision+1,updated_at=?
WHERE id=? AND user_id=? AND revision=?;
```

自动 `upsert` 保持原内容 fingerprint 与旧 ID 算法，按以下顺序在同一写事务中执行：

1. 按原 fingerprint、`user_id/workspace/session_id IS ?/level` 查已有 `origin='automatic'` 行，按创建时间与 ID 稳定选中，优先复用，避免 NULL session 绕过去重。
2. 没有自动行才尝试旧内容 ID。若该 ID 已是 manual，依次试 `hash(oldId + ':auto:' + n)`（n 从 1 开始）。命中 manual 继续；命中不同用户或作用域拒绝；命中相同自动行复用；空位插入。`UNIQUE` 仍提供最后的数据库保护。
3. 自动写入的 UPDATE 加 `WHERE user_id=? AND origin='automatic'`，同时维护 content_hash、revision 和 fingerprint。传入显式 ID 的 Store 调用不得强写 manual，抛 `MANUAL_MEMORY_LOCKED`。Runtime 旧 `memory.upsert` 目前忽略请求 id，继续保持这项兼容行为；管理页只用 `create/update`，不能把“透传 id”当成修复编辑的方案。

- [ ] **4. 运行绿测。** `npm test -- electron/agentData/memoryStore.manual.test.ts electron/agentData/memoryStore.test.ts electron/agentData/memoryStore.browse.test.ts`。旧表测试保留手工 INSERT 的旧 id/fingerprint，并断言只补 `origin='automatic'/revision=1/content_hash`；新增全局人工创建、归属更改后旧项目不召回/新项目可召回、两个同文人工条目 ID 不同、NULL session 自动重试不重复的断言。
- [ ] **5. 验收。** 人工修改和全局/项目移动保持 ID；过期/越权写入不改变任何列；自动提炼保留两份人工记录与一个自动记录，不违反现有 UNIQUE。

### 任务 3：Memory 管理服务、RPC 与 renderer IPC

**文件：** 修改 `electron-agent/electron/app/memoryService.ts`、`electron-agent/electron/agentData/runtime.ts`、`electron-agent/electron/ipc/register.ts`、`electron-agent/src/lib/agentData.ts`；创建 `electron-agent/electron/agentData/runtime.memoryManagement.test.ts`；扩展 `electron-agent/electron/app/memoryService.test.ts`、`electron-agent/electron/ipc/register.test.ts`、`electron-agent/src/lib/agentData.test.ts`。

- [ ] **1. 写红测。** 使用内存 Runtime 和本任务明确定义的项目校验器，不访问模型或真实数据库。

```ts
import { expect, it } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';

it('admits management through requestAdmin and validates project ownership', async () => {
  const runtime = new AgentDataRuntime({dataPath:':memory:',validateProject:async path => {
    if (path !== '/real') throw new Error('project directory is not available');
    return '/real';
  }});
  const client = new AgentDataClient(await runtime.start());
  try {
    const input = {userId:'u',draft:{level:1,content:'manual',owner:{scope:'project',projectId:'/real'}}};
    const made = await runtime.requestAdmin<{id:string;revision:number}>('memory.create',input);
    expect(made.revision).toBe(1);
    await expect(runtime.requestAdmin('memory.read',{userId:'other',id:made.id})).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(runtime.requestAdmin('memory.update',{...input,id:made.id,expectedRevision:0})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
    await expect(runtime.requestAdmin('memory.create',{...input,draft:{...input.draft,owner:{scope:'project',projectId:'/scratch'}}})).rejects.toThrow('project directory is not available');
    await expect(client.request('memory.list',{userId:'u',filter:{scope:'all'},admin:true})).rejects.toMatchObject({code:'METHOD_NOT_FOUND'});
    await client.request('memory.capture',{userId:'u',workspace:'/real',source:'session:s',sessionId:'s',transcript:'user: raw',fingerprint:'fp',extract:false});
    await expect(runtime.requestAdmin('memory.conversations.list',{userId:'u',filter:{scope:'all'}})).resolves.toMatchObject({items:[expect.objectContaining({source:'session:s'})]});
    await expect(client.request('memory.search',{userId:'u',workspace:'/else',query:'manual'})).resolves.toEqual([]);
  } finally { await client.close(); runtime.close(); }
});
```

- [ ] **2. 运行红测。** `npm test -- electron/agentData/runtime.memoryManagement.test.ts`；前置阶段存在 `requestAdmin` 后，预期新增方法 `METHOD_NOT_FOUND`。
- [ ] **3. 接入管理分支。** `MemoryServiceOptions` 增加可选 `validateProject`，create 和所有权实际改变为项目时调用它；缺校验器拒绝项目人工写入，全局人工写入不需要目录。更新前先按 user+id 读取，来源项目已移除但 owner 未改的编辑保留原 owner，不把临时目录或当前聊天项目填入。Runtime 将校验器传给 MemoryService，在 `requestAdmin` 的分派中增加管理方法；socket 的 `memoryMethod` 不增加 list/read/create/update/conversations.list/read。

```ts
// register.ts：新增命令固定转 requestAdmin，保留原始参数供 Runtime 完整校验。
registerCommand('agentData_memory_update', (_event,args) =>
  services.agentData!.requestAdmin('memory.update', args));
// agentData.ts：不要在 transport 层补 owner 或 revision。
update: (input: MemoryUpdateInput) => invoke<ManagedMemoryRecord>('agentData_memory_update', input),
list: (input: MemoryListInput) => invoke<MemoryPage<ManagedMemoryRecord>>('agentData_memory_list', input),
```

同表映射逐项注册 `agentData_memory_list/read/create/update/conversations_list/conversations_read`。renderer 的 delete 接原签名，但管理 handler 改为 `requestAdmin('memory.delete',{userId,id})`。`preload.ts` 已使用通用 invoke，不新增绕过注册的直通命令。IPC 跨进程的冲突消息使用固定可识别前缀 `VERSION_CONFLICT: memory version conflict`，renderer 同时识别 `error.code` 与该前缀；不能假定 Electron 保留 Error 自定义属性。
- [ ] **4. 运行绿测。** `npm test -- electron/agentData/runtime.memoryManagement.test.ts electron/app/memoryService.test.ts electron/agentData/runtime.extensions.test.ts electron/ipc/register.test.ts electron/ipc/commandCoverage.test.ts src/lib/agentData.test.ts`。在已有 `register.test.ts` 的 `handler` 夹具中为每个新增命令断言 `requestAdmin` 而非 `request`，在 API 测试中用 `vi.spyOn(runtime,'invoke')` 断言 user/filter/id/revision/owner 原样传递。保持原 `memory.search/capture` 测试全绿。
- [ ] **5. 验收。** 管理入口的调用者不能读写另一 user 的 ID；项目人工写入校验只读；新建 Memory 不入提炼队列；原 Agent 搜索仍按项目及原有全局规则执行。

### 任务 4：可浏览列表、可读详情与来源会话

**文件：** 创建 `electron-agent/src/features/agentData/useMemoryBrowser.ts`、`electron-agent/src/features/agentData/useMemoryBrowser.test.tsx`、`electron-agent/src/features/agentData/MemoryList.tsx`、`electron-agent/src/features/agentData/MemoryDetail.tsx`、`electron-agent/src/features/agentData/MemoryDetail.test.tsx`、`electron-agent/src/features/agentData/memoryPresentation.ts`、`electron-agent/src/features/agentData/memoryPresentation.test.ts`；修改 `electron-agent/src/features/agentData/MemoryPanel.tsx`、`electron-agent/src/features/agentData/MemoryPanel.test.tsx`、`electron-agent/src/features/agentData/agentDataStyles.ts`；为会话回调修改 `electron-agent/src/App.tsx`、`electron-agent/src/features/workspace/ModuleContainer.tsx`、`electron-agent/src/features/agentData/AgentDataCenter.tsx`。

- [ ] **1. 写防抖/乱序红测。** mock 在本文件内完整声明，初始空页请求也被计入。

```tsx
// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMemoryBrowser } from './useMemoryBrowser';
import { agentDataApi, type MemoryPage, type ManagedMemoryRecord } from '../../lib/agentData';
vi.mock('../../lib/agentData',()=>({agentDataApi:{memory:{
  list:vi.fn(),conversations:{list:vi.fn()}
}}}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.clearAllMocks();});
it('loads recent records, debounces 300ms and ignores an old response',async()=>{
  vi.useFakeTimers();
  let releaseOld!:(value:MemoryPage<ManagedMemoryRecord>)=>void;
  const memory=(content:string):ManagedMemoryRecord=>({id:content,content,level:1,scope:'global',origin:'manual',revision:1,contentHash:content,createdAt:1,updatedAt:1});
  vi.mocked(agentDataApi.memory.list).mockResolvedValue({items:[]});
  const {result,rerender}=renderHook(({query})=>useMemoryBrowser({userId:'u',filter:{scope:'all'},query,kind:'memory',visible:true,reloadVersion:0}),{initialProps:{query:''}});
  await act(async()=>{});
  expect(agentDataApi.memory.list).toHaveBeenCalledWith(expect.objectContaining({query:'',limit:50}));
  vi.mocked(agentDataApi.memory.list).mockImplementationOnce(()=>new Promise(resolve=>{releaseOld=resolve;}));
  rerender({query:'old'});
  await act(async()=>{await vi.advanceTimersByTimeAsync(299);});
  expect(agentDataApi.memory.list).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
  vi.mocked(agentDataApi.memory.list).mockResolvedValue({items:[memory('new result')]});
  rerender({query:'new'});
  await act(async()=>{await vi.advanceTimersByTimeAsync(300);});
  await act(async()=>{releaseOld({items:[memory('old result')]});});
  expect(agentDataApi.memory.list).toHaveBeenLastCalledWith(expect.objectContaining({query:'new'}));
  expect(result.current.items.map(item=>item.record.id)).toEqual(['new result']);
  expect(result.current.error).toBeUndefined();
});
```

- [ ] **2. 运行红测。** `npm test -- src/features/agentData/useMemoryBrowser.test.tsx`；预期缺少 `useMemoryBrowser` 模块。
- [ ] **3. 实现列表与详情。** `useMemoryBrowser` 的每次 filter/kind/query/level/user 变化递增请求代次并丢弃旧 cursor；effect 依赖 filter 的规范化 scope/projectId 字符串，不依赖每次 render 新建的对象引用。有效空 query 立即 list，非空 query 在 300ms 后 list。loadMore 捕获同一代次和 cursor，重复点击期间禁用；追加前按 ID 去重。visible=false 时使代次失效并清计时器，保留列表；再次显示按最新筛选刷新。失败只设置 error，保留已有 items；scope/kind 改变时清上一个域的结果，不能把旧项目结果标成新项目。实现中使用以下判定，代次在输入变化时立即递增，不能等防抖结束才递增：

```ts
// useMemoryBrowser 内部的请求函数，generation 是 useRef(0)，代次由 effect 分配。
async function loadPage(input:MemoryListInput, epoch:number, append:boolean):Promise<void> {
  try {
    const page = kind === 'memory'
      ? await agentDataApi.memory.list(input)
      : await agentDataApi.memory.conversations.list(input);
    if (epoch !== generation.current) return;
    const next:MemoryItem[] = page.items.map(record => kind === 'memory'
      ? {kind:'memory',record:record as ManagedMemoryRecord}
      : {kind:'conversation',record:record as MemoryConversation});
    setItems(current => append
      ? [...current,...next.filter(item => !current.some(old => old.record.id === item.record.id))]
      : next);
    setNextCursor(page.nextCursor); setError(undefined);
  } catch (cause) {
    if (epoch === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
  } finally {
    if (epoch === generation.current) { setLoading(false); setRefreshing(false); }
  }
}
```

列表用“记忆 / 对话记录”切换、`全部项目/全局/真实项目` 筛选；类型显示“事实与偏好/场景摘要/长期画像”，旧 L0 标“历史记录 · L0”。对话标签隐藏 level 筛选，并说明捕获记录没有全局层。overview 仍是已有全局摘要，固定标注“本用户记忆总数”，不把它冒充当前筛选结果总数。`MemoryList` 使用列表内按钮选中记录，摘要最多两行，加载更多不会取消当前选择。详情单独 `read`，使用独立请求代次；JSON.parse 成功时按字段/数组显示，原始 JSON 放折叠区；无法解析按文本显示，不把 JSON 字符串直接截断成主内容。

来源函数只匹配已存在会话：

```ts
import type { SessionInfo } from '../../lib/pi';
import { pathsEquivalent } from '../../lib/pathUtils';
export function findSourceSession(
  source:{source?:string;sourceSessionId?:string;sourceWorkspace?:string;origin?:string},
  sessions:SessionInfo[],
):SessionInfo|undefined {
  const id = source.sourceSessionId ?? (source.origin === 'manual' ? undefined : /^session:(.+)$/.exec(source.source ?? '')?.[1]);
  return id ? sessions.find(session => session.id === id && Boolean(session.cwd)
    && (!source.sourceWorkspace || pathsEquivalent(session.cwd!,source.sourceWorkspace))) : undefined;
}
```

详情打开时调用已有 `pi.listAllSessions()` 取真实列表；捕获 DTO 调用匹配函数前以其 workspace 映射 sourceWorkspace。读取失败显示“来源状态未获取”，已查无匹配显示“会话已移除”，未记录 session 标识显示来源文本/“未记录来源”。点击“打开会话”前再查一次；只能把匹配到的 `cwd/path` 传给回调。完整回调链为 `App.handleOpenSession → ModuleContainer.onOpenSession → AgentDataCenter.onOpenSession → MemoryPanel → MemoryDetail`；App 包装现有 handler 并 `setActiveModule('chat')`，不新增会话、不拼 JSONL 路径。对话详情显示时间/来源/命中片段及全文，不提供编辑删除按钮。
- [ ] **4. 运行绿测。** `npm test -- src/features/agentData/useMemoryBrowser.test.tsx src/features/agentData/MemoryPanel.test.tsx src/features/agentData/MemoryDetail.test.tsx src/features/agentData/memoryPresentation.test.ts`。扩展测试覆盖旧请求拒绝不盖新结果、翻页后筛选清 cursor、后台失败保留正文、raw 无编辑按钮、来源缺失无可点击链接。
- [ ] **5. 验收。** 空查询能打开最近记录；显示技术层级但不把捕获冒充 L0；隐藏/再显示保留本地筛选；阅读其它面板或切聊天项目不重置 Memory 筛选。

### 任务 5：人工新增、归属编辑、冲突草稿和删除

**文件：** 创建 `electron-agent/src/features/agentData/MemoryEditor.tsx`、`electron-agent/src/features/agentData/MemoryEditor.test.tsx`；修改 `electron-agent/src/features/agentData/MemoryPanel.tsx`、`electron-agent/src/features/agentData/MemoryPanel.test.tsx` 与 `electron-agent/src/features/agentData/MemoryDetail.tsx` 的操作接线。

- [ ] **1. 写冲突红测。** 不依赖后台运行；测试固定完整旧记录。

```tsx
// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {MemoryEditor} from './MemoryEditor';
import {agentDataApi,type ManagedMemoryRecord} from '../../lib/agentData';
vi.mock('../../lib/agentData',()=>({agentDataApi:{memory:{create:vi.fn(),update:vi.fn(),read:vi.fn()}}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('preserves a draft and its owner when the saved revision is stale',async()=>{
  const record:ManagedMemoryRecord={id:'m',level:1,content:'old',scope:'global',revision:1,origin:'manual',contentHash:'h',createdAt:1,updatedAt:1};
  vi.mocked(agentDataApi.memory.update).mockRejectedValue(new Error('VERSION_CONFLICT: memory version conflict'));
  const saved=vi.fn();
  render(<MemoryEditor userId="u" record={record} projects={[{cwd:'/a',name:'A'}]} onSaved={saved} onCancel={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('记忆内容'),{target:{value:'my unsaved edit'}});
  fireEvent.click(screen.getByRole('button',{name:'保存记忆'}));
  expect(await screen.findByText('记录已被修改，你的草稿已保留')).toBeTruthy();
  expect((screen.getByLabelText('记忆内容') as HTMLTextAreaElement).value).toBe('my unsaved edit');
  expect(agentDataApi.memory.update).toHaveBeenCalledWith({userId:'u',id:'m',expectedRevision:1,draft:{content:'my unsaved edit',level:1,owner:{scope:'global'},source:undefined}});
  expect(saved).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'重新载入记录'})).toBeTruthy();
});
```

- [ ] **2. 运行红测。** `npm test -- src/features/agentData/MemoryEditor.test.tsx`；预期缺少 Editor 模块。
- [ ] **3. 实现编辑抽屉。** 表单状态在打开时从 record 初始化，背景刷新不能覆盖表单。新增默认 L1，归属字段默认未选择；用户必须显式选择“全局”或下拉中的真实项目。编辑从原 `scope/sourceProjectId` 初始化，即使该项目后来不在选项中也显示“原项目已不可用”，保留其值；改变归属显示“项目记忆仅该项目召回；全局记忆可被各项目召回”。scope 变更由用户选择保存，不联动聊天项目。

```ts
// MemoryEditor 内部；content/level/owner/source 均来自受控表单。
const [baseRecord,setBaseRecord]=useState(record);
async function save():Promise<void> {
  if (saving || !content.trim() || !owner) return;
  setSaving(true); setError(undefined);
  const draft:MemoryDraft={content:content.trim(),level,owner,source};
  try {
    const value=baseRecord
      ? await agentDataApi.memory.update({userId,id:baseRecord.id,expectedRevision:baseRecord.revision,draft})
      : await agentDataApi.memory.create({userId,draft});
    onSaved(value);
  } catch (cause) {
    const message=cause instanceof Error ? cause.message : String(cause);
    setError(message.includes('VERSION_CONFLICT') ? '记录已被修改，你的草稿已保留' : message);
  } finally { setSaving(false); }
}
```

冲突时保持 content/owner/source，显示“重新载入记录”；点击后先确认放弃草稿，再 `read` 取得新记录、调用 setBaseRecord 并重置表单，下一次保存必须使用新 revision。Ctrl+S 调 save 并阻止浏览器默认保存；Escape/关闭时若 dirty 用确认框，取消确认仍留在编辑器。保存期间禁用重复保存，失败不关闭。成功把返回记录更新进选中详情，刷新列表和 overview；若新归属不匹配当前筛选，提示“已保存，当前筛选不包含该记录”，不要凭空把它追加进列表。

删除沿用稳定 ID 确认，快照 `{id,userId}`，确认文案说明“不删除来源对话”；删除成功后清除该选中项、刷新列表/overview，来源捕获条数不变。失败保留条目与选中状态。焦点关闭后返回原编辑/新增触发按钮；列表删除后移到相邻记录按钮。
- [ ] **4. 运行绿测。** `npm test -- src/features/agentData/MemoryEditor.test.tsx src/features/agentData/MemoryPanel.test.tsx src/features/agentData/MemoryDetail.test.tsx`。增加无 owner 禁用保存、临时会话不入项目选项、Ctrl+S 只提交一次、Escape 取消确认保留草稿、删除失败保留内容、删除成功刷新计数的测试。
- [ ] **5. 验收。** 新增不默认归属临时会话；人工版本可继续编辑；并发冲突不丢草稿；删除只移除 Memory 记录。

### 任务 6：七种只读 CodeGraph 工具的类型化桥接与结果解包

**文件：** 修改 `electron-agent/src/lib/agentData.ts`、`electron-agent/electron/ipc/register.ts`、`electron-agent/electron/ipc/commandCoverage.test.ts`；创建 `electron-agent/src/lib/agentDataCodeBridge.test.ts`、`electron-agent/src/features/agentData/codeResult.ts`、`electron-agent/src/features/agentData/codeResult.test.ts`。桥接测试放 src/lib，避免 Node composite 测试反向纳入 renderer 源文件。生产代码不修改 `electron-agent/electron/agentData/codeRetrievalProtocol.ts`、`electron-agent/electron/app/codeGraph/instancePool.ts` 或 `electron-agent/electron/app/codeGraph/syncRunner.ts`。

- [ ] **1. 写桥接红测。** 完整覆盖七种调用，不依赖 CLI 或索引。

```ts
import {afterEach,expect,it,vi} from 'vitest';
const electron=vi.hoisted(()=>({ipcMain:{handle:vi.fn()},dialog:{showOpenDialog:vi.fn()},shell:{openExternal:vi.fn(),openPath:vi.fn(),showItemInFolder:vi.fn()}}));
vi.mock('electron',()=>electron);
import {registerIpcHandlers,type IpcServices} from '../../electron/ipc/register';
import {IPC_CHANNELS} from '../../electron/ipc/contracts';
import {agentDataApi,type CodeRetrievalRequest} from './agentData';
const workspace='D:/proj/alpha';
const cases:CodeRetrievalRequest[]=[
  {workspace,tool:'codegraph_search',args:{query:'parse',limit:5}},
  {workspace,tool:'codegraph_explore',args:{query:'parse',maxFiles:3}},
  {workspace,tool:'codegraph_callers',args:{symbol:'parse',file:'src/a.ts'}},
  {workspace,tool:'codegraph_callees',args:{symbol:'parse',file:'src/a.ts'}},
  {workspace,tool:'codegraph_impact',args:{symbol:'parse',depth:2}},
  {workspace,tool:'codegraph_node',args:{file:'src/a.ts',line:3,includeCode:true}},
  {workspace,tool:'codegraph_files',args:{path:'src',format:'flat',includeMetadata:true}},
];
afterEach(()=>{vi.unstubAllGlobals();electron.ipcMain.handle.mockReset();});
it.each(cases)('preserves $tool arguments and raw MCP results',async input=>{
  const raw={content:[{type:'text',text:'opaque result'}],structuredContent:{opaque:[input.tool]},isError:input.tool==='codegraph_impact'};
  const request=vi.fn(async()=>raw);
  registerIpcHandlers({agentData:{request}} as unknown as IpcServices);
  vi.stubGlobal('window',{gren:{invoke:async(command:string,args:Record<string,unknown>)=>{
    const entry=electron.ipcMain.handle.mock.calls.find(([channel])=>channel===IPC_CHANNELS.invoke);
    if(!entry)throw new Error('missing invoke handler');
    return entry[1]({},{command,args});
  }}});
  await expect(agentDataApi.code.call(input)).resolves.toEqual(raw);
  expect(request).toHaveBeenCalledWith('codeRetrieval.call',input);
});
```

- [ ] **2. 运行红测。** `npm test -- src/lib/agentDataCodeBridge.test.ts`；预期 `agentDataApi.code.call is not a function`。补 API 后若漏掉 register，应继续因未注册命令失败。
- [ ] **3. 实现单一桥接与保守解包。** 新增 `agentData_code_call` 转发已有 `codeRetrieval.call`，保留 workspace/tool/args 三字段。沿用后端 `readCodeRetrievalTool/validateCodeRetrievalArgs`，UI 不提供 `projectPath`、任意工具名或写工具；通用 preload 无需改动。

```ts
// agentData.ts
call:(input:CodeRetrievalRequest)=>invoke<unknown>('agentData_code_call',input),
// register.ts
registerCommand('agentData_code_call',(_event,args)=>services.agentData!.request('codeRetrieval.call',{
  workspace:readString(args,'workspace'),tool:readString(args,'tool'),args:readRecord(args,'args'),
}));
```

`decodeCodeResult` 保留 raw，提取 `content` 中 text 块并以换行连接，保留 `isError===true`。优先识别 structuredContent 为数组的结果，再尝试 text 的 JSON 数组；只将含 `file/path` 或 `symbol/name` 字符串的对象转为 row。`line` 必须正整数，缺失仍为 undefined，不能补 1 或 0。已有搜索输出的 `path:line` 文本格式可按行解析为 row；无法解析时显示 text/raw，不以 `rows.length===0` 宣称真实空集。JSON 空数组才是已识别空集。其它 structuredContent 对象原样折叠展示，不猜测其中 `nodes/edges` 的领域含义。

```ts
// codeResult.test.ts：完整独立测试，先运行确认新模块缺失，再实现解包。
import {expect,it} from 'vitest';
import {decodeCodeResult} from './codeResult';
it('distinguishes unknown output, errors and an actual empty result',()=>{
  const raw={content:[{type:'text',text:'provider prose'}],structuredContent:{opaque:true},isError:true};
  const view=decodeCodeResult('codegraph_callers',raw);
  expect(view).toMatchObject({raw,isError:true,recognition:'text',text:'provider prose'});
  expect(decodeCodeResult('codegraph_search',{content:[{type:'text',text:'[]'}]})).toMatchObject({rows:[],recognition:'rows'});
  const rows=decodeCodeResult('codegraph_search',{content:[{type:'text',text:'[{"file":"a.ts","symbol":"parse"}]'}]}).rows;
  expect(rows).toEqual([{file:'a.ts',symbol:'parse',line:undefined,snippet:undefined}]);
});
```

- [ ] **4. 运行绿测。** `npm test -- src/lib/agentDataCodeBridge.test.ts src/features/agentData/codeResult.test.ts electron/ipc/commandCoverage.test.ts electron/agentData/codeRetrievalProtocol.test.ts electron/agentData/runtime.extensions.test.ts electron/app/codeGraph/codeGraphService.test.ts`。预期传参/raw/error 保真，现有拒绝越界路径、错误工具和缺 provider 测试继续通过。
- [ ] **5. 验收。** 查询不会建立索引或绕开工具白名单；未知结构可读取原文；未知统计不生成数值。

### 任务 7：真实代码项目、源码位置和调用关系工作区

**文件：** 创建 `electron-agent/src/features/agentData/CodeProjectList.tsx`、`electron-agent/src/features/agentData/CodeSourceDetail.tsx`、`electron-agent/src/features/agentData/CodeSourceDetail.test.tsx`、`electron-agent/src/features/agentData/CodeRelations.tsx`、`electron-agent/src/features/agentData/CodeRelations.test.tsx`、`electron-agent/src/features/agentData/CodeRetrievalPanel.workbench.test.tsx`；修改 `electron-agent/src/features/agentData/CodeRetrievalPanel.tsx`、`electron-agent/src/features/agentData/CodeRetrievalPanel.test.tsx`、`electron-agent/src/features/agentData/agentDataStyles.ts`。复用 `electron-agent/src/lib/files.ts`、`electron-agent/src/platform/runtime.ts`，不新增全局文件 Dock。

- [ ] **1. 写源码位置红测。** 新文件 `CodeSourceDetail.test.tsx` 直接验证现有文件读取能力与面板内行号。

```tsx
// @vitest-environment jsdom
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({read:vi.fn(),openPath:vi.fn()}));
vi.mock('../../lib/files',()=>({files:{read:mocks.read}}));
vi.mock('../../platform/runtime',()=>({openPath:mocks.openPath}));
import {CodeSourceDetail} from './CodeSourceDetail';
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('reads a file and highlights its real line without inventing an IDE command',async()=>{
  const original=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'scrollIntoView');
  const scroll=vi.fn();
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:scroll});
  try {
    mocks.read.mockResolvedValue('const a=1;\nconst b=2;\nexport function parse(){}');
    const {rerender}=render(<CodeSourceDetail workspace="D:/proj/alpha" file="src/a.ts" line={3}/>);
    const line=await screen.findByTestId('code-source-line-3');
    expect(line.textContent).toContain('export function parse(){}');
    expect(line.getAttribute('aria-current')).toBe('location');
    expect(mocks.read).toHaveBeenCalledWith('D:/proj/alpha','src/a.ts');
    await waitFor(()=>expect(scroll).toHaveBeenCalledTimes(1));
    rerender(<CodeSourceDetail workspace="D:/proj/alpha" file="src/a.ts" line={3}/>);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(mocks.openPath).not.toHaveBeenCalled();
  } finally {
    if(original)Object.defineProperty(HTMLElement.prototype,'scrollIntoView',original);
    else Reflect.deleteProperty(HTMLElement.prototype,'scrollIntoView');
  }
});
```

- [ ] **2. 运行红测。** `npm test -- src/features/agentData/CodeSourceDetail.test.tsx`；预期缺少源码详情模块。
- [ ] **3. 实现工作区。** `CodeProjectList` 的选项只用 `useProjectOptions()`，项目根路径帮助区分同名项；后端 `code.projects()` 只是索引状态参考，不能反向补入临时 workspace，也不能把不在该结果中的项目判成“未索引”。初次仅当 initialProject 与真实选项路径等价时预选；选中项目后调用 `code.status(project)`，查询前确认 status.workspace 与选中项目等价且 indexed=true。尚未检查显示“未检查”，请求失败显示错误，不能落入未索引空态。

每项目搜索词保存在 `Record<规范化项目路径,string>`；切项目立刻清旧结果、详情、错误并让全部旧请求代次失效，再恢复目标项目的词。Code 查询保留现有即时触发行为；不把 Memory 的 300ms 约束机械复制过来。搜索用 `codegraph_search`；“相关上下文”用 `codegraph_explore`；空搜索的“文件列表”用 `codegraph_files`（只有已知 indexed 才可查询）。点击符号行调用 `codegraph_node`，同名符号带 file 消歧。`CodeRelations` 标签分别调用 `codegraph_callers/callees/impact`，包含当前 symbol 与 file；无 symbol 时禁用关系按钮并说明“此结果未提供符号”。

项目、关键词、选中符号、关系标签分别使用请求代次。清理只取消 UI 订阅/定时器并忽略迟到响应；现有 MCP API 没有取消信号，不声称终止已经发出的底层只读调用。关系结果默认列表；未知文本按原有行展示并提供原文，不猜节点或绘制空图。错误保留同项目上次可读内容并显示当前失败。

源码文件读取使用已有 `files.read(workspace,file)`，沿用其主进程 realpath 越界检查和 512KB 预览限制。渲染每行真实编号；line 合法且在范围内才高亮/滚动，缺失显示“未提供行号”，超过文件末尾显示“索引行号已超出文件范围”，不能擅自跳第 1 行。

```tsx
// CodeSourceDetail 内：content 为 files.read 成功后的字符串，line 为结果原始行号。
const targetElement=useRef<HTMLDivElement>(null);
const [jumpVersion,setJumpVersion]=useState(0);
const lines=content.split(/\r?\n/);
const target=Number.isInteger(line) && line! >= 1 && line! <= lines.length ? line : undefined;
useEffect(()=>{targetElement.current?.scrollIntoView?.({block:'center'});},[workspace,file,target,jumpVersion]);
return <pre aria-label="源码内容">{lines.map((text,index)=><div
  key={index} data-testid={`code-source-line-${index+1}`}
  aria-current={target===index+1?'location':undefined}
  ref={target===index+1?targetElement:undefined}
><span aria-hidden="true">{index+1} </span>{text || ' '}</div>)}</pre>;
```

“跳转到行”按钮校验目标后改变 line；再次跳同一行则 `setJumpVersion(value=>value+1)`。后台刷新与普通 render 不增加 jumpVersion、不重复滚回目标。上述 Hooks 放在组件顶层，读取中的 content 初始化为 `''`，不在条件 return 之后调用 Hooks。

源码详情提供复制相对路径、面板内跳行和“使用系统打开文件”。只有项目内路径通过文件读取校验后才允许系统打开；使用已有 `openPath(绝对文件路径)`，不拼 `file:line`、不构造 IDE URI。应用现有能力只保证打开文件，行号定位由预览完成。路径显示默认相对路径，完整项目根路径放详情。

索引状态已知 false 时显示“建立索引”，true 显示“同步索引”，只由用户点击创建 `codegraph.sync`；状态读取/搜索/打开详情都不能创建任务。现有服务状态并不返回计数，文件/节点/边显示“未提供”；CLI 缺失（包括 spawn ENOENT）、索引缺失、连接/查询失败分别显示原因。无法判断是哪种故障时显示实际错误，不把一般错误猜成 CLI 缺失；CLI 缺失不提供自动安装入口。
- [ ] **4. 运行绿测。** `npm test -- src/features/agentData/CodeSourceDetail.test.tsx src/features/agentData/CodeRelations.test.tsx src/features/agentData/CodeRetrievalPanel.workbench.test.tsx src/features/agentData/CodeRetrievalPanel.test.tsx src/features/agentData/useProjectOptions.test.ts electron/app/fileService.test.ts`。测试覆盖 A 的慢响应晚于 B、同名 symbol 携带 file、关系标签切换丢弃旧响应、line 缺失/越界、512KB 错误、unknown 计数、未索引不会自动调用 jobs.create。
- [ ] **5. 验收。** 每个项目的搜索词能恢复，结果不跨项目串页；来源文件与真实行号可阅读；关系缺数据时不制造图或数字。

### 任务 8：统一任务跟踪、终态刷新与跨面板回归

**文件：** 修改 `electron-agent/src/features/agentData/MemoryPanel.tsx`、`electron-agent/src/features/agentData/CodeRetrievalPanel.tsx`、`electron-agent/src/features/agentData/AgentDataCenter.tsx`；创建 `electron-agent/src/features/agentData/CodeRetrievalPanel.tasks.test.tsx`；扩展 `electron-agent/src/features/agentData/MemoryPanel.test.tsx`、`electron-agent/src/features/agentData/AgentDataCenter.test.tsx`、`electron-agent/src/features/workspace/ModuleContainer.test.tsx`。第一阶段 `electron-agent/src/features/agentData/AgentDataTaskProvider.tsx` 的轮询实现保持唯一，不改其契约。

- [ ] **1. 写资源页跟踪红测。** 直接 mock 已定义的 Context 消费接口，确保本面板只调用 track 而不自己轮询。

```tsx
// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({
  monitor:{jobs:[],refresh:vi.fn(),track:vi.fn(),watchedTaskVersion:0},
  api:{code:{projects:vi.fn(),status:vi.fn(),call:vi.fn(),search:vi.fn()},jobs:{create:vi.fn()}},
}));
vi.mock('./AgentDataTaskProvider',()=>({useAgentDataTaskMonitor:()=>mocks.monitor}));
vi.mock('../../lib/agentData',()=>({agentDataApi:mocks.api}));
vi.mock('./useProjectOptions',()=>({useProjectOptions:()=>[{cwd:'/a',name:'A'}]}));
import {CodeRetrievalPanel} from './CodeRetrievalPanel';
afterEach(()=>{cleanup();vi.clearAllMocks();mocks.monitor.watchedTaskVersion=0;});
it('tracks the returned ID, stays on the resource and refreshes after completion',async()=>{
  mocks.api.code.projects.mockResolvedValue([]);
  mocks.api.code.call.mockResolvedValue({content:[{type:'text',text:'[]'}]});
  mocks.api.code.status.mockResolvedValue({workspace:'/a',connected:false,indexed:false});
  mocks.api.jobs.create.mockResolvedValue({id:'job-1',kind:'codegraph.sync',workspace:'/a',state:'pending',progress:0,createdAt:1,updatedAt:1});
  const {rerender}=render(<CodeRetrievalPanel initialProject="/a" visible/>);
  fireEvent.click(await screen.findByRole('button',{name:'建立索引'}));
  await waitFor(()=>expect(mocks.monitor.track).toHaveBeenCalledWith('job-1'));
  expect(screen.getByTestId('code-retrieval-panel')).toBeTruthy();
  mocks.api.code.status.mockResolvedValue({workspace:'/a',connected:true,indexed:true});
  mocks.monitor.watchedTaskVersion=1;
  rerender(<CodeRetrievalPanel initialProject="/a" visible/>);
  await waitFor(()=>expect(mocks.api.code.status).toHaveBeenCalledTimes(2));
  expect(mocks.api.jobs.create).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole('button',{name:'同步索引'})).toBeTruthy();
});
```

- [ ] **2. 运行红测。** `npm test -- src/features/agentData/CodeRetrievalPanel.tasks.test.tsx`；预期未调用 monitor.track 或 watchedTaskVersion 变化没有重新读取 status。
- [ ] **3. 接入唯一监视源。** 两面板均从 `./AgentDataTaskProvider` 导入 `useAgentDataTaskMonitor`。Code 新建任务成功后 track 返回 ID、保留当前页面并显示“已加入任务”；查看任务入口使用第一阶段已有按 ID 定位入口。删去旧 `onJobCreated` 自动切标签接线，不在 Code、Memory 或详情内调用 setInterval。

```ts
const {track,watchedTaskVersion}=useAgentDataTaskMonitor();
async function sync():Promise<void> {
  if(!project || syncing)return;
  const trackCreated=track;
  const targetProject=project;
  setSyncing(true);
  try {
    const job=await agentDataApi.jobs.create({kind:'codegraph.sync',workspace:targetProject});
    trackCreated(job.id); setCreatedJobId(job.id);
  } catch(cause) {
    setError(cause instanceof Error?cause.message:String(cause));
  } finally {setSyncing(false);}
}
```

`watchedTaskVersion` 纳入资源查询刷新触发器。Memory 传给 `useMemoryBrowser.reloadVersion` 并刷新 overview；Code 重新取 status 与当前查询，即使 indexed 仍为 true 也刷新。visible=false 时只记录最新版本，不发请求；再次显示刷新一次。保留源码选择、滚动位置和编辑草稿，后台新版本仅提示“数据已更新”；用户明确重新载入才替换编辑缓冲区。创建返回期间若用户已经改选项目，不把项目改回去，任务提示依据返回 job.workspace 显示真实目标。监视器返回失败时显示任务状态读取失败，不能把旧 jobs 当最新结果。
- [ ] **4. 运行绿测与类型检查。**

```powershell
npm test -- electron/agentData/memoryStore.browse.test.ts electron/agentData/memoryStore.manual.test.ts electron/agentData/runtime.memoryManagement.test.ts electron/app/memoryService.test.ts src/lib/agentDataCodeBridge.test.ts electron/ipc/register.test.ts electron/ipc/commandCoverage.test.ts src/features/agentData src/features/workspace/ModuleContainer.test.tsx src/lib/agentData.test.ts
npm exec -- tsc -p tsconfig.node.json --noEmit
npm exec -- tsc --ignoreConfig --noEmit --strict --skipLibCheck --jsx react-jsx --target ES2022 --module ESNext --moduleResolution Bundler --esModuleInterop --allowSyntheticDefaultImports --types vite/client src/features/agentData/MemoryPanel.tsx src/features/agentData/CodeRetrievalPanel.tsx
```

预期新增测试与相关旧测试通过，类型检查没有本阶段新增错误。当前 tsconfig.json 只有空 files 与 Node project reference，renderer 使用上述显式入口检查；已有无关类型错误单独记录，不顺手修复。新管理 API mock 使用 ManagedMemoryRecord，原 search mock 维持基础 MemoryRecord；Code mock 补 call 与 Context。失败不能用删除旧范围/捕获测试解决。补充终态刷新前后 indexed=true 的用例，断言 query 重发而选中源码保留；把 Editor 打开后刷新 version，断言草稿文本不变；隐藏面板期间变更 version 不请求，再显示只刷新一次。
- [ ] **5. 窗口与功能验收。** 在 1200×800、1440×900 及面板可用宽度 <800px 检查浅/深主题；窄屏采用列表→详情导航，不挤成三列。逐项检查：空查询/第二页、全局与项目区别、长 JSON 与长路径、来源会话删除、人工保存后再次提炼、冲突保留草稿、Code 查询乱序、缺索引无自动任务、源码行号、关系未知结果、创建任务留原页、隐藏暂停与终态刷新、Ctrl+S/Escape/焦点回归。使用已有本地测试数据，不为验收临时调用模型或安装 CLI；需要真实索引写入验收时由用户单独确认目标测试项目。

## 自检与交接

- 设计第 5 节对应任务 1–5；第 7 节对应任务 6–7；公共状态/任务与第 11 节回归对应任务 8。
- Schema 增量只有 Memory 的 `origin/revision/content_hash`；`sourceSessionId/sourceWorkspace` 映射已有列。人工 fingerprint 是命名空间去重键；旧 id/fingerprint 不重写，数据库原 UNIQUE 保留。
- `requestAdmin`、真实项目校验和唯一任务监视器属于前置阶段；按上述签名接入，不假装本工作树已经具备这些模块。
- 计划编写后的验证仅检查文件、接口一致性、代码块语法与设计覆盖。上方红/绿命令和数据库兼容步骤由实施阶段运行；没有在本次文档任务中执行。

## 第三阶段交付记录（2026-09-05）

- [x] 任务 1：Memory 与捕获原文的独立浏览、50 条 keyset 分页、明确项目/全局过滤及绑定查询条件的游标。
- [x] 任务 2：人工 UUID、revision/CAS、manual fingerprint、旧表原 ID/UNIQUE 兼容与自动记录槽位保护。旧数据迁移不改 fingerprint；后续显式自动更新会同步更新内容 fingerprint，避免新文去重失效。
- [x] 任务 3：六项新增 Memory 管理命令与管理删除只走 in-process；校验用户/归属/版本，拒绝 socket 自选 admin。复用主进程真实目录校验，管理操作不入模型队列。
- [x] 任务 4–5：默认最近记录、可读结构化内容和真实原文、只读对话、来源会话二次匹配、人工编辑/删除/冲突保稿。App 复用原会话打开处理并切聊天，不新造会话路径。
- [x] 任务 6–7：七项只读 CodeGraph 类型桥接、原始结果保真、项目内源码/行号、调用者/被调用者/影响；不修改协议、实例池或索引 runner。
- [x] 任务 8：唯一任务监视器、终态资源刷新、每项目搜索词、分页窗口保活、隐藏暂停及跨面板回归；完成隔离浏览器验收和独立审查。

### 实际实现补充

- 新建 `memoryStyles.ts` 与 `codeStyles.ts` 分别承载各工作区样式，复用已有主题 token，不并行改动共享样式文件。
- `useMemoryBrowser` 增加 `loaded` 区分未知/首次失败与真实空集；保存已加载页数。同一筛选的刷新/重新显示用新游标逐页重取后原子替换，不丢后续页、不拼接陈旧尾页；切查询条件重置窗口。
- 编辑器/详情使用请求代次及当前目标保护。旧记录被删除不能禁用或抢焦点于无关新增草稿；来源会话查询和点击也按当前记录/可见性隔离。
- 捕获详情保留选中时的命中片段，完整 transcript 独立读取。JSON 的原文折叠直接显示存储字符串，不经过 parse/stringify 改写大整数或重复字段。
- `CodeRelations.reloadVersion` 用于索引任务终态刷新，保持源码读取与滚动位置。项目选项动态移除时立即撤销旧查询/操作；等价路径显示使用当前真实 option 的字符串，避免看似未选却操作旧目标。
- 底层只读 MCP 没有取消信号，只忽略迟到 UI 响应，不宣称已经中止底层调用。未知关系结构展示原始结果，不引入关系图引擎。
- 深色主题中人工新增按钮采用与主色背景形成反差的主题 token；实测修复前浅字/浅底，修复后深字/浅底。

### 审查闭环

Memory 后端、Memory UI、Code UI 均由独立代理先复核规格、再检查代码质量，主线 Runtime/IPC/来源会话接线另行独立审查。所有明确的 P1/P2 已通过红→绿修复与复审，没有把测试全绿当作规格已完整的替代。

审查中实际修正了同文旧记录跨归属去重、显式自动 fingerprint、原始 JSON 精度、无关新稿被旧 NOT_FOUND 禁用/抢焦点、捕获命中片段、隐藏后分页窗口丢失、Code 关系未随终态刷新、动态项目失效与选择器等价路径等边界。

### 最终验证

在 `electron-agent` 使用已有测试器：

```powershell
& './node_modules/.bin/vitest.cmd' run --maxWorkers 4 electron/agentData electron/app/memoryService.test.ts electron/app/agentDataService.test.ts electron/app/validateProject.test.ts electron/app/piRuntimeService.test.ts electron/app/wikiLibraryService.test.ts electron/app/wikiSyncService.test.ts electron/app/appServer/taskQueue.test.ts electron/app/appServer/serviceTaskRegistry.test.ts electron/pi/systemWorkerManager.test.ts electron/ipc/register.test.ts electron/ipc/commandCoverage.test.ts electron/app/fileService.test.ts electron/app/codeGraph/codeGraphService.test.ts src/lib/agentData.test.ts src/lib/agentDataCodeBridge.test.ts
& './node_modules/.bin/vitest.cmd' run --maxWorkers 4 src/features/agentData src/features/workspace/ModuleContainer.test.tsx src/lib/agentData.test.ts src/lib/agentDataCodeBridge.test.ts
npm run build
```

- 后端/桥接：**37 文件、417 项通过**，包含前两阶段 Wiki、任务、Memory 捕获与文件服务回归。
- 前端：**28 文件、308 项通过**，包含六面板、来源回调和 Code 桥接。两组包含重复 API 测试，不相加当作去重覆盖数。
- Electron main/preload/renderer 构建成功。
- 主进程显式 `--composite false --incremental false` 类型检查仍有 37 项基线错误，新增 0。
- 以 `src/main.tsx` 为实际入口、显式 Node/Vite 类型的 renderer 检查仍有 5 项基线错误：NativeSkillsPanel 三项，agentData 的 jobs.create/Memory.overview 的 RuntimeArgs 两项；本轮未顺手修改。根 tsconfig 的 `files: []` 不等于真实渲染层类型检查通过。
- 精确本轮文件 `git diff --check` 通过。

### 浏览器和数据边界

真实 Memory/Code React 组件在隔离内置浏览器中使用明确标注的内存 API、源码和会话替身；不是生产模型或真实索引验收。检查 1440×900、1200×800 和 760×800、浅深主题，无横向溢出。

实测通过最近记录/JSON详情、真实会话匹配回调、Ctrl+S 冲突草稿保留、第二页跨面板保留、源码第三行高亮、未知影响文本、断线保结果、切项目不串旧结果、未索引禁查询，以及 Memory/Code 窄屏返回实际焦点回列表项。Escape/确认、写入竞态和删除仅通过非破坏性自动回归验证，不用真实 GUI 删除用户数据。最终浏览器日志无 error。

已关闭验收标签、重置临时视口、停止本地预览服务，并清理本轮预览源码与临时类型检查配置。使用说明在 `docs/agent-data-memory-code.md`。保留原分支及全部未提交更改；未提交、推送、重启应用、迁移真实数据库、调用真实模型、安装 CLI 或构建真实索引。第四阶段任务/审计/诊断仍未开始。
