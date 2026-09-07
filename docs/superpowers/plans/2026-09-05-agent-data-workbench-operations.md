# Agent 数据工作台第四阶段：任务、审计与诊断实施计划

> 执行者：使用 subagent-driven-development 或 executing-plans，按任务运行红灯、实现、绿灯、规格审查和代码审查。这里是计划，不执行真实数据清理。

**目标：** 聚合用户/系统任务并正确区分能力，让任务状态、历史记录、诊断和资源页相互可达。

**架构：** 不合并 `agent_jobs` 与 `service_tasks` 的写入路径；新增只读投影。新管理查询经第二阶段的 `requestAdmin`，现有用户任务取消与终态清理继续复用已验证的实现。

**技术栈：** TypeScript、node:sqlite、React、现有 TaskQueue/JobStore、Vitest。

## 前提与文件职责

依赖第一阶段 Provider 和第二阶段可信管理入口、Wiki 任务目标元数据；第三阶段交付可读 Memory/Code 详情。本阶段不要重做前三阶段的目录迁移或权限模型。

| 新建或修改文件 | 职责 |
| --- | --- |
| `electron-agent/electron/agentData/taskViewStore.ts`，新建 | 聚合只读任务、稳定游标、能力投影 |
| `electron-agent/electron/agentData/jobStore.ts` | 复用终态删除，增加重试/阶段元数据读写 |
| `electron-agent/electron/app/taskViewService.ts`，新建 | 验证资源存在性与可执行操作，重试创建新任务 |
| `electron-agent/electron/agentData/auditViewStore.ts`，新建 | 审计筛选、摘要、统一脱敏 |
| `electron-agent/electron/app/agentDataDiagnostics.ts`，新建 | 只读诊断聚合，禁止隐式重建 |
| `electron-agent/electron/agentData/runtime.ts`、`app/agentDataService.ts`、`ipc/register.ts` | 管理路由与主进程装配 |
| `electron-agent/src/lib/agentData.ts` | typed tasks/audit/diagnostics API |
| `electron-agent/src/features/agentData/JobsPanel.tsx`、新建 `TaskDetailDrawer.tsx` | 用户/系统任务分组和详情 |
| `electron-agent/src/features/agentData/AuditDiagnosticsPanel.tsx` | 两个子页、筛选与问题入口 |
| `electron-agent/src/features/agentData/AgentDataTaskProvider.tsx` | 保持单一轮询，扩展复合 TaskRef |
| `electron-agent/src/features/agentData/OverviewPanel.tsx` | 汇总真实数据与资源导航 |

上述文件对应创建或扩展同名测试。DTO 放在无运行时依赖的纯类型模块，renderer 仅 type-import；不能为了复用类型而引入主进程实现或 Node 模块，用契约测试防漂移。

## 契约

```ts
export type TaskRef = { source: 'user' | 'system'; id: string };
export type TaskStatus = 'pending' | 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type ResourceRef = { type: 'wiki' | 'project' | 'memory'; id: string };
export interface TaskView {
  ref: TaskRef;
  key: string;
  kind: string;
  label: string;
  status: TaskStatus;
  workspace?: string;
  resource?: ResourceRef;
  progress?: number;
  stage?: string;
  cancellationRequested: boolean;
  attempts?: number;
  retryOf?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  capabilities: { cancel: boolean; retry: boolean; remove: boolean };
}
export interface TaskPage { items: TaskView[]; nextCursor?: string }
export interface TaskListInput {
  source?: TaskRef['source'];
  group?: 'active' | 'history';
  workspace?: string;
  query?: string;
  cursor?: string;
  limit?: number;
}
```

系统任务本版三项操作能力均为 false，即使内部队列能取消 queued 也不自动开放面板入口。未知或不可重新执行的用户 kind 不获得 retry 能力。后台输入/输出不直接塞进列表 DTO。

TaskView.resource 从第二阶段 JobMetadata.target 映射；TaskView.retryOf 从同一 metadata 读取。本阶段只扩展这份结构，不建立第二套同义目标字段。

P2 写者租约的 taskSource=`agent_job/service_task` 只在读模型边界映射为 TaskRef.source=`user/system`。不得把这两组字符串混用或据显示标签选择删除表。

统一 key：

```ts
export function taskKey(ref: TaskRef): string { return `${ref.source}:${ref.id}`; }
export function isActiveTask(status: TaskStatus): boolean {
  return status === 'pending' || status === 'queued' || status === 'running' || status === 'blocked';
}
```

管理 API 命名为 `admin.tasks.list/read/retry`、`admin.audit.query/export`、`admin.diagnostics.check`。旧 `admin.jobs.*` 保留；面板只把 source=user 的清理 ID 交给旧 remove/clear。Provider 增加 `tasks` 和 `track(TaskRef)`，保持 `jobs` 与 `track(string)` 的用户任务兼容语义，不起第二个定时器。

## O1：聚合只读任务投影

文件：新建 `taskViewStore.ts/.test.ts`，修改 `runtime.ts` 管理路由和 `src/lib/agentData.ts`。

- [ ] 新测试使用 `AgentDataStorage(':memory:')` 和 `JobStore` 建表；在两个表中插入同 ID，验证聚合结果 key 不相同、系统任务没有伪进度：

```ts
const storage = new AgentDataStorage(':memory:');
storage.migrate();
const jobs = new JobStore(storage.db);
const created = jobs.create({ kind: 'wiki.sync', workspace: '/repo' });
storage.db.prepare('INSERT INTO service_tasks(id,kind,status,input,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .run(created.id, 'memory_extract', 'queued', '{}', 0, 1, 1);
const views = new TaskViewStore(storage.db);
const page = views.list({ limit: 50 });
expect(page.items.map((item) => item.key).sort()).toEqual([`system:${created.id}`, `user:${created.id}`]);
expect(page.items.find((item) => item.ref.source === 'system')).toMatchObject({
  status: 'queued', capabilities: { cancel: false, retry: false, remove: false },
});
expect(page.items.find((item) => item.ref.source === 'system')?.progress).toBeUndefined();
storage.close();
```

- [ ] 运行 `npm test -- electron/agentData/taskViewStore.test.ts`（cwd `electron-agent`），观察缺实现失败。
- [ ] 查询使用 SQL UNION ALL，排序以 `(updatedAt DESC, source ASC, id ASC)` 为准。游标包含同一三元组并在后端验证，不能依赖两个查询先各 LIMIT 后拼接造成漏项；limit clamp 到 1..100。
- [ ] 用户元数据使用 P2 的 job metadata；系统状态保留 queued/blocked，不能映射成假“可取消等待中”。仅当确有进度才带 progress 字段，CodeGraph 的未计量阶段使用 stage。
- [ ] 加分页无重复/漏项、active/history 分组、未知 kind、错误 JSON 元数据隔离测试，再运行目标测试和原 jobStore 测试。

## O2：重试、取消请求与真实阶段

文件：`jobStore.ts/.test.ts`、新建 `taskViewService.ts/.test.ts`、`main.ts`、`wikiSyncService.ts`、`codeGraph/syncRunner.ts`、`runtime.ts`；使用 P2 已新增的任务 metadata，不再加重复列。

- [ ] 明确 metadata 合同：目标 resource、重放 input、retryOf、cancellationRequested、stage、已处理/总数（可选）。若 P2 尚未改变旧 INSERT，必须先把 `INSERT INTO agent_jobs VALUES(...)` 改为显式列名，避免新增 metadata 列后参数数目失配。
- [ ] 用注入 dispatch spy 写红测试：失败任务 retry 创建新 ID、旧任务仍 failed；source=system 被拒；目标资源已删除、同资源 active 或未知 kind 被拒且 dispatch 未调用。
- [ ] 运行 `npm test -- electron/app/taskViewService.test.ts`，确认缺少 retry 管理行为。
- [ ] TaskViewStore 的基础投影不凭 kind 推测重试一定可用；TaskViewService.list/read 根据当前目标存在性、是否已有活动任务和允许 kind 补齐 capabilities。资源被删除或有冲突时，界面不提供可执行 retry；真正执行时仍复检。
- [ ] 重放只接受 `wiki.sync`、`codegraph.sync`、P2 的 `wiki.ingest`，按当前资源重新校验并创建新任务；不允许请求者注入任意 kind/input。核心顺序如下：

```ts
// 放在 TaskViewService.retry 中；requireUserTask/readTarget/dispatch 是该服务构造注入的现有 JobStore 与 P2 Wiki 适配器。
const previous = this.requireUserTask(ref);
if (!['failed', 'cancelled'].includes(previous.state)) throw new Error('TASK_NOT_RETRYABLE');
const target = await this.readTarget(previous);
if (!target.exists) throw new Error('RESOURCE_NOT_FOUND');
if (target.busy) throw new Error('RESOURCE_BUSY');
return this.dispatch(previous, { retryOf: previous.id });
```

接口需在服务中显式定义为 `requireUserTask(ref:TaskRef):Job`、`readTarget(job:Job):Promise<{exists:boolean;busy:boolean}>`、`dispatch(job:Job, metadata:{retryOf:string}):Promise<Job>`；三项适配器不接受来自 UI 的函数或任意命令。

readTarget 对 wiki.ingest 读取 metadata.target 的 active 库及原 sourceIds，对 codegraph.sync 检查原 workspace 目录和同种活动任务，对 wiki.sync 解析其旧 workspace 映射与当前关联。旧记录缺少元数据时只按已知 kind/workspace 重建明确目标，无法确定就返回不可重试。dispatch 复用对应服务的创建入口：Wiki 重新选择原 sourceIds 中仍有效且待处理的版本，不把后来新增资料并入一次重试；新 job 记录 retryOf，原记录不改。

Wiki 重试先复用 P2 previewIngest 确认待处理资料和当前模型，再携带 expectedModel 创建新 job；读取不到模型或模型已变化时提示重新预览，不能绕过 P2 的模型确认保护。CodeGraph 重试不调用这个模型入口。

- [ ] 取消请求写 metadata 后通知执行器；执行器确认前 DTO 仍为 running + cancellationRequested=true。失败时保留 running 与原因，可再次请求取消，不提前显示 cancelled。
- [ ] 在现有 runner 已知边界记录真实阶段（扫描、读取、生成、发布、完成）。复用审计 `job.stage` 事件，不生成虚构日志；CodeGraph 无阶段来源时显示“正在构建”，不解析任意 stderr 猜百分比。
- [ ] 跑 retry/cancel/runner 测试，包括取消期间禁清理、删除后禁止重放，以及旧同步 API 兼容。

## O3：任务列表与详情抽屉

文件：`JobsPanel.tsx/.test.tsx`、新建 `TaskDetailDrawer.tsx/.test.tsx`、`AgentDataTaskProvider.tsx/.test.tsx`、typed API/IPC。

- [ ] 将已有 25 项清理回归保留，新增系统任务同 ID 隔离、无百分比、capabilities 禁止按钮、点击详情、失败重试创建新行但不改旧行的测试。
- [ ] 运行 `npm test -- src/features/agentData/JobsPanel.test.tsx src/features/agentData/TaskDetailDrawer.test.tsx`，观察当前单表 UI 不满足要求。
- [ ] UI 以能力而非猜测状态决定操作：

```tsx
function TaskActions({ task, onCancel, onRetry, onRemove }: {
  task: TaskView;
  onCancel(ref: TaskRef): void;
  onRetry(ref: TaskRef): void;
  onRemove(ref: TaskRef): void;
}) {
  return <>
    {task.capabilities.cancel && <button onClick={() => onCancel(task.ref)}>取消</button>}
    {task.capabilities.retry && <button onClick={() => onRetry(task.ref)}>重新执行</button>}
    {task.capabilities.remove && <button onClick={() => onRemove(task.ref)}>删除记录</button>}
  </>;
}
```

以上组件使用现有 actionButton 样式并继承 pending 禁用状态。所有 mutation 从后端再次核验能力；系统任务只读，不把其 ID 交给 jobs.remove。

- [ ] 默认用户任务列表、后台系统任务折叠区；任务详情展示真实字段、原始 kind/ID、目标资源和错误。输入输出仅经脱敏 allowlist 展示摘要，不展示整份捕获 transcript。
- [ ] Provider 的一个请求源改成聚合任务 API；从 tasks 中投影 jobs 供旧资源页使用。track(string)→{source:'user',id}，不与 system 同 ID 混淆，终态版本通知只发一次。
- [ ] 验证点击资源跳转、返回焦点、清理当前筛选仅 user 终态、刷新失败不移除未删条目；重跑全部任务及 Provider 测试。

## O4：可读、可筛选的审计

文件：新建 `auditViewStore.ts/.test.ts`；修改 `jobStore.ts`、`runtime.ts` 管理接口、`AuditDiagnosticsPanel.tsx/.test.tsx`、typed API。

- [ ] 测试审计筛选在服务端发生、同毫秒游标稳定、资源删除后摘要仍可读、复制/导出与界面脱敏一致。
- [ ] 新事件在写入时保存必要资源名称快照；旧事件没有名称就显示“资源已移除（ID）”，不伪造名称。查询只读 `agent_audit`，不清理历史审计。
- [ ] 脱敏函数放在后端审计读模型，键名匹配 token/apiKey/secret/credential；系统任务原始输入输出不进入导出。前端仍保留显示防护，但不能仅靠前端掩码保护导出：

```ts
export function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key, /token|apiKey|secret|credential/i.test(key) ? '[redacted]' : redactAuditValue(entry),
  ]));
}
```

自由文本只展示允许的动作摘要和截断后的错误，不能声称此函数能识别任意正文中所有秘密。

- [ ] 管理页 API 输入 `{action?,resource?,from?,to?,cursor?,limit?}`；默认倒序 50 条。详情折叠原始结构，导出只导当前筛选的脱敏记录，并显示数量上限，不导出无界全库。
- [ ] 运行 `npm test -- electron/agentData/auditViewStore.test.ts src/features/agentData/AuditDiagnosticsPanel.test.tsx src/lib/agentData.test.ts`，补空集/失败/非法游标/敏感嵌套值测试。

## O5：只读诊断聚合与明确修复入口

文件：新建 `agentDataDiagnostics.ts/.test.ts`；给 `WikiStore` 增加只读 inspect，修改 AuditDiagnosticsPanel 与 OverviewPanel。

契约：

```ts
export interface DiagnosticItem {
  id: string;
  resource?: ResourceRef;
  state: 'ok' | 'action_required' | 'unchecked';
  checkedAt: number;
  message: string;
  action?: 'open_file' | 'reindex_wiki' | 'configure_codegraph';
  path?: string;
}
```

- [ ] 临时库/目录故障用例：MD hash 与索引不同→action_required；损坏 frontmatter→文件诊断；CLI 缺失→配置提示；未检测→unchecked，不能给绿色 ok。
- [ ] 诊断使用现有实例读取文件/hash/索引元数据，不调用 `new WikiStore()`（构造会迁移/重建），不调用 reindex、不启动 MCP 或模型。测试在检查前后比较文件 hash、SQL行数和模型/进程 spy 调用数。
- [ ] 库损坏不阻塞其它诊断，逐项返回错误。open_file 必须由主进程验证是已知诊断资源下的路径；UI不能把任意路径包装成诊断打开。
- [ ] 重建入口另行确认并调用 P2 管理方法，使用同一任务状态源跟踪；诊断不直接修复。“操作记录 / 运行诊断”各记住筛选。
- [ ] 运行 `npm test -- electron/app/agentDataDiagnostics.test.ts electron/agentData/wikiStore.test.ts src/features/agentData/AuditDiagnosticsPanel.test.tsx`。

## O6：概览与资源导航收口

文件：`OverviewPanel.tsx/.test.tsx`、`AgentDataCenter.tsx/.test.tsx`、typed overview API 与管理装配。

- [ ] 从 P2 的库/资料状态、P3 最近记忆、P4 活动任务和真实诊断构造概览；没有数据源的统计不显示占位零值。
- [ ] 为跨面板导航定义带资源上下文的联合类型，总容器定位对应面板与选中 ID；已有编辑草稿需确认离开，不能通过 KPI 跳转绕过。Wiki pageId 可能在不同库重复，不能只传 pageId：

```ts
type ResourceNavigation =
  | { view: 'overview' }
  | { view: 'memory'; id?: string; mode?: 'read' | 'create' }
  | { view: 'wiki'; kbId?: string; pageId?: string; mode?: 'read' | 'create' }
  | { view: 'code'; workspace?: string; file?: string; line?: number }
  | { view: 'jobs'; task?: TaskRef }
  | { view: 'audit'; resource?: ResourceRef };
```
- [ ] 测试“最近页面”打开指定库指定页、“失败任务”打开对应 ref、新建 Wiki 入口打开 P2 对话框。概览局部请求失败保留其它数据。
- [ ] 任务完成只刷新关联列表/概览，资源正文编辑 state 不被服务端新响应覆盖；失焦停止轮询，聚焦刷新一次。
- [ ] 运行 `npm test -- src/features/agentData/OverviewPanel.test.tsx src/features/agentData/AgentDataCenter.test.tsx src/features/agentData/AgentDataTaskProvider.test.tsx`。

## O7：整体验收

- [ ] 运行前三阶段全部目标测试，加本阶段测试；再运行 `npm run build` 和 CLI `npm run typecheck`，记录 Electron 全量主进程既有类型错误对比。
- [ ] 在临时用户目录完成一条跨面板流程：新库→添加资料→抽取→原页跟踪→编辑锁定→重建→查看审计→清理终态任务；确认产物与审计仍在。
- [ ] 完成另一条流程：选真实测试项目→同步索引→搜索符号→看源码/调用关系→打开任务详情；没有索引时仅显式同步，查询不暗建。
- [ ] 在 1200×800、1440×900、窄面板和两种主题检查长名称、错误、空集、键盘焦点、未保存提示。真实模型或 CLI 依赖不可用时明确列为未覆盖，不伪造验收成功。
- [ ] 审查权限、迁移、删除及两种队列能力矩阵后，才交付整个工作台；只修改本计划直接涉及文件，提交前保护已有用户改动。

## 自检

覆盖设计 §4、§8、§9 与 §11 跨面板验收。系统任务只读策略与资源删除等待策略一致；能力判定、实际日志和脱敏由后端给出。没有引入新的后台调度器、多租户 ACL 或虚构指标。

## 第四阶段交付记录（2026-09-05）

- [x] O1：用户/系统任务 SQL 聚合、复合身份、稳定游标和能力投影；原任务表写入路径保持独立。
- [x] O2：已知终态任务重试创建新 ID/retryOf，末端资源与原任务复检；Wiki 重试确认模型及原资料范围，取消请求与执行确认分开。
- [x] O3：任务分组、真实阶段、详情、用户终态清理和唯一任务监视器；系统只读，分页与隐藏响应隔离。
- [x] O4：服务端审计筛选、名称快照、字段投影、统一脱敏和最多 500 条导出。
- [x] O5：已有实例的只读诊断、问题路径重验、明确修复确认和 CodeGraph 配置入口。
- [x] O6：真实资源汇总、Wiki 双 ID/任务复合 ID 导航、后台终态刷新和草稿保留。
- [x] O7：前三阶段与本阶段自动回归、隔离浏览器验收、构建和类型基线对比完成。
- [ ] 真实模型抽取及外部 CodeGraph 索引写入端到端验收未运行；需要用户指定测试项目和数据后单独执行。

### 本次接续与审查修复

关联任务在第四阶段整体验收期间中断。本次保留原分支和全部未提交内容，从已有实现继续；原任务名称不代表本次范围。

先完成前后端规格检查，再由独立代理进行代码质量复审。修复三处已复现的问题：

1. 任务监视器原先只通知显式跟踪任务的终态，概览中的既有后台任务完成后计数会陈旧。复用前一成功快照与复合 ID 去重，补齐活动到终态通知；未加载页的可信活动计数下降合并一次汇总通知。没有增加轮询源或扩大资源页跟踪范围。
2. 审计资源类型已选、ID 空缺时，查询签名仍为无筛选且保留旧游标。“加载更多”原本可继续查全库，现由操作入口和按钮一起检查 filterError，补齐 ID 后从新范围首页查询。
3. CodeGraphService 原先丢失执行器已确认的 CLI 缺失状态，诊断配置入口在生产接线中不可达。现在按项目保存明确缺失状态，成功同步后清除；诊断不新增进程探测，普通文件缺失或构建错误不误判为 CLI 缺失。

以上均完成红灯到绿灯回归。Provider 52 项、审计面板 20 项、CodeGraph/诊断 24 项通过；独立最终复审另跑 10 文件、145 项，无剩余 P1/P2。按简化检查保留必要分支，未进行相邻重构。

### 冻结后的验证

在 `electron-agent` 使用已安装的本地测试器运行：

```powershell
& './node_modules/.bin/vitest.cmd' run --maxWorkers 4 electron/agentData electron/app/memoryService.test.ts electron/app/agentDataService.test.ts electron/app/agentDataDiagnostics.test.ts electron/app/taskViewService.test.ts electron/app/validateProject.test.ts electron/app/piRuntimeService.test.ts electron/app/wikiLibraryService.test.ts electron/app/wikiSyncService.test.ts electron/app/appServer/taskQueue.test.ts electron/app/appServer/serviceTaskRegistry.test.ts electron/pi/systemWorkerManager.test.ts electron/ipc/register.test.ts electron/ipc/commandCoverage.test.ts electron/app/fileService.test.ts electron/app/codeGraph src/lib/agentData.test.ts src/lib/agentDataCodeBridge.test.ts
& './node_modules/.bin/vitest.cmd' run --maxWorkers 4 src/features/agentData src/features/workspace/ModuleContainer.test.tsx src/features/layout/ModuleRail.test.tsx src/lib/agentData.test.ts src/lib/agentDataCodeBridge.test.ts
npm run build
& './node_modules/.bin/tsc.cmd' --noEmit -p tsconfig.node.json --composite false --incremental false
& './node_modules/.bin/tsc.cmd' --ignoreConfig --noEmit --strict --skipLibCheck --jsx react-jsx --target ES2022 --module ESNext --moduleResolution Bundler --esModuleInterop --allowSyntheticDefaultImports --types 'node,vite/client' src/main.tsx
```

结果：后端/桥接 **45 文件、524 项**，前端 **33 文件、394 项**通过。两组有重复桥接测试，不相加作为去重测试数。Electron main/preload/renderer 构建通过。

在 `extensions` 复用 Electron 已安装的 Vitest，运行 `memory wiki-rag code-retrieval _shared/tool-groups.test.ts`：**13 文件、85 项**通过。CLI 的 `npm test` **16 项**通过，`npm run typecheck` 和 `npm run build` 通过；没有重新安装依赖或恢复已删除的锁文件。

全量主进程类型检查仍有 **37 项**，以 `src/main.tsx` 为实际入口的渲染层检查仍有 **5 项**。与本次接续前的错误逐项比较（忽略行号），新增及消失均为 0。范围外的 TencentDB、SDK/权限接口、NativeSkillsPanel 和旧 RuntimeArgs 等错误未顺手修改；根 tsconfig 的空 files 不代表全量类型检查通过。

### 界面与数据边界

隔离浏览器加载真实工作台组件，仅使用明确标注的内存 API 替身。已实测后台任务未经手动跟踪完成后，概览活动计数从 2 自动更新为 1；同 ID 系统任务保持只读；Wiki 重试确认模型与数量、保留旧任务并打开新 ID；审计筛选限定资源，复制导出保留 `[redacted]` 和 500 条上限；诊断重建先确认不调用模型、不改正文，再显示结果。

概览最近页面定位到指定库和页面，同页跨面板返回保留未保存草稿。删除、路径安全及冲突丢稿保护由临时 SQLite/文件与组件回归覆盖，未通过 GUI 删除用户数据。预览使用 1440×900、1200×800 和 760×800 检查布局及浅深主题；真实模型、真实 CLI 和用户数据库均未参与。

诊断断线时保留上次结果并标记过期，恢复后重新检查；审计子页切换后保留动作和资源筛选，最终浏览器 error 日志为空。已关闭验收标签、重置视口、停止本轮 5190 预览服务，并清理 `.operations-stage4` 临时源码和类型配置。

使用说明：`docs/agent-data-operations.md`。保留 `codex/agentdata-extension-integration` 与当前工作树，不提交、推送、重启应用或执行真实迁移。
