# Agent 数据工作台第二阶段：Wiki 独立知识库实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将已存在的 Markdown Wiki 升级为独立具名、可关联多项目的知识库，交付资料版本、人工页面、显式抽取、安全删除及完整管理工作区。

**架构：** Markdown 正文和资料快照保留在应用数据根；新增库与资料两个专用 Store，由 `WikiLibraryService` 编排现有 WikiStore、用户任务和系统任务。逻辑 `kbId` 与物理 `storageKey` 分离，项目绑定凭据提供服务端范围，主进程管理入口固定管理上下文。沿用现有 TaskQueue / SystemWorker，不新建任务调度器、通用 RPC 网关或多用户 ACL。

**技术栈：** TypeScript、Electron、React、Ant Design / Lobe、SQLite `DatabaseSync`、Markdown / YAML、Vitest、Testing Library。

**执行状态（2026-09-05）：任务 1–12 已完成。** 下文保留原实施步骤和示例作为设计依据；实际实现的接口补充、差异及最终验证结果见文末交付记录，不再从未勾选的示例步骤重新实施。

---

## 0. 执行边界、依据与依赖

- 设计依据：`docs/superpowers/specs/2026-09-05-agent-data-workbench-design.md` §6、§10、§11；本计划覆盖其 Wiki 部分。
- 前置阶段：一期公共外壳保持挂载、局部加载和状态保留已验收。只消费一期 `useAgentDataTaskMonitor()` 的 `jobs`、`refresh()`、`track(id: string)`、`watchedTaskVersion`，不在本阶段另建轮询。track是绑定点击时activeView的闭包；异步操作开始前捕获它，await之后使用捕获值，不能按响应时的新页面归属任务。
- 所有下文路径相对仓库根；除明确注明的扩展测试外，执行测试前运行 `Set-Location -LiteralPath 'D:/OneDrive/Project Files/Pi/electron-agent'`，其后使用 `npm exec -- vitest run ...`。不下载另一份测试器。
- 当前工作树已有大量用户改动。实施前记录 `git status --short`，按任务检查目标 diff；不格式化相邻代码、不重置、不批量提交。本文只交付计划，不运行真实数据库迁移、模型调用或删除操作。
- **兼容迁移的两步顺序固定：** 先保持现有 `WikiStore.exportLegacy()` 的已确认 SQL→MD 兼容导出，再执行本阶段新增的“目录登记”。后者只给已存在桶补 `kbId` / 关联 / 元数据，不再复制正文。既有 SQL-only 数据仍经原导出路径处理，导出失败保留 SQL 和诊断；不能把失败桶当作空库登记成功。`wiki_pages`、`legacy-backup`、`legacyExported` 不能删除或清空。
- 不把 `kbId` 当 OS 路径或 workspace：新库 `storageKey = 'kb-' + randomUUID()`；旧库 `storageKey = wikiHash(原始 workspace 字符串)`。库重命名、关联和解绑均不改变它。
- 新人工关联只接收真实项目；既有临时 workspace 的登记按原关联保留，不以新人工关联校验删掉旧会话数据。

## 1. 文件责任与前置契约

| 文件 | 本阶段唯一责任 |
| --- | --- |
| 新建 `electron-agent/electron/agentData/wikiContracts.ts` | 无运行时依赖的 Wiki DTO、输入、版本、上下文、删除与发布结果；renderer 仅 type-import |
| 新建 `electron-agent/electron/agentData/wikiLibraryStore.ts` | 库、项目关联、legacy 映射、资源 lifecycle / epoch、任务目标登记；不调用模型 |
| 新建 `electron-agent/electron/agentData/wikiSourceStore.ts` | 资料 UUID、不可变 revision 快照、处理状态和删除后的来源标记 |
| 修改 `electron-agent/electron/agentData/wikiFiles.ts` | 显式 bucket 定位、防目录链接、frontmatter、文件原子发布；保留 legacy 读取 |
| 修改 `electron-agent/electron/agentData/wikiStore.ts` | 页面 CRUD、版本保护、来源引用、索引；保留旧 workspace API 适配 |
| 新建 `electron-agent/electron/app/wikiLibraryService.ts` | 显式抽取、任务关联、取消检查点、生命周期删除编排 |
| 新建 `electron-agent/electron/app/validateProject.ts` | 人工新关联的只读真实路径/目录/非临时目录校验，第三阶段 Memory 复用 |
| 修改 `electron-agent/electron/agentData/runtime.ts`、`requestFrames.ts`、`electron-agent/electron/app/agentDataService.ts` | in-process 管理入口、项目 token、Wiki RPC 分发，不全面重写其它 RPC 的授权策略 |
| 修改 `electron-agent/electron/app/piRuntimeService.ts`、`electron-agent/electron/main.ts` | 把主进程解析的项目路径绑定到 Pi 的 Agent Data endpoint；装配 Wiki 服务 |
| 修改 `electron-agent/electron/app/wikiSyncService.ts` | 旧显式同步遵循新发布保护；锁定/冲突按页跳过，不使整批失败 |
| 修改 `electron-agent/electron/pi/systemWorkerManager.ts` | 只读获取实际provider/id；仅新Wiki抽取在prompt前检查确认过的模型 |
| 修改 `electron-agent/electron/agentData/jobStore.ts` | 向旧任务表增加可选 metadata，保留 workspace NOT NULL；第三、四阶段复用同一列 |
| 修改 `electron-agent/electron/ipc/contracts.ts`、`register.ts`、`electron-agent/src/lib/agentData.ts` | 每项明确 IPC 命令和类型化 API；不暴露 renderer 自选管理上下文 |
| 修改 `extensions/wiki-rag/{index,sync}.ts` | 项目读取工具接入具名关联库；旧写工具带生成前版本，只操作原workspace映射库，不宣称新库Agent写入 |
| 修改 `electron-agent/src/features/agentData/WikiPanel.tsx` | 仅管理库列表/库工作区导航状态，保留一期父级挂载方式 |
| 新建 `electron-agent/src/features/agentData/wiki/{WikiLibraryList,WikiLibraryWorkspace,WikiLibraryDialog,WikiSourceDialog,WikiPageEditor}.tsx` | 分别负责库列表、库内导航、库属性表单、资料录入、页面编辑 |
| 新建 `electron-agent/src/features/agentData/wiki/wikiStyles.ts` | 内容区宽度断点、主题 token、长路径、键盘可见焦点 |
| 新建 `electron-agent/src/features/agentData/wiki/wikiTestData.ts` | 完整的库/资料/页面测试 DTO，避免跨文件引用局部 fixture |
| 新建 `electron-agent/electron/agentData/wikiTestFixture.ts` | 仅测试使用的 `:memory:` 数据库和临时根；不导入应用 main |

测试文件随下面任务逐一列出；不新增服务层通用框架。

### 1.1 先定义类型，后实现调用者

以下类型在任务 1 落到 `wikiContracts.ts`；后续代码使用同一组字段。`contentHash` 对资料是原文 UTF-8 字节的 SHA-256；对页面是**完整磁盘 Markdown（含 frontmatter）**的 SHA-256，不把该哈希写回 frontmatter，避免自引用，也检测外部锁定/来源字段变化。

```ts
export type WikiLifecycle = 'active' | 'deleting' | 'deleted';
export type WikiRequestContext = { kind: 'admin' } | { kind: 'project'; workspace: string };
export interface WikiVersion { revision: number; contentHash: string }
export interface WikiSourceRef { sourceId: string; revision: number }
export interface WikiBucket { kbId: string; storageKey: string; legacyWorkspace?: string }
export interface WikiLibrary extends WikiBucket {
  name: string; description: string; bindings: string[]; revision: number;
  lifecycle: WikiLifecycle; epoch: number; createdAt: number; updatedAt: number;
}
export interface WikiLibraryView extends WikiLibrary {
  location: string; sourceCount: number; pageCount: number; pendingSourceCount: number;
  availability: 'draft' | 'pending' | 'available'; lastError?: string; activeJobId?: string;
}
export interface WikiLibraryInput { name: string; description: string; bindings: string[] }
export interface WikiSource extends WikiVersion {
  kbId: string; sourceId: string; name: string; kind: 'manual' | 'upload' | 'project' | 'legacy';
  projectWorkspace?: string; relativePath?: string; snapshotPath: string;
  lifecycle: WikiLifecycle; epoch: number; status: 'pending' | 'processing' | 'succeeded' | 'failed';
  processedHash?: string; generatedPageId: string; generationSuppressed: boolean;
  error?: string; createdAt: number; updatedAt: number;
}
export type WikiSourceInput =
  | { kind: 'manual' | 'upload'; name: string; content: string }
  | { kind: 'project'; projectWorkspace: string; relativePath: string; expectedContentHash: string };
export interface WikiImportPreview {
  projectWorkspace: string; relativePath: string; name: string; contentHash: string; bytes: number;
}
export interface WikiPage extends WikiVersion {
  kbId: string; pageId: string; title: string; content: string; path: string;
  sourceRefs: WikiSourceRef[]; locked: boolean; autoSourceId?: string;
  lifecycle: WikiLifecycle; epoch: number; updatedAt: number;
}
export interface WikiPageInput { title: string; content: string; sourceRefs: WikiSourceRef[] }
export interface WikiPageSave extends WikiPageInput { expected: WikiVersion }
export interface WikiPageHit { kbId: string; pageId: string; title: string; snippet: string }
export type WikiTarget = { kbId: string } & (
  | { kind: 'library' } | { kind: 'source'; sourceId: string } | { kind: 'page'; pageId: string });
export interface WikiWritePermit {
  kbId: string; libraryEpoch: number; sourceId: string; sourceEpoch: number;
  sourceRevision: number; pageId: string; pageEpoch: number; expected: WikiVersion | null;
}
export type WikiPublishResult =
  | { state: 'published'; page: WikiPage }
  | { state: 'skipped'; reason: 'locked' | 'changed' | 'multi_source' | 'deleted' | 'suppressed' };
export interface WikiTaskTarget {
  taskSource: 'agent_job' | 'service_task'; taskId: string; kbId: string;
  sourceId?: string; pageId?: string; active: boolean; canCancel: boolean;
}
export interface WikiIngestSummary { succeeded: number; skipped: number; failed: number }
export interface WikiIngestItem { sourceId: string; sourceRevision: number; contentHash: string; permit: WikiWritePermit }
export interface WikiIngestRun { jobId: string; kbId: string; items: WikiIngestItem[]; cancelRequested: boolean; summary: WikiIngestSummary; model: string }
export interface WikiIngestReceipt { jobId: string; targetCount: number; model: string }
export interface WikiIngestPreview { sourceIds: string[]; targetCount: number; model: string }
export interface WikiDeletePreview { target: WikiTarget; name: string; revision: number; sources: number; pages: number; bindings: string[] }
export type WikiDeleteResult = { state: 'deleted' } | { state: 'waiting'; tasks: WikiTaskTarget[] };
export interface WikiDiagnostic { code: string; path: string; message: string; kbId?: string }
export interface WikiReindexResult { pages: number; diagnostics: WikiDiagnostic[] }
```

`WikiLibraryStore(db: DatabaseSync, files: WikiFiles)` 的公开方法：`create(input)`、`get(kbId)`、`list()`、`update(kbId,input,expectedRevision)`、`resolveLegacy(workspace)`、`registerLegacyBuckets()`、`assertAccess(context,kbId)`、`visibleLibraries(context)`、`assertActive(kbId)`、`pageDeleted(kbId,pageId)`、`beginDelete(target)`、`activeTasks(target)`、`recordTask(target:WikiTaskTarget)`、`settleTask(taskSource,taskId)`、`acquirePermit(kbId,sourceId)`、`permitActive(permit)`、`finishDelete(target)`。`registerLegacyBuckets()` 返回 `WikiDiagnostic[]`，单桶失败不终止其它桶。`assertActive/pageDeleted` 在任务5提供，任务7加入完整删除状态转换。

`WikiSourceStore(db, files, libraries)` 的方法：`list(kbId,includeDeleted=false)`、`get(kbId,sourceId)`、`createText(kbId,input:{kind:'manual'|'upload';name:string;content:string})`、`createProject(kbId,preview:WikiImportPreview,content:string)`、`updateText(kbId,sourceId,content,expected:WikiVersion)`、`readSnapshot(kbId,ref)`、`pending(kbId,sourceIds?)`、`markProcessing(kbId,sourceId)`、`markResult(kbId,sourceId,revision,result:{status:'succeeded'|'failed';error?:string})`、`suppress(kbId,sourceId)`、`allowRegeneration(kbId,sourceId)`。`allowRegeneration` 只由显式重新生成调用；更新资料不会自动清除抑制。

`WikiStore(db,rootDir,libraries?)` 新方法：`createManual(kbId,input)`、`readById(kbId,pageId)`、`listByLibrary(kbId)`、`searchByLibraries(kbIds:string[],query:string,limit?:number):WikiPageHit[]`、`saveManual(kbId,pageId,input)`、`setLocked(kbId,pageId,locked,expected)`、`publishGenerated(permit,title,content)`、`deletePageFiles(kbId,pageId)`、`reindexLibrary(kbId)`。旧 `replacePage/readPage/listPages/search/rebuildIndex/deleteWorkspace` 保留签名，以 original workspace 映射定位；RPC 层先查关联，不能把兼容映射当授权。

`WikiLibraryService` 的构造参数为 `{ libraries, sources, pages, jobs: JobStore, runServiceTask: (input: Omit<QueueTaskInput,'system'>)=>Promise<unknown>, modelLabel:()=>Promise<string>, validateProject:(workspace:string)=>Promise<string> }`，方法为 `previewImport(kbId,projectWorkspace,relativePath)`、`addSource(kbId,input)`、`previewIngest(kbId,sourceIds?,regenerateSourceIds?)`、`startIngest(kbId,sourceIds?,regenerateSourceIds?,expectedModel?)`、`runIngest(jobId)`、`requestCancel(jobId)`、`previewDelete(target)`、`remove(target,cancelActive)`、`summary(jobId)`、`reindex(kbId)`；startIngest只等只读模型描述，随后同步事务落任务并返回receipt，不等待模型生成。previewIngest只读返回所选资料ID/真实数量/当前模型，无模型配置抛MODEL_UNAVAILABLE；确认时传expectedModel，改变则抛MODEL_CHANGED重新预览。RuntimeOptions新增 `wikiModelLabel?:()=>Promise<string>`；main固定注入 `()=>systemWorker.describeModel()`，没有注入/读取失败时禁抽取，不能使用默认假模型。validateProject选项在任务3提供。

供 renderer 使用的全部入口（每一项对应独立 IPC；`remove` 表示带删除门的资源删除）：

```ts
export interface WikiManagementApi {
  libraries: {
    list(input?: { query?: string; project?: string }): Promise<WikiLibraryView[]>;
    read(kbId: string): Promise<WikiLibraryView>;
    create(input: WikiLibraryInput): Promise<WikiLibraryView>;
    update(kbId: string, input: WikiLibraryInput, expectedRevision: number): Promise<WikiLibraryView>;
    previewDelete(kbId: string): Promise<WikiDeletePreview>;
    remove(kbId: string, cancelActive: boolean): Promise<WikiDeleteResult>;
    previewIngest(kbId: string, sourceIds?: string[], regenerateSourceIds?: string[]): Promise<WikiIngestPreview>;
    ingest(kbId: string, sourceIds?: string[], regenerateSourceIds?: string[], expectedModel?: string): Promise<WikiIngestReceipt>;
    reindex(kbId: string): Promise<WikiReindexResult>;
  };
  sources: {
    list(kbId: string): Promise<WikiSource[]>;
    read(kbId: string, sourceId: string): Promise<{ source: WikiSource; content: string }>;
    previewImport(kbId: string, projectWorkspace: string, relativePath: string): Promise<WikiImportPreview>;
    create(kbId: string, input: WikiSourceInput): Promise<WikiSource>;
    update(kbId: string, sourceId: string, content: string, expected: WikiVersion): Promise<WikiSource>;
    previewDelete(kbId: string, sourceId: string): Promise<WikiDeletePreview>;
    remove(kbId: string, sourceId: string, cancelActive: boolean): Promise<WikiDeleteResult>;
  };
  pages: {
    list(kbId: string): Promise<Array<Omit<WikiPage,'content'>>>;
    read(kbId: string, pageId: string): Promise<WikiPage | undefined>;
    create(kbId: string, input: WikiPageInput): Promise<WikiPage>;
    update(kbId: string, pageId: string, input: WikiPageSave): Promise<WikiPage>;
    setLocked(kbId: string, pageId: string, locked: boolean, expected: WikiVersion): Promise<WikiPage>;
    previewDelete(kbId: string, pageId: string): Promise<WikiDeletePreview>;
    remove(kbId: string, pageId: string, cancelActive: boolean): Promise<WikiDeleteResult>;
  };
}
```

不得用 `unknown` 或 `any` 丢失 DTO 版本契约。新 runtime 方法名逐项为 `wiki.libraries.*` / `wiki.sources.*` / `wiki.pages.*`，renderer 名称与 runtime 一致。`wiki.read/list/search/replace/reindex` 保留。管理类创建/修改/删除/抽取在 socket 上拒绝；项目允许新 `libraries.list/read`、`pages.list/read` 和 `pages.search`（参数 `{kbId?:string,query:string,limit?:number}`，返回 `WikiPageHit[]`），均只读取关联库。来源原文管理不自动开放给 Agent。项目列表/读取 DTO 剥除 `location/storageKey/legacyWorkspace`，只保留库ID、名称、用途及可用计数；内部类型不是全量跨进程序列化授权。

## 2. 实施任务

### 任务 1：定义契约与库/物理桶分离

**文件：** 创建 `electron-agent/electron/agentData/wikiContracts.ts`、`wikiLibraryStore.ts`、`wikiLibraryStore.test.ts`、`wikiTestFixture.ts`；修改 `electron-agent/electron/agentData/wikiFiles.ts`。

- [ ] **步骤 1：加入类型与首个红测。** 类型按 §1.1 原样建立；测试工具首先只依赖本任务对象：

```ts
// wikiTestFixture.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDataStorage } from './storage';
import { WikiFiles } from './wikiFiles';
import { WikiLibraryStore } from './wikiLibraryStore';
export function libraryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-workbench-'));
  const storage = new AgentDataStorage(':memory:'); storage.migrate(); const db = storage.db;
  const files = new WikiFiles(root);
  const libraries = new WikiLibraryStore(db, files);
  return { root, db, storage, files, libraries, dispose: () => { storage.close(); rmSync(root, { recursive: true, force: true }); } };
}
```

```ts
import { expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { libraryFixture } from './wikiTestFixture';
it('creates same-name libraries with independent IDs but never treats an ID as a path', () => {
  const f = libraryFixture();
  try {
    const a = f.libraries.create({ name: '  产品  ', description: '', bindings: [] });
    const b = f.libraries.create({ name: '产品', description: '', bindings: [] });
    expect(a.name).toBe('产品'); expect(a.kbId).not.toBe(b.kbId);
    expect(a.storageKey).not.toBe(a.kbId);
    expect(existsSync(f.files.bucketDir(a))).toBe(true);
    expect(readdirSync(f.files.bucketDir(a))).toEqual(['library.json']);
    const renamed = f.libraries.update(a.kbId, { name: '新版', description: '用途', bindings: [] }, a.revision);
    expect(renamed).toMatchObject({ kbId: a.kbId, storageKey: a.storageKey });
    expect(() => f.files.bucketDir({ kbId: a.kbId, storageKey: '../project' })).toThrow(/storage/i);
    expect(() => f.libraries.create({ name: ' ', description: '', bindings: [] })).toThrow(/name/i);
    expect(() => f.libraries.create({ name: 'x', description: 'x'.repeat(501), bindings: [] })).toThrow(/description/i);
  } finally { f.dispose(); }
});
```

- [ ] **步骤 2：运行红测。** `npm exec -- vitest run electron/agentData/wikiLibraryStore.test.ts -t "creates same-name"`；预期缺少 `WikiLibraryStore` / `bucketDir`，不能把导入错误当最终覆盖。
- [ ] **步骤 3：实现最小库持久化与 bucket API。** 新增 `wiki_libraries(kb_id PRIMARY KEY,storage_key UNIQUE,legacy_workspace,name,description,revision,lifecycle,epoch,created_at,updated_at)`、`wiki_library_bindings(kb_id,workspace,PRIMARY KEY(kb_id,workspace))`。创建事务只写行和 `library.json`；使用现有 publication 的 commit/rollback 成对更新 JSON 与 SQL。名称用 Unicode code point 计数，1–80；description 最多 500。bindings 在服务层验证后去重，Store 不访问项目文件。

```ts
// WikiFiles：safePath 仍逐段 lstat、检查 root realpath；这里不再 hash(kbId)。
bucketDir(bucket: WikiBucket): string {
  if (!/^(?:[a-f0-9]{64}|kb-[0-9a-f-]{36})$/.test(bucket.storageKey)) throw new Error('invalid Wiki storage key');
  return this.safePath(bucket.storageKey);
}
filePathAt(bucket: WikiBucket, path: string): string {
  this.bucketDir(bucket);
  return this.safePath(`${bucket.storageKey}/${wikiRelativePath(path)}`);
}
// create 中的身份构造；writeManifest 使用 publishAt 并参与本次 SQL 事务。
const now = Date.now();
const library: WikiLibrary = {
  kbId: randomUUID(), storageKey: `kb-${randomUUID()}`,
  name: input.name.trim(), description: input.description.trim(), bindings: [...new Set(input.bindings)],
  revision: 1, lifecycle: 'active', epoch: 1, createdAt: now, updatedAt: now,
};
```

把 `publish/readText/write/remove` 的安全核心提取为对应 `*At(bucket,...)`，旧 `workspaceDir/filePath` 继续只创建 `{kbId:'legacy',storageKey:wikiHash(workspace),legacyWorkspace:workspace}` 适配对象。不要把名称、资料名或 UI 路径参与 `storageKey`。`library.json` 存完整库元数据，库元数据修改也递增 revision；失败保留原 JSON / 行，不新建空目录冒充成功。

- [ ] **步骤 4：运行绿测。** 同一命令 PASS，再运行 `npm exec -- vitest run electron/agentData/wikiStore.test.ts`，确认现有路径/原子发布测试仍通过。
- [ ] **步骤 5：验收。** 创建两同名库得到两 UUID；目录只有元数据，无原文、无扫描、无任务和模型调用；重命名路径不变。新增库只能位于 Runtime 固定的 `wikiRoot` 下。

### 任务 2：原桶登记与可恢复迁移

**文件：** 修改 `electron-agent/electron/agentData/wikiLibraryStore.ts`、`wikiFiles.ts`、`wikiStore.ts`、`runtime.ts`；扩展 `wikiLibraryStore.test.ts`、`wikiStore.test.ts`。

- [ ] **步骤 1：加入幂等与失败桶红测。** 本测试完整建立已有桶，不运行真实数据库：

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wikiHash } from './wikiFiles';
it('registers original buckets once without moving or rewriting any page', () => {
  const f = libraryFixture();
  try {
    const workspace = 'D:/old-project'; const dir = join(f.root, wikiHash(workspace));
    mkdirSync(join(dir, 'wiki'), { recursive: true });
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ version: 1, workspace, legacyExported: ['guide'] }));
    const text = '---\npage: guide\nlocked: true\nsources: [raw/sources/v1.md]\n---\n\n# 手工正文';
    writeFileSync(join(dir, 'wiki', 'guide.md'), text);
    expect(f.libraries.registerLegacyBuckets()).toEqual([]);
    const first = f.libraries.resolveLegacy(workspace)!;
    f.libraries.update(first.kbId, { name: '已命名', description: '', bindings: [] }, first.revision);
    f.libraries.registerLegacyBuckets();
    expect(f.libraries.resolveLegacy(workspace)).toMatchObject({ kbId: first.kbId, name: '已命名', bindings: [], storageKey: wikiHash(workspace) });
    expect(readFileSync(join(dir, 'wiki', 'guide.md'), 'utf8')).toBe(text);
    writeFileSync(join(dir, 'workspace.json'), '{broken');
    expect(f.libraries.registerLegacyBuckets()).toEqual([expect.objectContaining({ code: 'LEGACY_MAPPING_INVALID', path: join(dir, 'workspace.json') })]);
    expect(f.libraries.resolveLegacy(workspace)?.kbId).toBe(first.kbId);
  } finally { f.dispose(); }
});
```

再以 `vi.spyOn(f.db,'exec')` 在 COMMIT 第一次抛 `SQLITE_FULL fixture`，断言 `library.json` 若已发布会回滚、原页面字节不变，第二次登记仅一个库。以原 `wikiStore.test.ts` 的 `legacy(db,...)` 种子补一例导出失败：原 `wiki_pages` 仍在、没有将该桶注册成可用空库，正常桶仍能登记。

- [ ] **步骤 2：运行红测。** `npm exec -- vitest run electron/agentData/wikiLibraryStore.test.ts -t "registers original"`；预期映射方法缺失或重跑覆写关联。
- [ ] **步骤 3：实现登记算法。** `WikiFiles.legacyBuckets()` 只枚举原根的 64 位哈希目录，逐桶验证 `workspace.json`、`wikiHash(mapping.workspace)===目录名`、禁止链接；返回 `{buckets:WikiBucket[],diagnostics:WikiDiagnostic[]}`。新增 `wiki_legacy_library_map(workspace PRIMARY KEY,kb_id UNIQUE,storage_key UNIQUE)`，保留原 workspace 字符串用于原哈希；授权比较使用任务 3 的规范化项目键。

```ts
for (const bucket of scan.buckets) {
  const mapped = this.resolveLegacy(bucket.legacyWorkspace!);
  if (mapped) continue; // 包含解绑/已删除映射，绝不自动补回关联。
  const persisted = files.readLibraryManifest(bucket); // 无文件返回 undefined；损坏抛出带 path 错误。
  const kbId = persisted?.kbId ?? randomUUID();
  const library = persisted ?? {
    ...bucket, kbId, name: basename(bucket.legacyWorkspace!), description: '',
    bindings: [bucket.legacyWorkspace!], revision: 1, lifecycle: 'active' as const,
    epoch: 1, createdAt: Date.now(), updatedAt: Date.now(),
  };
  this.registerOneLegacy(library); // BEGIN IMMEDIATE；库行+映射+绑定+library.json publication 同一回滚边界。
}
```

`readLibraryManifest` / `registerOneLegacy` 只读写 `library.json`，不写 `wiki/`、`raw/`、`legacy-backup/`。已删除库保留轻量 `library.json` tombstone 与 legacy 映射，重启不能复活。旧 `sourcePath/sources` 的快照引用先保留原 frontmatter；任务 4 仅登记来源元数据，不重写旧正文。Runtime 启动次序保持 `WikiStore` 原兼容导出 → 获取兼容导出诊断 → `registerLegacyBuckets` → 重建新库索引；有原导出错误的桶进入诊断、不标可用。

- [ ] **步骤 4：运行绿测。** `npm exec -- vitest run electron/agentData/wikiLibraryStore.test.ts electron/agentData/wikiStore.test.ts`；所有迁移、SQL 原文保留、手工页、删除不复活测试 PASS。
- [ ] **步骤 5：验收。** 重启/重跑/重命名/解绑均不改变 kbId；页面 ID、locked、快照、原桶路径和导出标记不变；故障信息包含具体文件路径，可重试，不能静默覆盖。

### 任务 3：管理入口、项目凭据与兼容请求的后端范围

**文件：** 修改 `electron-agent/electron/agentData/{runtime,requestFrames}.ts`、`electron-agent/electron/app/{agentDataService,piRuntimeService}.ts`、`electron-agent/electron/main.ts`、`electron-agent/electron/ipc/contracts.ts`；新建 `electron-agent/electron/app/validateProject.ts`；创建/扩展 `electron-agent/electron/agentData/runtime.wiki.test.ts`、`runtime.extensions.test.ts`、`requestFrames.test.ts`、`electron-agent/electron/app/{agentDataService,piRuntimeService,validateProject}.test.ts`。

- [ ] **步骤 1：写项目 token 越界红测。** Runtime 新入口签名先按此测试定义，`dataPath: ':memory:'` 使用已有临时 Wiki 根：

```ts
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import type { WikiLibrary } from './wikiContracts';
it('binds Wiki scope to a main-issued project token and rejects spoofed admin scope', async () => {
  const runtime = new AgentDataRuntime({ dataPath: ':memory:', validateProject: async (p) => p });
  await runtime.start(); const a = new AgentDataClient(runtime.agentEndpoint('D:/a'));
  const b = new AgentDataClient(runtime.agentEndpoint('D:/b'));
  try {
    const library = await runtime.requestAdmin<WikiLibrary>('wiki.libraries.create', { name: '共享', description: '', bindings: ['D:/a', 'D:/b'] });
    await expect(a.request('wiki.libraries.list', {})).resolves.toHaveLength(1);
    await expect(a.request('wiki.libraries.list', { workspace: 'D:/b' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(a.request('wiki.libraries.create', { name: '伪管理', admin: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runtime.requestAdmin('wiki.libraries.update', { kbId: library.kbId, name: '共享', description: '', bindings: ['D:/b'], expectedRevision: library.revision });
    await expect(a.request('wiki.libraries.list', {})).resolves.toEqual([]);
    await expect(a.request('wiki.pages.list', { kbId: library.kbId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(b.request('wiki.pages.list', { kbId: library.kbId })).resolves.toEqual([]);
  } finally { await a.close(); await b.close(); runtime.close(); }
});
```

同文件追加：原 workspace 已登记且解绑后，`wiki.read/list/search/replace/reindex` 五种兼容请求全部被拒绝；从未拥有 legacy 映射且零绑定的项目 `wiki.search/list` 返回空集，不退回全库；旧兼容读只查 original 映射库而不扩大到后加库。`requestFrames.test.ts` 用两个已授权 token 发送同 id 的交错 chunk，断言混合 envelope 被拒绝；超过 1MiB 的正常项目请求仍成功。现有 runtime.extensions.test.ts 的 Wiki 场景改用所测项目的 agentEndpoint，非Wiki测试保留内部 endpoint。

- [ ] **步骤 2：运行红测。** `npm exec -- vitest run electron/agentData/runtime.wiki.test.ts electron/agentData/requestFrames.test.ts`；预期 `agentEndpoint/requestAdmin` 缺失或 token 仍共享全局范围。
- [ ] **步骤 3：实现最小可信上下文。** `AgentDataRuntime.requestAdmin<T>(method:string,params:Record<string,unknown>={}):Promise<T>` 仅为 in-process 入口，固定 `{kind:'admin'}`，`AgentDataService.requestAdmin` 只转调本地 runtime。新管理方法不注册成可调用该入口的 socket RPC，也不接收 `admin=true` / `context`。

管理入口抛到Electron IPC之前保留稳定错误前缀，例如 `VERSION_CONFLICT: Wiki page changed`、`FORBIDDEN: library not bound`。`RpcError.code`跨Electron边界可能不保留，不能只让renderer检查error.code。统一用 `new Error(`${code}: ${message}`)` 输出管理业务错误；未知错误保留原message、不塞数据库SQL/token/原文。IPC/API测试断言 `String(error)`包含VERSION_CONFLICT，后续Memory沿用相同传输约定。

```ts
private readonly projectTokens = new Map<string, string>(); // token -> normalized workspace
private readonly workspaceTokens = new Map<string, string>();
agentEndpoint(workspace: string): AgentDataEndpoint {
  if (!this.endpoint || this.closed) throw new Error('runtime is not started');
  const key = normalizeWikiWorkspace(workspace);
  let token = this.workspaceTokens.get(key);
  if (!token) { token = randomBytes(32).toString('hex'); this.workspaceTokens.set(key, token); this.projectTokens.set(token, key); }
  return { host: this.endpoint.host, port: this.endpoint.port, token };
}
private wikiContext(token: string, params: Record<string, unknown>): WikiRequestContext {
  const workspace = this.projectTokens.get(token);
  if (!workspace) throw new RpcError('FORBIDDEN', 'Wiki socket requires a project endpoint');
  if (params.workspace !== undefined && normalizeWikiWorkspace(readString(params.workspace)) !== workspace) throw new RpcError('FORBIDDEN', 'workspace does not match endpoint');
  return { kind: 'project', workspace };
}
```

`normalizeWikiWorkspace` 导出于纯 Node `wikiLibraryStore.ts`：`resolve(value).replace(/\\/g,'/').replace(/\/$/,'')`，Windows 才 `toLowerCase()`，空白立即抛错；它用于绑定比较，不重算原 storageKey。主进程签发前已 `resolveWorkspace`，所以 PiRuntime 改为 `agentDataEndpoint?: (workspace:string)=>string|undefined`，`openClient` 传已经解析的 `cwd`，main 改用 `agentData.agentEndpoint(cwd)`；不再把 `agentData.endpoint()` 的 root token 注入 Pi。根 endpoint 仅供既有 main 内部服务和非 Wiki 兼容调用，不能调用新 Wiki 管理方法；原 main 的 Wiki 写入改走 `requestAdmin` 后再经同一发布保护。

`RequestFrameDecoder` 构造参数改成 `string | ((token:string)=>boolean)`，兼容现有单 token 测试；`PartialRequest` 保存 token，所有片段、最终内层 request 的 token 必须同一且当前有效。Runtime 传验证 root 或 project token 的函数，并在 `handleLine` 再查实时 context。`close()` 清空两个 token map 并断开 socket；重新启动建立新 runtime，新 token，不复用老 endpoint。Pi 进程在数据运行时重启后须通过现有重启入口重新打开，不把旧 token 无限重试成空数据；UI显示连接失效。测试只比较 token 不相等，绝不输出其值。

本任务先接通库 list/read/create/update 与只读页适配，页 CRUD 的正文实现由任务5提供；不能为未实现方法伪造成功。为 token 更新追加具体红测：AgentDataService start→取project endpoint→stop→start→新endpoint，与旧token不相等；使用旧token配新port发wiki请求返回UNAUTHORIZED，新token正常。PiRuntimeService测试的callback spy必须收到resolveWorkspace返回的cwd而非UI原始字符串，manager.open的env中无root endpoint。

人工项目校验的完整算法放 `validateProject.ts`，main 传给 Runtime，第三阶段直接复用：

```ts
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
export async function validateProject(workspace: string, worksDir: string): Promise<string> {
  const target = await realpath(workspace); const temporary = await realpath(worksDir);
  if (!(await stat(target)).isDirectory()) throw new Error('PROJECT_NOT_DIRECTORY');
  const rel = relative(temporary, target);
  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new Error('TEMPORARY_PROJECT_NOT_ALLOWED');
  return target.replace(/\\/g, '/');
}
```

该校验不创建目录、不把临时目录提升成项目。用临时文件、真实目录、`works/<uuid>` 和指向 works 的 junction 各一例测试。旧迁移关联不调用它。此边界只保证 Wiki 的本地项目范围，不声称其它 RPC 已具备多租户安全。

- [ ] **步骤 4：运行绿测。** `npm exec -- vitest run electron/agentData/runtime.wiki.test.ts electron/agentData/requestFrames.test.ts electron/app/agentDataService.test.ts electron/app/piRuntimeService.test.ts electron/app/validateProject.test.ts`。
- [ ] **步骤 5：验收。** 管理页可看未关联库；Agent 空 scope 不全局化；解绑实时生效；伪项目、伪 admin、混合 chunk 和重启前 token 均拒绝；新 token 能读当前关联库；测试无凭据日志。

### 任务 4：资料 UUID、版本快照与受限项目导入

**文件：** 创建 `electron-agent/electron/agentData/wikiSourceStore.ts`、`wikiSourceStore.test.ts`、`electron-agent/electron/app/wikiLibraryService.ts`、`wikiLibraryService.test.ts`；修改 `wikiFiles.ts`、`wikiTestFixture.ts`。

- [ ] **步骤 1：扩展 fixture 并写红测。** 在 `wikiTestFixture.ts` 导入 `WikiSourceStore`，新增 `sourceFixture(){const f=libraryFixture();return {...f,sources:new WikiSourceStore(f.db,f.files,f.libraries)}}`。

```ts
import { sourceFixture } from './wikiTestFixture';
it('creates same-name uploads as new sources and keeps referenced revision snapshots', () => {
  const f = sourceFixture();
  try {
    const kb = f.libraries.create({ name: '资料', description: '', bindings: [] });
    const a = f.sources.createText(kb.kbId, { kind: 'upload', name: 'README.md', content: '# A' });
    const b = f.sources.createText(kb.kbId, { kind: 'upload', name: 'README.md', content: '# B' });
    expect(a.sourceId).not.toBe(b.sourceId); expect(a.generatedPageId).not.toBe(b.generatedPageId);
    const updated = f.sources.updateText(kb.kbId, a.sourceId, '# A2', a);
    expect(updated).toMatchObject({ sourceId: a.sourceId, revision: 2, status: 'pending' });
    expect(f.sources.readSnapshot(kb.kbId, { sourceId: a.sourceId, revision: 1 })).toBe('# A');
    expect(f.sources.readSnapshot(kb.kbId, { sourceId: a.sourceId, revision: 2 })).toBe('# A2');
    expect(() => f.sources.updateText(kb.kbId, a.sourceId, '# stale', a)).toThrow('VERSION_CONFLICT');
    expect(() => f.sources.createText(kb.kbId, { kind: 'upload', name: 'x.pdf', content: 'binary' })).toThrow('UNSUPPORTED_SOURCE');
  } finally { f.dispose(); }
});
```

项目导入红测使用 `mkdtempSync` 建 `project-a`、`project-b`、`outside`，各写 `README.md`，为 outside 创建 project 内 junction；`previewImport` 对 `../outside/README.md`、`C:\outside.md`、junction 路径、未关联 project 均拒绝；两个真实关联项目的 README 创建两个 ID，preview 后改变原文件则 `addSource` 抛 `SOURCE_CHANGED`。最终逐字节确认两个原文件未被写回或删除。

- [ ] **步骤 2：运行红测。** `npm exec -- vitest run electron/agentData/wikiSourceStore.test.ts electron/app/wikiLibraryService.test.ts`；预期 revision 快照与显式来源接口缺失。
- [ ] **步骤 3：实现资料持久化。** 新增 `wiki_sources` 保存 §1.1 字段，`wiki_source_revisions(kb_id,source_id,revision,content_hash,snapshot_path,PRIMARY KEY(kb_id,source_id,revision))`。创建一律新 UUID；文件路径只由 ID/revision/hash 生成 `raw/sources/<sourceId>/<revision>-<hash>.md|txt`。更新显式指定 sourceId 并检查旧版本；相同字节返回当前 revision，不多存一份。

```ts
// updateText 的事务内核心；相应 createText 同样用不可变 publication。
const current = this.get(kbId, sourceId);
if (!current || current.lifecycle !== 'active') throw new Error('SOURCE_NOT_ACTIVE');
if (current.revision !== expected.revision || current.contentHash !== expected.contentHash) throw new Error('VERSION_CONFLICT');
const contentHash = wikiHash(content);
if (contentHash === current.contentHash) return current;
const revision = current.revision + 1;
const snapshotPath = `raw/sources/${sourceId}/${revision}-${contentHash}.md`;
// INSERT revision + UPDATE source(status='pending', error=NULL)，提交失败回滚新快照，旧快照不删。
```

`previewImport` 与 `addSource(project)` 都先检查当前库绑定，再用已有 `readWorkspaceSource` 的 resolve + realpath 双边界读取；补 `wikiRelativePath` 拒绝 Windows 盘符/ADS/保留名，仅 `.md/.txt`，禁止目录链接外跳。`addSource` 重新读取并比较 preview 的 hash，不能相信 renderer 提交的项目原文。

```ts
async addSource(kbId: string, input: WikiSourceInput): Promise<WikiSource> {
  if (input.kind !== 'project') return this.options.sources.createText(kbId, input);
  const preview = await this.previewImport(kbId, input.projectWorkspace, input.relativePath);
  if (preview.contentHash !== input.expectedContentHash) throw new Error('SOURCE_CHANGED');
  const content = await readWorkspaceSource(preview.projectWorkspace, preview.relativePath);
  if (wikiHash(content) !== preview.contentHash) throw new Error('SOURCE_CHANGED');
  return this.options.sources.createProject(kbId, preview, content);
}
```

每次 await 后进入 Store 写入时再次检查库 lifecycle / 绑定，防止导入读取期间已解绑或删除。旧页面 `sources[]` 登记到 `wiki_source_revisions` 的原相对 snapshotPath；维护 `wiki_legacy_source_map(kb_id,legacy_source_path,source_id)`，一次生成 UUID 后持久化，不拷贝快照，不伪造丢失来源。旧页面没有 snapshot 时保留“旧来源未保存快照”诊断，而非创建假的 revision。

- [ ] **步骤 4：运行绿测。** 同一命令 PASS；加跑 `npm exec -- vitest run electron/app/wikiSyncService.test.ts`，项目只读路径保护不回归。
- [ ] **步骤 5：验收。** 同名不是更新；更新必须有 sourceId+version；旧快照可读；资料保存零模型调用；外链/越界/未关联失败逐项可解释；项目原文不变。

### 任务 5：人工页面版本、来源引用与生成发布保护

**文件：** 修改 `electron-agent/electron/agentData/wikiFiles.ts`、`wikiStore.ts`、`wikiLibraryStore.ts`、`wikiTestFixture.ts`；新建 `electron-agent/electron/agentData/wikiPages.test.ts`。

- [ ] **步骤 1：扩展 fixture 并写红测。** 新增 `pageFixture(){const f=sourceFixture();return {...f,pages:new WikiStore(f.db,f.root,f.libraries)}}`，不改变旧 `WikiStore` 的兼容构造路径。

```ts
import { writeFileSync, readFileSync } from 'node:fs';
import { pageFixture } from './wikiTestFixture';
it('locks manual saves, protects external edits, and never erases other source refs', () => {
  const f = pageFixture();
  try {
    const kb = f.libraries.create({ name: '页面', description: '', bindings: [] });
    const a = f.sources.createText(kb.kbId, { kind: 'manual', name: 'a.md', content: 'A' });
    const b = f.sources.createText(kb.kbId, { kind: 'manual', name: 'b.md', content: 'B' });
    const refs = [{ sourceId: a.sourceId, revision: 1 }, { sourceId: b.sourceId, revision: 1 }];
    const p = f.pages.createManual(kb.kbId, { title: '汇总', content: '# 人工', sourceRefs: refs });
    expect(p).toMatchObject({ locked: true, sourceRefs: refs, revision: 1 });
    writeFileSync(p.path, readFileSync(p.path, 'utf8').replace('# 人工', '# 外部'));
    expect(() => f.pages.saveManual(kb.kbId, p.pageId, { title: p.title, content: '# 草稿', sourceRefs: refs, expected: p })).toThrow('VERSION_CONFLICT');
    expect(f.pages.readById(kb.kbId, p.pageId)?.content).toBe('# 外部');
    const noSource = f.pages.createManual(kb.kbId, { title: '手记', content: '', sourceRefs: [] });
    expect(() => f.pages.setLocked(kb.kbId, noSource.pageId, false, noSource)).toThrow('SOURCE_REQUIRED');
  } finally { f.dispose(); }
});
```

另建生成页：`permit=f.libraries.acquirePermit(kbId,a.sourceId)`、`publishGenerated(permit,'A','old')`；读取后解锁/保存人工正文，再用旧 permit 发布，断言 `{state:'skipped',reason:'locked'}` 或 `'changed'`，其余来源继续可生成。把生成页 sourceRefs 人工改为上述两来源并显式解锁后，再生成返回 `multi_source` 且两个引用完整。将无 frontmatter 的外部 Markdown 读入时断言 `locked===false`，`locked: "true"` 则读失败并给诊断。

- [ ] **步骤 2：运行红测。** `npm exec -- vitest run electron/agentData/wikiPages.test.ts`；预期人工保存和 CAS 方法不存在。
- [ ] **步骤 3：先建立页面索引域，再扩展 frontmatter 与同步发布。** 此处完成 `wiki_documents` / `wiki_fts` 的库维度升级，不能推迟到任务12导致前面CRUD没有持久化结构：在单事务中建立新表，`wiki_documents` 以 `(kb_id,page)` 主键，保留 workspace 兼容列并新增 revision/source_refs/auto_source_id；FTS以kb_id分区。按任务2映射回填已有索引，原索引表改名为 `wiki_documents_before_libraries` / `wiki_fts_before_libraries` 留作回退，迁移标记防止反复改名；没有有效映射的失败桶保留旧索引和诊断，不能丢掉。新库的 workspace 列写空字符串，绝不写kbId假装路径。原 legacy 兼容构造测试继续使用原列查询语义，库模式方法使用kb_id查询。

v2 frontmatter 包含 `kbId,pageId,title,sourceRefs,revision,locked,autoSourceId?,updatedAt`；读取 legacy 时 pageId 使用原 `page`，revision 默认 0，旧 `sources` 保留并通过登记映射产生真实 sourceRefs。未声明 locked 仍 false；来源不属于本库或 revision 不存在拒绝人工保存。人工保存始终 locked=true；解锁必须独立 `setLocked`，无来源拒绝，可显示多来源需显式维护。`wiki_page_state` 的 active/epoch基础行在本任务创建，任务7扩展删除转换。

```ts
// publishGenerated：整段同步运行于 BEGIN IMMEDIATE，期间没有 await。
if (!this.libraries.permitActive(permit)) return { state: 'skipped', reason: 'deleted' };
const current = this.readById(permit.kbId, permit.pageId);
if (current?.locked) return { state: 'skipped', reason: 'locked' };
if (current && (current.autoSourceId !== permit.sourceId || current.sourceRefs.length !== 1 || current.sourceRefs[0].sourceId !== permit.sourceId)) return { state: 'skipped', reason: 'multi_source' };
if ((current === undefined) !== (permit.expected === null) ||
    (current && (current.revision !== permit.expected!.revision || current.contentHash !== permit.expected!.contentHash))) return { state: 'skipped', reason: 'changed' };
const source = this.sourcesForPublication(permit.kbId, permit.sourceId);
if (source.generationSuppressed) return { state: 'skipped', reason: 'suppressed' };
if (source.revision !== permit.sourceRevision) return { state: 'skipped', reason: 'changed' };
const next = {
  kbId: permit.kbId, pageId: permit.pageId, title, content,
  sourceRefs: [{ sourceId: permit.sourceId, revision: permit.sourceRevision }],
  locked: false, autoSourceId: permit.sourceId, revision: (current?.revision ?? 0) + 1,
  lifecycle: 'active' as const, epoch: permit.pageEpoch, updatedAt: Date.now(),
};
return { state: 'published', page: this.commitPage(next, current) };
```

`sourcesForPublication` 为 WikiStore 的私有 SQL 查询，返回已定义 WikiSource，不再增加公共服务；`commitPage(next,current)` 复用原 `indexPage` + `WikiFilePublication` 事务回滚算法，生成 path，render 后计算完整文件哈希，返回完整 WikiPage。`publishAt` 接收 `expectedHash?:string|null`，创建临时文件后、rename 前重新读取目标字节比较，冲突则删除本次临时文件、不触碰旧文件或索引；内部写入同一同步事务串行。继续保留 rename/SQL COMMIT/ENOSPC 的现有回滚测试。不得宣称可排除任意外部进程在最终比较与 rename 之间的所有 OS 级竞争；已观测变化和应用内并发必须拒绝。

- [ ] **步骤 4：运行绿测。** `npm exec -- vitest run electron/agentData/wikiPages.test.ts electron/agentData/wikiStore.test.ts`。
- [ ] **步骤 5：验收。** 人工页面可无来源，保存锁定；旧生成结果不能覆盖新人工/外部文件；多来源不被单源自动写抹掉；新保存同步可搜索，SQL/文件失败时旧版本可恢复。

### 任务 6：显式增量抽取接入既有任务链路

**文件：** 修改 `electron-agent/electron/app/wikiLibraryService.ts`、`wikiSyncService.ts`、`electron-agent/electron/agentData/{runtime,wikiLibraryStore,wikiSourceStore,jobStore,wikiTestFixture}.ts`、`electron-agent/electron/pi/systemWorkerManager.ts`、`electron-agent/electron/main.ts`、`extensions/wiki-rag/sync.ts`；扩展 `wikiLibraryService.test.ts`、`wikiSyncService.test.ts`、`runtime.wiki.test.ts`、`jobStore.test.ts`、`electron-agent/electron/pi/systemWorkerManager.test.ts`、`electron-agent/electron/app/appServer/serviceTaskRegistry.test.ts`、`extensions/wiki-rag/sync.test.ts`。

- [ ] **步骤 1：建立服务测试 fixture 并写红测。** `wikiTestFixture.ts` 增加以下函数；JobStore 本身会创建任务/审计表，模拟的只有模型执行端口，不伪造生产 store：

```ts
import { vi } from 'vitest';
import { JobStore } from './jobStore';
import { WikiLibraryService } from '../app/wikiLibraryService';
import type { QueueTaskInput } from '../app/appServer/taskQueue';
export function workbenchFixture() {
  const f = pageFixture(); const jobs = new JobStore(f.db);
  const generate = vi.fn<(input: Omit<QueueTaskInput,'system'>) => Promise<unknown>>(async () => '# Generated');
  const service = new WikiLibraryService({ ...f, jobs, runServiceTask: generate, modelLabel: async () => 'fixture-model', validateProject: async (p) => p });
  return { ...f, jobs, generate, service };
}
```

```ts
import { workbenchFixture } from '../agentData/wikiTestFixture';
it('ingests only pending versions and skips locked pages without failing the batch', async () => {
  const f = workbenchFixture();
  try {
    const kb = f.libraries.create({ name: '抽取', description: '', bindings: [] });
    const a = f.sources.createText(kb.kbId, { kind: 'manual', name: 'a.md', content: 'A' });
    const b = f.sources.createText(kb.kbId, { kind: 'manual', name: 'b.md', content: 'B' });
    expect(f.generate).not.toHaveBeenCalled();
    const first = await f.service.startIngest(kb.kbId);
    await f.service.runIngest(first.jobId);
    const page = f.pages.readById(kb.kbId, a.generatedPageId)!;
    f.pages.saveManual(kb.kbId, page.pageId, { title: page.title, content: '# 手工', sourceRefs: page.sourceRefs, expected: page });
    f.sources.updateText(kb.kbId, a.sourceId, 'A2', a); f.sources.updateText(kb.kbId, b.sourceId, 'B2', b);
    const second = await f.service.startIngest(kb.kbId);
    await f.service.runIngest(second.jobId);
    expect(f.service.summary(second.jobId)).toEqual({ succeeded: 1, skipped: 1, failed: 0 });
    expect(f.pages.readById(kb.kbId, a.generatedPageId)?.content).toBe('# 手工');
    expect(f.generate.mock.calls.every(([input]) => input.kind === 'wiki_page_generate')).toBe(true);
    expect(f.sources.pending(kb.kbId).map((s) => s.sourceId)).toEqual([a.sourceId]);
  } finally { f.dispose(); }
});
```

服务实现令 `startIngest` 只落库，由 Runtime 下一 microtask 调 `runIngest`；测试显式调用避免双运行。增加 `runIngest` 同 job 重入保护。补 deferred Promise 测试：首份生成等待期间 `requestCancel`，job 仍 running；resolve 后该页不发布、最终 cancelled，已在此前成功的页面保留。

SystemWorker测试复用该文件已有fakeClient，get_state返回 `{model:{provider:'fixture',id:'model-a'}}`，调用describeModel断言返回fixture/model-a且未发prompt；缺失model或get_state拒绝时传播MODEL_UNAVAILABLE，服务preview失败且没有agent_jobs。再令new_session之后get_state返回model-b，带expectedModel='fixture/model-a'的新Wiki任务失败MODEL_CHANGED且prompt未调用；原memory_extract无expectedModel仍通过原测试。

- [ ] **步骤 2：运行红测。** `npm exec -- vitest run electron/app/wikiLibraryService.test.ts -t "ingests only"`；预期没有目标快照或逐项跳过。
- [ ] **步骤 3：实现编排而非新调度器。** 新增 `wiki_ingest_runs(job_id PRIMARY KEY,kb_id,items,cancel_requested,summary,model)`；items是 `WikiIngestItem[]` JSON，保存入队时的资料revision/hash/permit快照，而非执行时重新猜版本。新增 `wiki_task_targets(task_source,task_id,kb_id,source_id,page_id,active,can_cancel,PRIMARY KEY(task_source,task_id,kb_id,source_id,page_id))`；它只登记实际写者租约，不存名称/版本/payload。此表必须覆盖新的ingest用户job、每个系统子任务、原wiki.sync兼容job；旧wiki.sync没有ingest_runs，因此不能从新任务payload替代该门。资源ID缺省使用空字符串入库，避免SQLite NULL复合键允许重复。

先给 `agent_jobs` 加可选 `metadata TEXT`（PRAGMA检查后ALTER，保持旧NOT NULL workspace）；`Job`新增 `metadata?:JobMetadata`。JobMetadata定义在 `electron-agent/electron/agentData/jobStore.ts` 并export，属于通用任务类型，不放进Wiki实现类；结构如下，第四阶段只扩展target/payload联合，不再加另一列：

```ts
export interface JobMetadata {
  target?: { type: 'wiki'; id: string };
  payload?: { kbId: string; sourceIds: string[] };
  retryOf?: string;
}
// JobStore.create 增 metadata?:JobMetadata 输入，必须替换无列名的旧 INSERT。
this.db.prepare('INSERT INTO agent_jobs(id,kind,workspace,state,progress,error,created_at,updated_at,metadata) VALUES(?,?,?,?,?,?,?,?,?)')
  .run(id, input.kind, input.workspace, 'pending', 0, null, now, now, input.metadata ? JSON.stringify(input.metadata) : null);
```

`startIngest` 在同一 `BEGIN IMMEDIATE` 中检查 active、无同库活动抽取、sourceIds归属，选出 `status==='failed' || processedHash!==contentHash` 且未抑制的active资料，创建 `{kind:'wiki.ingest',workspace:'',metadata:{target:{type:'wiki',id:kbId},payload:{kbId,sourceIds}}}` 的用户job和目标记录；metadata只是显示/重试描述，不是实际运行版本真相。空workspace表示无单一项目，不塞kbId或任一关联项目；旧admin.jobs.create仍必须有workspace。零目标返回NO_PENDING_SOURCES，不创建假任务。JobStore红测分别创建无metadata旧job和新Wiki job，确保原8字段INSERT不因新增列失败、get/list读回metadata。

事务前 `const model=await options.modelLabel()`，确认expectedModel后再重新检查active/来源/绑定并落库，绝不跨await保持SQL事务。SystemWorker增加如下只读描述方法（复用已有isRecord），runTask仅在kind=wiki_page_generate且input.expectedModel存在时，于new_session成功后、prompt前调用并精确比较；别给旧memory任务强加该字段：

```ts
async describeModel(): Promise<string> {
  let state: unknown;
  try { state = await this.ensureClient().send<unknown>({ type: 'get_state' }); }
  catch (error) { throw new Error(`MODEL_UNAVAILABLE: ${String(error)}`); }
  const model = isRecord(state) && isRecord(state.model) ? state.model : undefined;
  if (!model || typeof model.provider !== 'string' || !model.provider || typeof model.id !== 'string' || !model.id) throw new Error('MODEL_UNAVAILABLE');
  return `${model.provider}/${model.id}`;
}
// 位于已有runTask的new_session之后、prompt之前，仍检查completion===pending。
if (task.kind === 'wiki_page_generate' && isRecord(task.input) && typeof task.input.expectedModel === 'string') {
  if (await this.describeModel() !== task.input.expectedModel) throw new Error('MODEL_CHANGED');
  if (this.completion !== pending) return;
}
```

get_state失败直接向调用方报告，不吞掉为默认模型；UI预览失败禁用确认。只读描述不会发prompt/调用LLM，可按现有空闲机制释放worker。

```ts
for (const item of run.items) {
  if (this.cancelRequested(jobId)) break;
  const { sourceId, permit } = item;
  const source = sources.get(run.kbId, sourceId)!;
  if (!libraries.permitActive(permit)) { summary.skipped++; this.recordSkip(jobId, sourceId, 'deleted'); continue; }
  if (source.revision !== item.sourceRevision || source.contentHash !== item.contentHash) { summary.skipped++; this.recordSkip(jobId, sourceId, 'changed'); continue; }
  const current = pages.readById(run.kbId, source.generatedPageId);
  if (current?.locked) { summary.skipped++; this.recordSkip(jobId, sourceId, 'locked'); continue; }
  sources.markProcessing(run.kbId, sourceId);
  try {
    const taskId = randomUUID();
    libraries.recordTask({ taskSource: 'service_task', taskId, kbId: run.kbId, sourceId, pageId: permit.pageId, active: true, canCancel: false });
    let output: unknown;
    try {
      output = await this.options.runServiceTask({ id: taskId, kind: 'wiki_page_generate', input: {
        kbId: run.kbId, sourceId, sourceRevision: source.revision,
        expectedModel: run.model,
        sourcePath: source.name, source: sources.readSnapshot(run.kbId, { sourceId, revision: source.revision }),
      }, capabilities: ['llm_completion'] });
    } finally { libraries.settleTask('service_task', taskId); }
    if (this.cancelRequested(jobId)) break;
    if (typeof output !== 'string' || !output.trim()) throw new Error('EMPTY_GENERATED_PAGE');
    const result = pages.publishGenerated(permit, source.name.replace(/\.(md|txt)$/i, ''), output.trim());
    if (result.state === 'skipped') { summary.skipped++; this.recordSkip(jobId, sourceId, result.reason); }
    else { summary.succeeded++; sources.markResult(run.kbId, sourceId, source.revision, { status: 'succeeded' }); }
  } catch (error) {
    summary.failed++;
    sources.markResult(run.kbId, sourceId, source.revision, { status: 'failed', error: String(error) });
  }
  this.saveSummary(jobId, summary); // 实际计数/阶段，不能把模型等待伪装为百分比。
}
```

`run` 是按 jobId 读取并解析的 `WikiIngestRun`；`cancelRequested`、`recordSkip`、`saveSummary` 为服务私有 SQL 方法，读取/更新刚定义的 `wiki_ingest_runs`；`recordSkip` 同时记录 `agent_audit` 的脱敏资源摘要，并当场saveSummary，使continue分支计数也持久化。结束/finally必须把用户target active=false，取消时复原未完成资料为pending，按执行器确认才jobs.cancel；实际failed>0则job failed并保留成功产物，只有跳过则仍completed。资料在运行期间被更新时markResult使用WHERE revision=? AND content_hash=?，不能把旧成功标记在新版上。

Runtime 的 `runServiceTask` 仍进现有 `TaskQueue` 的 `system:true` lane，最终还是 `SystemWorkerManager.run`；保留 `wiki_page_generate` Markdown 协议。新的 service task input 带库/资料/版本用于审计，但 worker不直接发布。`admin.jobs.cancel` 对 `wiki.ingest` 调 `requestCancel`，对系统任务不提供运行中取消。旧 `WikiSyncService` 的 `writePage` 接受 `WikiPublishResult`，`locked/changed/multi_source` 记跳过继续；旧 `wiki.replace` 同样经保护，不走旁路。

两个旧自动writer必须在生成前取得版本，不在生成后现读版本冒充基线：WikiSyncServiceOptions增加 `readPage:(workspace:string,page:string)=>Promise<{revision:number;contentHash:string}|undefined>`，WikiSyncPageInput增加 `expected:WikiVersion|null`；main以requestAdmin('wiki.read',...)接线。extensions/wiki-rag/sync.ts在update()中先调用旧wiki.read，记录expected后再调用其现有LLM，最后wiki.replace带expected：

```ts
async update(ctx: WikiContext, input: WikiUpdateInput): Promise<boolean> {
  if (ctx.signal?.aborted) return false;
  const ask = this.askFactory(ctx); if (!ask) return false;
  const current = await this.client.request<{ revision: number; contentHash: string } | undefined>('wiki.read', { workspace: ctx.cwd, page: input.page });
  const expected = current ? { revision: current.revision, contentHash: current.contentHash } : null;
  let content: string;
  try { content = (await ask(SYSTEM, input.source)).trim(); } catch { return false; }
  if (!content || ctx.signal?.aborted) return false;
  const result = await this.client.request<{ state: 'published' | 'skipped'; reason?: string }>('wiki.replace', {
    workspace: ctx.cwd, page: input.page, title: titleFromPage(input.page), content,
    sourcePath: input.sourcePath, sourceContent: input.source, expected,
  });
  return result.state === 'published';
}
```

该方法直接替换现有sync.update；WikiContext/WikiUpdateInput/SYSTEM/titleFromPage均是该文件已有定义，不新增第二次生成。旧RPC可选新增expected：expected:null只允许发布时仍不存在；已存在而旧客户端未携expected返回skipped/changed和重读提示，不覆盖；CAS失败不自动重试覆盖。extension sync.update遇skipped返回false，index.ts显示未更新，不再无条件true；旧WikiSyncService按页统计skipped继续。对应红测用deferred生成期间修改外部文件/人工保存，断言writePage参数是生成前版本、返回false/跳过，文件不变；未存在页在生成期间被另一writer创建时同样跳过。

- [ ] **步骤 4：运行绿测。** `npm exec -- vitest run electron/app/wikiLibraryService.test.ts electron/app/wikiSyncService.test.ts electron/app/appServer/taskQueue.test.ts electron/pi/systemWorkerManager.test.ts electron/agentData/runtime.wiki.test.ts`。
- [ ] **步骤 5：验收。** create/add/update/reindex 不调模型，只有明确 ingest 才调用；不重复抽取成功未变资料；锁页跳过继续；取消保持 running→确认后 cancelled；用户任务和子系统任务均留关联、计数、审计，未知模型阶段无假百分比。

### 任务 7：库/资料/页面生命周期删除门与防复活

**文件：** 修改 `electron-agent/electron/agentData/{wikiLibraryStore,wikiSourceStore,wikiStore,wikiFiles}.ts`、`electron-agent/electron/app/wikiLibraryService.ts`、`electron-agent/electron/agentData/runtime.ts`；新建 `electron-agent/electron/agentData/wikiLifecycle.test.ts`。

- [ ] **步骤 1：写运行结果与删除竞争红测。** 所有实体通过真实 fixture 创建，模型等待通过 Promise 控制：

```ts
it('gates deletion before waiting and rejects both new jobs and an old result', async () => {
  const f = workbenchFixture(); let release!: (value: string) => void;
  try {
    const kb = f.libraries.create({ name: '删除目标', description: '', bindings: [] });
    const source = f.sources.createText(kb.kbId, { kind: 'manual', name: 'a.md', content: 'A' });
    f.generate.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const receipt = await f.service.startIngest(kb.kbId); const running = f.service.runIngest(receipt.jobId);
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
    const target = { kind: 'library' as const, kbId: kb.kbId };
    expect(await f.service.remove(target, true)).toMatchObject({ state: 'waiting' });
    await expect(f.service.startIngest(kb.kbId)).rejects.toThrow('RESOURCE_DELETING');
    release('# late output'); await running;
    expect(await f.service.remove(target, true)).toEqual({ state: 'deleted' });
    expect(f.pages.readById(kb.kbId, source.generatedPageId)).toBeUndefined();
    expect(f.jobs.get(receipt.jobId)).toBeDefined(); expect(f.jobs.audit().length).toBeGreaterThan(0);
    f.libraries.registerLegacyBuckets();
    expect(f.libraries.get(kb.kbId)?.lifecycle).toBe('deleted');
  } finally { f.dispose(); }
});
```

再测试页面删除：生成页后删除它，`sources.pending` 与普通 ingest 均不会恢复；更新原文也不恢复；仅 `startIngest(kbId,undefined,[sourceId])` 的显式重新生成才恢复。资料删除测试保留引用页面、旧 snapshot，返回来源已删除；项目导入的原文件存在且字节未变。系统 task `canCancel:false` 的 remove 返回 waiting，不能伪装已取消。

- [ ] **步骤 2：运行红测。** `npm exec -- vitest run electron/agentData/wikiLifecycle.test.ts`；预期生命周期门缺失或晚结果使页面重现。
- [ ] **步骤 3：实现持久化状态机。** 页面也建立 `wiki_page_state(kb_id,page_id,lifecycle,epoch,PRIMARY KEY(kb_id,page_id))`，不能仅靠文件存在判断已删除。beginDelete 和 enqueue/acquirePermit 使用同一数据库同步事务。以下为删除服务完整决策算法，数据库与文件操作都按稳定 target ID：

```ts
async remove(target: WikiTarget, cancelActive: boolean): Promise<WikiDeleteResult> {
  this.options.libraries.beginDelete(target); // active->deleting, epoch++，重复调用不重复加。
  let tasks = this.options.libraries.activeTasks(target);
  if (cancelActive) {
    for (const task of tasks) if (task.canCancel && task.taskSource === 'agent_job') this.requestCancel(task.taskId);
    tasks = this.options.libraries.activeTasks(target);
  }
  if (tasks.length) return { state: 'waiting', tasks };
  // finishDelete 再在事务内查 active target，任何任务仍活跃即拒绝。
  this.options.libraries.finishDelete(target);
  return { state: 'deleted' };
}
```

`permitActive` 必须同时满足库 active+epoch、source active+epoch+revision、page state active+epoch；库/源/页任何删除都撤销旧 permit，后台输出仍可写任务历史但不得发布。beginDelete 之后人工保存、资料导入和 reindex 发布同样拒绝。恢复启动时，对 deleting 资源重新查实际 `agent_jobs` / `service_tasks` 状态，不从内存 Set 猜测；活动任务自然结束后可再次 finalize。队列超时后 worker 的迟到结果只能结束审计，不能绕过 permit。

`finishDelete(source)` soft-delete source，保留被引用 revision 与页面；`finishDelete(page)` 把 `autoSourceId` 对应 source `generationSuppressed=true`，写 page tombstone，删除具体 page 文件和索引；多来源人工页面也保留 page tombstone，不自动映射成每源页。`finishDelete(library)` 只对 `files.bucketDir(library)` 已验证的 `wiki/`、`raw/` 执行移除，删活动索引/关联，保留库 tombstone、原 workspace.json、legacy-backup、legacy SQL、审计和任务目标历史。物理移除失败保持 deleting 及错误，可重试，不先宣告 deleted；文件操作逐个显式 target，绝不以 projectWorkspace 或 UI 路径作为删除根。

该任务用数据库故障注入/文件 remove 失败再试验证：状态不错误前进、外部链接拒绝、重试不误删另一库。任务目标 active=false 必须依赖执行器 finally，不依赖 UI 取消点击或用户任务表面状态。

- [ ] **步骤 4：运行绿测。** `npm exec -- vitest run electron/agentData/wikiLifecycle.test.ts electron/agentData/wikiPages.test.ts electron/app/wikiLibraryService.test.ts electron/agentData/jobCleanup.test.ts`。
- [ ] **步骤 5：验收。** 三种删除有不同影响；服务端先上删除门再等待；不会检查后重新入队；项目文件、legacy、审计和任务历史保留；页删除有持久抑制，重启不复活。

### 任务 8：明确的 Wiki 管理 IPC 与类型化前端 API

**文件：** 修改 `electron-agent/electron/ipc/{contracts,register,register.test,commandCoverage.test}.ts`、`electron-agent/src/lib/{agentData,agentData.test}.ts`、`electron-agent/electron/agentData/runtime.ts`、`extensions/wiki-rag/{index,index.test}.ts`；不修改 preload 通用 `invoke` 能力。

- [ ] **步骤 1：写参数与管理上下文红测。** 在既有 `register.test.ts` 复用已定义的 `handler(IPC_CHANNELS.invoke)`：

```ts
it('uses an in-process admin Wiki entry and never trusts a caller-selected method', async () => {
  const agentData = { requestAdmin: vi.fn().mockResolvedValue({ kbId: 'k' }), request: vi.fn() };
  registerIpcHandlers({ agentData: agentData as never }); const invoke = handler(IPC_CHANNELS.invoke);
  await invoke({}, { command: 'agentData_wiki_libraries_create', args: { name: '手册', description: '', bindings: [], admin: false, method: 'wiki.deleteWorkspace' } });
  expect(agentData.requestAdmin).toHaveBeenCalledWith('wiki.libraries.create', { name: '手册', description: '', bindings: [] });
  expect(agentData.request).not.toHaveBeenCalled();
  await expect(invoke({}, { command: 'agentData_wiki_pages_update', args: { kbId: 'k', pageId: 'p', title: 'x', content: '', sourceRefs: [] } })).rejects.toThrow(/expected/i);
});
```

`agentData.test.ts` 增加：`pages.update('k','p',{title:'x',content:'',sourceRefs:[],expected:{revision:2,contentHash:'h'}})` 准确转成 `agentData_wiki_pages_update` 参数；`sources.create` 保留 `kind:'upload'`，不把它混同 project import；`libraries.remove` 只传稳定 kbId/cancelActive，不传当前选中行名称作为 target。

扩展 `extensions/wiki-rag/index.test.ts` 在已有 `tools()` / `context()` 夹具上加入真实新协议红测（这两个函数已存在于该文件）：

```ts
it('reads a page using the exact kbId and pageId returned by project search', async () => {
  const hit = { kbId: 'bound-kb', pageId: 'p-1', title: '指南', snippet: 'text' };
  const request = vi.spyOn(WikiClient.prototype, 'request')
    .mockResolvedValueOnce([hit]).mockResolvedValueOnce({ ...hit, content: '# 知识页' });
  const { ctx, complete } = context('/repo'); const registered = tools();
  const search = await registered.wiki_search.execute('search', { query: '指南' }, undefined, undefined, ctx);
  expect(search.details).toEqual([hit]);
  const read = await registered.wiki_read.execute('read', { kbId: hit.kbId, pageId: hit.pageId }, undefined, undefined, ctx);
  expect(read.content).toEqual([{ type: 'text', text: '# 知识页' }]);
  expect(request).toHaveBeenNthCalledWith(1, 'wiki.pages.search', { workspace: '/repo', query: '指南', limit: 20 });
  expect(request).toHaveBeenNthCalledWith(2, 'wiki.pages.read', { workspace: '/repo', kbId: 'bound-kb', pageId: 'p-1' });
  expect(complete).not.toHaveBeenCalled();
});
```

再写 `wiki_list` 无kbId只请求 `wiki.libraries.list` 并返回空数组的例子，断言没有进一步 `wiki.list` 或省略scope的全局请求；runtime集成例子将两个新建库关联同一token项目，确认新搜索跨这两个显式关联库，解绑一个后只剩另一个。

- [ ] **步骤 2：运行红测。** `npm exec -- vitest run electron/ipc/register.test.ts src/lib/agentData.test.ts`；预期明确命令缺失。扩展测试先 `Set-Location -LiteralPath 'D:/OneDrive/Project Files/Pi/extensions'`，再 `& '../electron-agent/node_modules/.bin/vitest.cmd' run wiki-rag/index.test.ts`，预期仍发旧workspace读取RPC；返回electron-agent目录继续该任务。
- [ ] **步骤 3：按 §1.1 逐项注册。** 每项明确命令名，独立读取字段，不加入 `agentData_wiki_invoke(method,args)`。数组/版本/引用使用本文件局部 reader，具体例子：

```ts
function readVersion(args: Record<string, unknown>): WikiVersion {
  const expected = readRecord(args, 'expected');
  if (!Number.isInteger(expected.revision) || Number(expected.revision) < 0 || typeof expected.contentHash !== 'string' || !expected.contentHash) throw new Error('expected version is required');
  return { revision: Number(expected.revision), contentHash: expected.contentHash };
}
registerCommand('agentData_wiki_pages_update', (_event, args) => services.agentData!.requestAdmin('wiki.pages.update', {
  kbId: readString(args, 'kbId'), pageId: readString(args, 'pageId'), title: readString(args, 'title'),
  content: readText(args, 'content'), sourceRefs: readSourceRefs(args), expected: readVersion(args),
}));
// src/lib/agentData.ts 中 pages 的一项，其余依 §1.1 精确对应，不扩充新的通用网关。
update: (kbId: string, pageId: string, input: WikiPageSave) => invoke<WikiPage>('agentData_wiki_pages_update', { kbId, pageId, ...input }),
```

`readSourceRefs` 读取数组，逐项验证 string sourceId、整数 revision>=1，不合格抛 `invalid sourceRefs`；重复 `{sourceId,revision}` 去重，同 source 多 revision 允许人工引用但自动写判为 multi_source。页列表不传正文；库列表按 query/name/description、project binding 过滤；管理旧 Wiki overview/search 的 IPC 改为固定 requestAdmin，不再用 socket 省略 workspace 扩大全局。`open storage/page location` 先由管理 read 返回的安全 path 调用已有平台 `openPath/revealItemInDir`，无需新任意路径删除接口。

扩展只改三个读取工具：`wiki_search` 增可选kbId，转 `wiki.pages.search`；`wiki_read` 参数变为必须kbId/pageId，来自刚返回的真实检索/列表结果，转 `wiki.pages.read`；`wiki_list` 无kbId返回当前项目库列表，有kbId返回该库页列表。所有请求仍发送ctx.cwd供服务器与token校验，不由客户端省略workspace获取全库：

```ts
// wiki_list execute；参数为 Type.Object({ kbId:Type.Optional(Type.String({minLength:1})), limit:Type.Optional(Type.Number({minimum:1,maximum:100})) })。
const result = params.kbId
  ? await client.request('wiki.pages.list', { workspace: ctx.cwd, kbId: params.kbId, limit: params.limit ?? 50 })
  : await client.request('wiki.libraries.list', { workspace: ctx.cwd });
return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
```

`wiki_read` description明确先用wiki_list/wiki_search取得kbId/pageId，不猜库；不存在或未关联均不回落到旧workspace读取。保留 `wiki_update` / `wiki_reindex` 原参数和权限检查，但描述明确“仅旧workspace原映射库”；新建具名库本阶段只提供Agent关联读取，写入由管理页显式抽取/人工保存，**不声称已支持Agent向任意新库写入**。原 `wiki.read/list/search/replace/reindex` runtime仍兼容旧客户端，不扩大到所有新关联库。

- [ ] **步骤 4：运行绿测。** `npm exec -- vitest run electron/ipc/register.test.ts electron/ipc/commandCoverage.test.ts src/lib/agentData.test.ts electron/agentData/runtime.wiki.test.ts`；extensions目录再运行上一条扩展命令，PASS。
- [ ] **步骤 5：验收。** 前端每项 CRUD 都有明确 DTO 和命令；renderer 输入无法更换 runtime 方法或上下文；空 Markdown 可以保存；缺版本/跨库引用服务端拒绝；旧 Agent RPC 不因管理接入扩大 scope。

### 任务 9：默认库列表、创建/重命名/多项目关联

**文件：** 创建 `electron-agent/src/features/agentData/wiki/{WikiLibraryList,WikiLibraryDialog}.tsx`、对应 `.test.tsx`、`wikiStyles.ts`、`wikiTestData.ts`；修改 `electron-agent/src/features/agentData/{WikiPanel,WikiPanel.test}.tsx`。

- [ ] **步骤 1：用真实入口与明确 API mock 写红测。** 三个UI任务的每个测试文件顶端使用 `// @vitest-environment jsdom`，导入 `@testing-library/jest-dom/vitest`、`{cleanup,fireEvent,render,screen,waitFor}` from `@testing-library/react`、`{afterEach,expect,it,vi}` from `vitest`，本地组件和 `agentDataApi` from `../../../lib/agentData`；`afterEach(()=>{cleanup();vi.restoreAllMocks()})`。先建立可复用完整测试DTO：

```ts
// wikiTestData.ts；只允许测试文件导入。
import type { WikiLibraryView, WikiPage, WikiSource } from '../../../../electron/agentData/wikiContracts';
export const library: WikiLibraryView = { kbId:'k',storageKey:'kb-11111111-1111-4111-8111-111111111111',name:'产品',description:'团队说明',bindings:['D:/a','D:/b'],revision:1,lifecycle:'active',epoch:1,createdAt:1,updatedAt:1,location:'D:/app/wiki/kb-11111111-1111-4111-8111-111111111111',sourceCount:2,pageCount:3,pendingSourceCount:1,availability:'available' };
export const source: WikiSource = { kbId:'k',sourceId:'s',name:'a.md',kind:'manual',snapshotPath:'raw/sources/s/1-h.md',revision:1,contentHash:'h',lifecycle:'active',epoch:1,status:'pending',generatedPageId:'p',generationSuppressed:false,createdAt:1,updatedAt:1 };
export const page: WikiPage = { kbId:'k',pageId:'p',title:'说明',content:'# 原文',path:'D:/app/wiki/kb-11111111-1111-4111-8111-111111111111/wiki/p.md',sourceRefs:[],locked:true,revision:1,contentHash:'h',lifecycle:'active',epoch:1,updatedAt:1 };
```

`WikiLibraryList.test.tsx` 导入 `{library}` from `./wikiTestData`，mock `useProjectOptions` 为 `[{cwd:'D:/a',name:'A'},{cwd:'D:/b',name:'B'}]`：

```ts
it('browses libraries without a search and retains content on refresh failure', async () => {
  vi.spyOn(agentDataApi.wiki.libraries, 'list').mockResolvedValueOnce([library]).mockRejectedValueOnce(new Error('连接已断开'));
  const onOpen = vi.fn(); render(<WikiLibraryList visible onOpen={onOpen} refreshVersion={0} />);
  expect(await screen.findByText('产品')).toBeTruthy(); expect(screen.getByText('团队说明')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '刷新知识库' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('连接已断开');
  expect(screen.getByText('产品')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '打开知识库 产品' })); expect(onOpen).toHaveBeenCalledWith('k');
});
```

`WikiLibraryDialog.test.tsx` 用 `render(<WikiLibraryDialog open onClose={vi.fn()} onSaved={vi.fn()} />)`：80 字合法、81 字阻止、去空白必填、description 501 阻止；默认 bindings=[]；选 A/B 只发送一个 create 且无 jobs.create；编辑时传原 expectedRevision，名称相同允许创建。每个测试 `afterEach(cleanup);vi.restoreAllMocks()`。

- [ ] **步骤 2：运行红测。** `npm exec -- vitest run src/features/agentData/wiki/WikiLibraryList.test.tsx src/features/agentData/wiki/WikiLibraryDialog.test.tsx`。
- [ ] **步骤 3：实现列表与表单，不复制服务端状态机。** LibraryList props 为 `{visible:boolean;onOpen:(kbId:string)=>void;refreshVersion:number}`；内部保留query、project、order、rows、error，300ms防抖和请求序号丢弃旧响应，刷新失败不清空rows。visible=false时不发起初载/刷新/关键词请求；重新visible一次刷新。availability分别“草稿/待抽取/可用”，pendingSourceCount与activeJobId为附加状态，不把抽取中已有库变不可读。

```tsx
const requestVersion = useRef(0);
const load = useCallback(async () => {
  if (!visible) return;
  const version = ++requestVersion.current; setRefreshing(true);
  try {
    const next = await agentDataApi.wiki.libraries.list({ query: query.trim(), ...(project ? { project } : {}) });
    if (version === requestVersion.current) { setRows(next); setError(undefined); setLoaded(true); }
  } catch (error) { if (version === requestVersion.current) setError(String(error)); }
  finally { if (version === requestVersion.current) setRefreshing(false); }
}, [query, project, visible]);
```

库对话框 props 为 `{open:boolean;library?:WikiLibraryView;onClose:()=>void;onSaved:(library:WikiLibraryView)=>void}`，AntD Modal 宽520、Form 名称/用途/真实项目多选，保存按钮 36px。新建只调用 create，成功导航新 kbId；重命名/关联只 update，不扫描、不抽取、不搬目录。删除确认单独取 preview 并保存 stable target；刷新/重命名后确认仍指向原 kbId；展示资料/页数/项目和库名确认。

WikiPanel从一期接收visible，保存selectedKbId与showWorkspace。LibraryList实例始终挂载，只通过hidden隐藏，因此列表内部的query/project/order/scrollTop不会因进入库卸载丢失：

```tsx
<div hidden={!visible || showWorkspace}>
  <WikiLibraryList visible={visible && !showWorkspace} onOpen={(kbId) => { setSelectedKbId(kbId); setShowWorkspace(true); }} refreshVersion={refreshVersion} />
</div>
{selectedKbId ? <div hidden={!visible || !showWorkspace}>
  <WikiLibraryWorkspace key={selectedKbId} visible={visible && showWorkspace} kbId={selectedKbId} onBack={() => setShowWorkspace(false)} onViewTask={onViewTask} />
</div> : null}
```

不读取当前聊天workspace强行切换；返回列表也不卸载最后库的草稿。列表初始为空给“新建知识库”；筛选无结果显示“没有匹配知识库”；请求失败独立Alert。整行支持打开，按钮有可访问名称，菜单和行点击不冒泡双触发。RTL补测试：输入query→进入库→返回后query仍在；visible=false时rerender refreshVersion不增加list调用，visible=true只刷新一次。

- [ ] **步骤 4：运行绿测。** 同一测试命令，再跑 `npm exec -- vitest run src/features/agentData/WikiPanel.test.tsx src/features/agentData/AgentDataCenter.test.tsx`，不新增平行外壳。
- [ ] **步骤 5：验收。** 默认能看列表；库名/用途优先于 ID/路径；多绑定只一份正文；创建不触发任务；后台失败保留内容；切聊天项目/标签不重置当前库。

### 任务 10：资料工作区、三入口与原页任务跟踪

**文件：** 创建 `electron-agent/src/features/agentData/wiki/{WikiLibraryWorkspace,WikiSourceDialog}.tsx`、对应 `.test.tsx`；修改 `WikiPanel.tsx`、`wikiStyles.ts`。

- [ ] **步骤 1：写资料多项结果与任务跟踪红测。** `WikiSourceDialog` props 定为 `{open:boolean;kbId:string;bindings:string[];source?:WikiSource;onClose:()=>void;onSaved:()=>void}`，source 存在表示用户明确“更新这份资料”。mock sources.create 第一项成功、第二项拒绝；`File(['# A'],'a.md',{type:'text/markdown'})` 与 `File(['bad'],'b.pdf',{type:'application/pdf'})` 输入后，断言 a 成功、b 不支持且 a 不回滚，没有自动调用 ingest。

```tsx
import { library, source } from './wikiTestData';
import { useAgentDataTaskMonitor } from '../useAgentDataTaskMonitor';
vi.mock('../useAgentDataTaskMonitor', () => ({ useAgentDataTaskMonitor: vi.fn() }));
it('keeps the library open and watches the returned user job', async () => {
  const track = vi.fn();
  vi.mocked(useAgentDataTaskMonitor).mockReturnValue({ jobs: [], refresh: vi.fn(), track, watchedTaskVersion: 0 });
  vi.spyOn(agentDataApi.wiki.libraries, 'read').mockResolvedValue({ ...library, sourceCount: 1, pageCount: 0, availability: 'pending' });
  vi.spyOn(agentDataApi.wiki.sources, 'list').mockResolvedValue([source]);
  vi.spyOn(agentDataApi.wiki.pages, 'list').mockResolvedValue([]);
  vi.spyOn(agentDataApi.wiki.libraries, 'previewIngest').mockResolvedValue({ sourceIds: ['s'], targetCount: 1, model: 'fixture-model' });
  vi.spyOn(agentDataApi.wiki.libraries, 'ingest').mockResolvedValue({ jobId: 'j-1', targetCount: 1, model: 'fixture-model' });
  render(<WikiLibraryWorkspace visible kbId="k" onBack={vi.fn()} onViewTask={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '开始抽取' }));
  expect(await screen.findByText('会调用模型')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '确认抽取 1 份资料' }));
  await waitFor(() => expect(track).toHaveBeenCalledWith('j-1'));
  expect(screen.getByText('已加入任务')).toBeTruthy(); expect(screen.getByTestId('wiki-library-workspace')).toBeTruthy();
});
```

该测试导入真实一期hook并仅替换测试依赖，项目不得新增另一个轮询hook。模型/数量使用previewIngest真实返回，不从UI猜测模型。为系统任务canCancel=false的waiting删除结果加入UI测试，确认只能“等待任务结束”，没有“已取消”成功提示。

- [ ] **步骤 2：运行红测。** `npm exec -- vitest run src/features/agentData/wiki/WikiLibraryWorkspace.test.tsx src/features/agentData/wiki/WikiSourceDialog.test.tsx`。
- [ ] **步骤 3：实现库内两种列表与导入流程。** Workspace props为 `{visible:boolean;kbId:string;onBack:()=>void;onViewTask:(id:string)=>void}`，局部状态保存tab、selectedSourceId/selectedPageId、两种query、scrollTop；主工作区使用container-type:inline-size按实际可用宽度布局。每次kbId改变增request sequence，丢弃旧库在途响应；普通刷新保留列表与选中项。visible=false时不新发资源请求，重新visible刷新一次。只对实际移除的选中资源清理详情。

```tsx
const monitor = useAgentDataTaskMonitor();
useEffect(() => { if (visible) void reloadLibrary(); }, [visible, kbId, monitor.watchedTaskVersion]);
async function confirmIngest() {
  if (!ingestPreview) return;
  const trackCreated = monitor.track;
  const receipt = await agentDataApi.wiki.libraries.ingest(kbId, ingestPreview.sourceIds, undefined, ingestPreview.model);
  trackCreated(receipt.jobId); setActiveJobId(receipt.jobId); setNotice('已加入任务');
}
```

`ingestPreview`是useState<WikiIngestPreview>()，点击开始抽取先请求previewIngest并打开确认，确认数量/模型后调用上段。reloadLibrary在开头再次guard visible，然后执行Promise.allSettled([libraries.read(kbId),sources.list(kbId),pages.list(kbId)])，分别更新成功域、保留失败域旧值并显示域错误；不以任一失败卸载整库。任务按钮只onViewTask(activeJobId)，不跳转无选中任务列表。取消过程从monitor的真实任务能力/状态渲染，执行器未终止显示“正在取消”。RTL用deferred ingest承诺：点击确认→切换activeView使hook返回另一个track→resolve后只调用点击时track；另测隐藏workspace时watchedTaskVersion变化不读取，重新可见才读取。

上传用 `<input type="file" multiple accept=".md,.txt">`，逐文件 `await file.text()` 后单独调用 sources.create，保存每项 `{name,state,error?}`；扩展名不合格项就地失败，其余继续。手动录入文件名/Markdown/预览，默认新 source；source prop 存在才显示“更新这份资料”且传 expected。项目导入只能从 bindings 选，先调用 previewImport 展示规范化项目名+相对路径+大小，再确认用 expectedContentHash 创建；bindings 不等于自动导入。保存后显示“资料已添加”，抽取/稍后由用户选择。

- [ ] **步骤 4：运行绿测。** 同一命令，再跑一期 task monitor 测试，确认同一2秒状态源、终态资源更新，无重复轮询。
- [ ] **步骤 5：验收。** 空库可添加资料/新页、无资料不可执行抽取；同名来源显示项目；逐项失败可见；创建任务留原页；选中/滚动不被刷新或切聊天项目抹掉。

### 任务 11：页面编辑、冲突保稿、锁定与响应式详情

**文件：** 创建 `electron-agent/src/features/agentData/wiki/WikiPageEditor.tsx`、`WikiPageEditor.test.tsx`；修改 `WikiLibraryWorkspace.tsx`、`wikiStyles.ts`。

- [ ] **步骤 1：写冲突与只读红测。** editor props 为 `{kbId:string;page?:WikiPage;readOnly:boolean;onSaved:(page:WikiPage)=>void;onClose:()=>void}`，新建 page 未提供。测试文件导入 `{page}` from `./wikiTestData`：

```tsx
it('keeps the draft on a version conflict and does not discard it on Escape', async () => {
  vi.spyOn(agentDataApi.wiki.pages, 'update').mockRejectedValue(new Error('VERSION_CONFLICT'));
  const onClose = vi.fn(); render(<WikiPageEditor kbId="k" page={page} readOnly={false} onSaved={vi.fn()} onClose={onClose} />);
  const editor = screen.getByRole('textbox', { name: 'Markdown 正文' });
  fireEvent.change(editor, { target: { value: '# 我的草稿' } });
  fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
  expect(await screen.findByRole('alert')).toHaveTextContent('页面已在其它位置修改');
  expect(editor).toHaveValue('# 我的草稿');
  expect(agentDataApi.wiki.pages.update).toHaveBeenCalledWith('k', 'p', expect.objectContaining({ expected: { revision: 1, contentHash: 'h' } }));
  fireEvent.keyDown(editor, { key: 'Escape' }); expect(onClose).not.toHaveBeenCalled();
  expect(await screen.findByText('放弃未保存修改？')).toBeTruthy();
});
```

另测 readOnly=true 无保存/删除/解锁可执行按钮；无 sourceRefs 显示“人工创建”和“先关联原始资料”，自动更新不可执行；source lifecycle=deleted 标“来源已删除”且旧快照可看；更新成功显示锁定说明；重新载入原版本也先确认是否丢弃草稿。

- [ ] **步骤 2：运行红测。** `npm exec -- vitest run src/features/agentData/wiki/WikiPageEditor.test.tsx`。
- [ ] **步骤 3：实现最小编辑器和焦点规则。** 沿用AntD Input.TextArea与 `electron-agent/src/features/chat/LazyMarkdown.tsx`（在wiki目录中import `../../chat/LazyMarkdown`）渲染预览，不另装编辑器；该现有组件会剥离内联图片，界面不宣称本阶段支持上传图片预览。用户草稿state与服务器page分开；同page的后台refresh不覆盖dirty state，只有显式重新载入确认才替换。以下保存算法为核心：

```tsx
async function save() {
  if (readOnly || saving) return;
  setSaving(true);
  try {
    const input = { title: draftTitle.trim(), content: draftContent, sourceRefs: draftRefs };
    const saved = base
      ? await agentDataApi.wiki.pages.update(kbId, base.pageId, { ...input, expected: { revision: base.revision, contentHash: base.contentHash } })
      : await agentDataApi.wiki.pages.create(kbId, input);
    setBase(saved); setDirty(false); setError(undefined); onSaved(saved);
  } catch (error) {
    setError(String(error).includes('VERSION_CONFLICT') ? '页面已在其它位置修改；草稿已保留，请重新载入原版本后比较。' : String(error));
  } finally { setSaving(false); }
}
```

`base` 从传入 page 初始化，新页只在成功创建后设置；`draftTitle/draftContent/draftRefs` 初始化自 page 或空值。Ctrl+S/Meta+S `preventDefault` 后调用 save，Escape 仅调用 `requestClose()`；后者 dirty 则确认，否则 onClose。解除锁定按钮调用独立 `pages.setLocked`，明确确认“允许后续抽取更新”，失败保留当前编辑；多来源说明不会参加单源增量覆盖。

用 CSS container queries：>=1160px `grid-template-columns:240px minmax(560px,1fr) 264px`；800–1159px `224px minmax(0,1fr)`，属性 Drawer；<800px 只显示列表或详情一级，返回保留滚动，正文 `max-width:760px;line-height:1.65;overflow-wrap:anywhere`。详情关闭把焦点返回触发按钮；属性/菜单图标有 aria-label；浅深色用已有语义 token，不固定白背景或浅灰正文。外部未声明 locked 页面明确“未声明人工锁定”，不替用户锁页。

- [ ] **步骤 4：运行绿测。** `npm exec -- vitest run src/features/agentData/wiki/WikiPageEditor.test.tsx src/features/agentData/wiki/WikiLibraryWorkspace.test.tsx`。
- [ ] **步骤 5：验收。** 保存默认锁定；版本冲突不丢稿；0..N 来源可真实呈现；只读无写入口；1200×800/1440×900/窄内容区和键盘返回焦点全部可操作。

### 任务 12：无模型索引重建、诊断与全链路验收

**文件：** 修改 `electron-agent/electron/agentData/{wikiFiles,wikiStore,wikiLibraryStore}.ts`、`electron-agent/electron/app/wikiLibraryService.ts`、`electron-agent/src/features/agentData/wiki/WikiLibraryWorkspace.tsx`；新建 `electron-agent/electron/agentData/wikiWorkbench.integration.test.ts`；扩展 `WikiLibraryWorkspace.test.tsx`、`wikiPages.test.ts`。

- [ ] **步骤 1：写索引故障红测。** 使用完整 workbenchFixture，只创建临时根：

```ts
it('reindexes Markdown without an LLM and preserves a failed bucket index for recovery', () => {
  const f = workbenchFixture();
  try {
    const kb = f.libraries.create({ name: '诊断', description: '', bindings: [] });
    const page = f.pages.createManual(kb.kbId, { title: '旧标题', content: '# searchable', sourceRefs: [] });
    writeFileSync(page.path, '---\nlocked: [broken\n---\n\n# damaged');
    const result = f.service.reindex(kb.kbId);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'PAGE_PARSE_FAILED', path: page.path, kbId: kb.kbId })]);
    expect(f.db.prepare('SELECT title FROM wiki_documents WHERE kb_id=? AND page=?').get(kb.kbId, page.pageId)).toMatchObject({ title: '旧标题' });
    expect(f.generate).not.toHaveBeenCalled();
    expect(readFileSync(page.path, 'utf8')).toContain('# damaged');
  } finally { f.dispose(); }
});
```

集成测试在同一 fixture 测完整序列：创建共享库→从A/B各导入README→显式抽取→人工保存→更新资料→锁页跳过→解绑A后项目 token 的新旧RPC拒绝→删来源保快照→删页抑制→删库保历史。每步断言 UUID、来源revision、正文数量和模型调用次数，不把最后一个成功响应当整链成功。

- [ ] **步骤 2：运行红测。** `npm exec -- vitest run electron/agentData/wikiWorkbench.integration.test.ts`；预期旧 reindex 不认识库或错误清空失败桶索引。
- [ ] **步骤 3：按成功桶替换索引。** 复用任务5已完成的kb_id索引结构和回退表，不再次迁移表。`WikiFiles.scanBucket(library)`在任务5已有基础扫描，本任务补完整诊断聚合和失败桶保留行为。

```ts
const scan = files.scanBucket(library); // { pages: WikiPage[], diagnostics: WikiDiagnostic[] }
if (scan.diagnostics.length) return { pages: 0, diagnostics: scan.diagnostics };
db.exec('BEGIN IMMEDIATE');
try {
  libraries.assertActive(kbId); // active检查与lifecycle门同一事务。
  db.prepare('DELETE FROM wiki_documents WHERE kb_id=?').run(kbId);
  db.prepare('DELETE FROM wiki_fts WHERE kb_id=?').run(kbId);
  for (const page of scan.pages) if (!libraries.pageDeleted(kbId, page.pageId)) this.indexPage(page);
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); throw error; }
return { pages: scan.pages.length, diagnostics: [] };
```

`assertActive` / `pageDeleted` 是任务5/7已经定义的守卫，分别检查库lifecycle和wiki_page_state tombstone。扫描禁止符号链接、重复pageId、错误kbId、错误locked/frontmatter；诊断具体path/code/message，失败桶索引保留且UI显示“索引保留，正文读取异常”，不能以旧索引谎报文件可读。其它正常库独立重建。reindex不改Markdown、不清锁、不调用任务队列或LLM；抑制页即使外部旧副本出现也不自动恢复，给PAGE_DELETED诊断。

工作区“更多→重建索引”先显示“不调用模型，不改正文”；结果显示真实扫描页数与问题文件，打开位置使用已校验 path。读取失败保留已有正文并加错误条，不能切成真实空库。按钮受 lifecycle 和只读状态禁用。

- [ ] **步骤 4：运行绿测与编译。**

```powershell
Set-Location -LiteralPath 'D:/OneDrive/Project Files/Pi/electron-agent'
npm exec -- vitest run electron/agentData/wikiLibraryStore.test.ts electron/agentData/wikiSourceStore.test.ts electron/agentData/wikiPages.test.ts electron/agentData/wikiLifecycle.test.ts electron/agentData/wikiWorkbench.integration.test.ts electron/agentData/runtime.wiki.test.ts electron/app/wikiLibraryService.test.ts electron/app/wikiSyncService.test.ts electron/ipc/register.test.ts src/lib/agentData.test.ts src/features/agentData/wiki
npm exec -- tsc --noEmit -p tsconfig.node.json --composite false --incremental false
npm run build
```

预期上述范围全部PASS，build无本次新增类型错误。若基线已有失败，单独记录原错误及本次diff不相关证据，不把全套描述为通过。再从extensions目录运行已安装的测试器：`Set-Location -LiteralPath 'D:/OneDrive/Project Files/Pi/extensions'`，随后 `& '../electron-agent/node_modules/.bin/vitest.cmd' run wiki-rag/index.test.ts wiki-rag/sync.test.ts`，确认新读取工具连接关联库、旧写工具仍保兼容且scope不扩大。

- [ ] **步骤 5：人工验收与阶段门。** 使用专用测试应用数据根，不使用用户真库；分别在1200×800、1440×900及内容区760px验证浅/深主题、超长项目路径、三类删除确认、取消等待、断线保内容、Ctrl+S、Escape保稿、焦点返回。记录失败场景截图/具体预期，修复后重跑相关测试。本阶段验收完再进入 Memory/Code 阶段，不在这里实现任务面板/审计面板总改版。

## 3. 自检与阶段交付检查表

| 设计/风险 | 负责的任务与可验证证据 |
| --- | --- |
| 独立 name/description/kbId、多项目共享、重命名不搬目录 | 1、9：同名库不同UUID、storageKey不变、bindings多选 |
| 原桶登记幂等、兼容导出、故障恢复、legacy保留 | 2：重跑字节一致、解绑不回填、SQL/COMMIT故障测试 |
| 管理/项目范围及旧RPC解绑后拒绝、token轮换 | 3、8：绑定token、伪scope/admin/chunk、重启测试 |
| 资料UUID、同名不更新、revision/快照、项目外链防护 | 4、10：同名A/B、旧revision可读、junction和源变更拒绝 |
| 人工锁、完整文件hash、0..N来源、不覆盖多来源 | 5、11：人工/外部冲突、多来源发布跳过、草稿保留 |
| create不LLM、显式ingest、增量/失败重试、取消 | 6、10：调用次数、逐页summary、旧结果不写、原页track |
| 库/源/页删除门、晚输出、防复活、保审计及项目原文 | 7：deferred模型、active target、重启tombstone、显式重新生成 |
| reindex不模型/不改正文、诊断可恢复 | 12：模型spy为0、坏frontmatter保旧索引、问题path |
| 默认浏览、状态保留、响应式/主题/键盘、错误不等于空集 | 9–12：RTL测试与两个主验收窗口/窄内容区检查 |

执行完成报告只列实际通过的命令与未通过项；本计划编写本身不等于已迁移、已实现或已通过这些测试。后续由总计划选择逐任务子代理实现或按执行检查点内联实施。

## 4. 第二阶段交付记录（2026-09-05）

- [x] 任务 1–2：稳定库 ID、独立物理桶、旧 SQL→MD 导出后登记；重命名、解绑、删除及故障重试不复活数据。保留旧 SQL、旧索引回退表和冲突备份。
- [x] 任务 3、8：主进程固定管理入口、项目凭据、分片身份检查、23 项独立管理 IPC、具名关联库只读 Agent 工具。通用任务、聚合导出/审计不能成为 Wiki 权限旁路。
- [x] 任务 4–5：独立资料 UUID、不可变快照、显式版本更新、受限项目导入、人工页及完整文件 CAS。锁页、多来源、已修改来源和异常引用不会被旧生成结果覆盖。
- [x] 任务 6–7：显式增量抽取、真实模型预览/复核、用户任务与系统写者租约、取消确认和持久删除门。页面删除抑制再生；资料删除保引用快照；库删除保项目原文和历史。
- [x] 任务 9–11：默认库列表、资料三入口、Markdown 编辑/预览、主题/内容宽度断点、草稿和选择保活、原页任务跟踪。所有异步表单按会话/请求代次隔离；窄屏返回在 DOM 提交后恢复焦点。
- [x] 任务 12：无模型索引重建、坏桶保索引与诊断、完整共享库工作流、存储/界面/运行时独立复审和隔离浏览器验收。

### 实际接口与实现补充

- `WikiStore(db, root, {libraries, sources})` 在构造时完成兼容导出→登记→索引升级/重建；也保留仅传 libraries 的兼容方式。避免先用旧模式重建已升级的索引。
- 项目关联保存在 `wiki_libraries.bindings` JSON，并随库版本和 `library.json` 在同一事务更新；没有再维护第二份绑定表。授权比较规范化路径，显示和原桶映射保留原值。
- `WikiSourceStore.markProcessing` 显式接收 revision 并返回是否成功，`markResult` 支持将中断的同一版本复原为 pending。生成发布与处理成功标记在同一事务，嵌套写入使用 SAVEPOINT 及对应文件回滚边界。
- `sources.read(kbId, sourceId, revision?)` 增加可选历史版本，返回快照 `version`；页面不能用资料最新版冒充旧引用。
- `WikiLibraryView.deletingTargets` 返回持久待删除目标，管理工作区提供继续处理入口，关闭确认框或任务刷新后仍可重新完成删除；该字段不发给项目 Agent。
- `WikiSyncService.run` 返回实际成功/跳过/失败计数；`onSkip` 通过固定 in-process 审计入口记录，不暴露任意方法网关。
- Runtime/Service 增加关闭排空；TaskQueue 停止派发后保留普通 queued 任务，Wiki queued 由 Wiki 边界明确取消。实测等待中的 Memory 抽取仍能在重启后恢复；中断 Wiki 不自动重放模型调用。

### 最终验证

工作目录 `electron-agent`，使用已有测试器：

```powershell
& './node_modules/.bin/vitest.cmd' run --maxWorkers 4 electron/agentData electron/app/agentDataService.test.ts electron/app/wikiLibraryService.test.ts electron/app/wikiSyncService.test.ts electron/app/validateProject.test.ts electron/app/piRuntimeService.test.ts electron/app/memoryService.test.ts electron/app/appServer/taskQueue.test.ts electron/app/appServer/serviceTaskRegistry.test.ts electron/pi/systemWorkerManager.test.ts electron/ipc/register.test.ts electron/ipc/commandCoverage.test.ts src/lib/agentData.test.ts
& './node_modules/.bin/vitest.cmd' run --maxWorkers 4 src/features/agentData src/features/workspace/ModuleContainer.test.tsx src/lib/agentData.test.ts
npm run build
```

结果：后端/协议 **31 文件、358 项通过**；前端 **17 文件、188 项通过**。两次范围包含重叠 API 测试，不能相加作为去重覆盖数。`extensions` 目录运行本地测试器的 `wiki-rag/index.test.ts wiki-rag/sync.test.ts`：**2 文件、33 项通过**。Electron main/preload/renderer 构建成功。

显式主进程类型检查仍失败：37 项，对比本轮启动基线 38 项没有新增错误，修正了扩展命令清单测试的 readonly 参数问题。以 `src/main.tsx` 为入口、显式加载 Node/Vite 类型的 renderer 检查仍有 5 项既有错误（NativeSkillsPanel 三项、agentData RuntimeArgs 两项）。`tsconfig.json` 的 `files: []` 使普通根 tsc 不等于上述全量检查，不能报告类型全部通过。工作区另有未接入应用入口的 `codeGraphLayout.ts` 草稿类型问题，本轮未修改。

### 浏览器与边界

使用真实 Wiki React 组件、内置隔离浏览器和明确标注的内存 API 替身，不连接用户应用数据根或真实模型。验证了 1440×900、1200×800、760×800，深浅主题与无横向溢出；人工建页/Ctrl+S/默认锁、Markdown 预览、版本冲突保稿、Escape 确认、抽取真实预览字段与原页终态、显式任务 ID 回调、断线保列表/正文。760px 下页面和资料关闭后，实际 activeElement 分别回到各自列表触发项。最终浏览器控制台无 error。

破坏性删除、取消/迟到结果及故障恢复使用临时文件/SQLite/RPC 自动测试，不通过真实应用 GUI 删除用户数据。存储与 UI 均先完成规格复审，再完成代码质量复审；运行时关闭/队列兼容另做独立审查，无剩余需修复的 P1/P2。

已关闭隔离浏览器标签、重置临时视口、停止预览服务并删除本轮临时预览源码与类型检查配置。使用说明更新在 `docs/agent-data-wiki.md`。保留现有分支和所有未提交修改，未提交、推送、归档或进入第三阶段；用户重启 Electron 后才加载新后端与扩展。
