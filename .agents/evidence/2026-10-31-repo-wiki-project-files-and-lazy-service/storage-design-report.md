# Repo Wiki 项目文件事实来源设计审查

日期：2026-10-31。范围：只读审查当前源码、AGENTS 和现行笔记；本文件是唯一新增文件。未读取用户数据库，未访问/初始化/迁移真实项目，未运行 provider，未提交或推送。以下是设计建议，不是已实现或已验证的行为。

后续实施与审查定案见 `task-1-report.md`。其中身份契约已细化：project.json.id 是可携带的 portable id，Project.portable_id 回传它；public/cache Project.id 按 canonical workspace + language + portable id 确定性计算，保证复制事实目录的两个克隆不会共享运行态/缓存/编辑目标。删除索引按相同规则恢复公共 id，磁盘 portable id 不改。不要把本设计初稿中“保留 id”误读为允许裸 portable id 作为全局缓存主键。

## 建议结论

默认把完整 Wiki 状态放在当前宿主项目的 `docs/repo-wiki/`。Markdown、计划、人工合并需要的 baseline/pending、来源、归档状态和 revision 都必须在该目录完整表达；`userData/repo-wiki/` 只保留可删除重建的查询/生成缓存及旧数据库备份。宿主 `WorkspaceService` 决定项目集合和当前授权根，项目文件只表达该项目的知识，不能反过来添加宿主项目。

首版保留现有分支/语言/知识种类 namespace、数字 revision、三方合并语义；新增磁盘内容 token，阻止外部编辑后旧 UI 保存覆盖。只在激活当前根时初始化或迁移，不在集合页或应用启动时遍历创建所有项目。

## 当前契约和需要守住的行为

| 位置 | 事实 | 设计影响 |
| --- | --- | --- |
| `core/src/engine.ts:466–483` | 构造函数立即建立全局 `workspace.sqlite3`，projects/revisions/snapshots/pages/generation_cache 都在其中 | 不能仅把 DB 挪进项目，就声称文件成为事实来源 |
| `engine.ts:504–541` | project、snapshot、page 的所有读取直接查 DB；revision 是全库自增值 | 页面读取必须改为文件；缓存丢失不得影响 revision 或人工文本 |
| `engine.ts:84–91,548–561` | namespace 是 branch+language 的 SHA256 前 24 位，cards 额外带 `knowledge-cards-v1` | 不改 namespace 算法；迁移保留所有历史 namespace，而非只迁当前分支 |
| `engine.ts:586–672` | create 先扫描、读取根 `wiki_plan.json`，之后才按 path+language 去重 | 列项目调用 create 会产生扫描/初始化副作用；计划目前只导入一次，后续 update 只写 DB |
| `engine.ts:1154–1269` | 生成结束重新验证源码、分支、commit、计划；在事务内读取最新人工文本再三方合并，保留 pending、归档被移除页 | 文件后端必须保留整轮校验和 latest-read merge，不能逐页生成后立即覆盖 Markdown |
| `engine.ts:1287–1351` | edit/resolve 只用数字 expected_revision 做 CAS | 外部编辑 `.md` 不会更改 JSON revision，旧 CAS 单独不足以保护文本 |
| `engine.ts:1379–1406` | export 排除 archived，并把导出时 markdown 写作 manifest baseline | 导出格式不是无损内部存储；直接用 export 做迁移会丢归档、真实生成 baseline、pending 和部分元数据 |
| `core/src/migration.ts:1–5,254–451` | 现有迁移是停服后按 DB/WAL/SHM 字节验证的 copy-first 全 dataDir 迁移；源文件只用只读 fd，SQLite 仅打开副本 | 可复用安全快照机制，不能直接拿当前 migrateWorkspace 当项目文件迁移入口 |
| `electron/app/repoWikiService.ts:337–349` | syncProjects 遍历所有 approved roots，缺少 zh 项目即 create | 若 create 开始写项目目录，原逻辑会顺带写入所有真实项目，必须先拆开投影和当前项目 ensure |
| `packages/contracts/src/index.ts:99–112,226–228` | edit/resolve 只有 expected_revision；plan 没有旧版本条件，字段白名单拒绝新增字段 | token 需要贯穿 contracts、service、client、UI，不能只改引擎签名 |

已审查现行笔记：`2026-10-31-repo-wiki-process-integration`、`repo-wiki-host-workflow-alignment`、`repo-wiki-windows-git-identity`、`repo-wiki-windows-stream-and-wal-tests`。知识调度/独立子进程/上下文隔离继续有效；文件事实来源会替代首篇里的集中式 dataDir 持久化决定，实施前应另写 proposed 并互链，不要把原决定正文改成反面。

## 为什么首选 docs/repo-wiki

| 位置 | 最强理由 | 本次取舍 |
| --- | --- | --- |
| `.pi/repo-wiki/` | 已有项目 MCP、规则、图片等宿主产物；不污染文档目录 | 本仓 `.gitignore:62` 忽略整个 `.pi/`。不适合希望直接浏览、提交、共享的 Wiki 事实来源 |
| `.gren/repo-wiki/` | 品牌一致，已有宿主工作目录 | isolatedWorkspaceService 会追加 `/.gren/` 到 `.git/info/exclude`，fileService 目录列表隐藏 `.gren`；它是工作区池，不是用户文档 |
| `.repowiki/` | scanner 已默认跳过，改动最少 | 可满足项目本地持久化；目录隐藏且文档发现性弱，作为可接受替代 |
| `docs/repo-wiki/` | Markdown、计划及来源随项目可见可审查，可直接用现有文件浏览器打开 | 推荐固定默认位置；需要 scanner 强制排除产物，不能仅依赖用户 plan.exclude 或 gitignore |

首版用单一常量 `PROJECT_WIKI_DIR = "docs/repo-wiki"`，不做任意输出路径设置。若该位置是普通文件、symlink/junction、或含有不属于本产品的同名文件，返回明确冲突，不能把用户文件夹接管。不得修改项目全局 `.gitignore`；内部临时目录可以用本目录自己的 ignore 文件处理。

scanner 的输出根排除必须在候选枚举阶段、include/exclude 之前生效，Wiki/cards 都适用；`worktree_hash`、dirty 的 tracked-deletion 检查也不应因该产物根的增删而自我失效。当前 scanner 的 `dataDir` 只跳过集中式缓存目录，不覆盖新的项目输出根。

## 最小文件布局

```text
<hostWorkspace>/docs/repo-wiki/
  zh/                               # language 原样校验，大小写策略固定
    project.json                    # schema_version/id/name/language/timestamps/next_revision
    plan.json                       # validate_plan 校验后的唯一计划事实
    migration.json                  # 可选：所选旧 project 的导入收据
    namespaces/
      <现有24位namespace>/
        namespace.json              # target、identity、完整snapshot、last_run
        pages/
          overview.md               # 当前人工可编辑正文，UTF-8
          architecture/storage.md
        meta/
          overview.json             # 原 page 除 markdown 外全部字段
          architecture/storage.json
  en/...
  .transactions/<txid>/...           # 未完成文件提交/恢复记录；正常完成后清理
```

`meta/<slug>.json` 首版直接保留 `baseline`、`pending_markdown` 两个字符串，以及 revision/status/sources/pending_sources/dependencies/direct_sources/related_page_hashes/coverage/fingerprint/provider/updated_at 等原字段，不再引入另外两套 Markdown 目录。这样字段转换最小，无损保存人工合并所需状态；以后若希望把 baseline/pending 也拆为 Markdown，应另做格式版本迁移。card summary 是可从当前正文重建的派生值，不必持久化为唯一来源。

`namespace.json` 同时记 target 和 identity，校验它与目录名及 language 一致。archived 页保留正文与元数据，不删除。namespace target 可区分 wiki/cards，继续保留现有跨种类 slug 碰撞拒绝规则。`next_revision` 持久化在语言级 project.json，修改页时统一分配，导入后大于所选 project 所有 namespace 的最大 revision；不依赖 SQLite 自增表。

project.json 不保存绝对工作区路径，不把源 DB 的绝对 userData 路径提交进项目。运行时 `Project.path` 始终由当前授权宿主根注入。id 保留旧项目 id；全新项目生成一次并写入 project.json，缓存删除、根目录搬迁和应用重启不得换 id。相同内容的另一个克隆即使沿用磁盘 id，也仍以授权 workspace+language 隔离，不可只凭 project_id 查全局缓存。

plan.json 是唯一可修改计划。迁移优先使用旧 DB 的有效 project.plan，不能被早已过时的根 wiki_plan.json 反向覆盖。全新初始化且没有 plan.json 时，可一次性导入根 wiki_plan.json，否则用当前 defaultPlan。两个计划并存时不做双向同步；根文件作为兼容导入源，后续 UI 和外部编辑都指向新 plan.json。

## 最小接口边界

```ts
type ProjectFileIdentity = { workspace: string; language: string };
type FileToken = string; // sha256(精确正文+受保护元数据的规范表示)
type LoadedProject = {
  project: Project;
  planToken: FileToken;
  namespaces: Map<string, NamespaceState>;
};
interface ProjectFileStore {
  // 仅由已授权 active workspace 调用；内部完成恢复/按需初始化/按需旧DB导入。
  open(identity: ProjectFileIdentity): LoadedProject;
  loadPage(namespace: string, slug: string): WikiPage & { storage_token: FileToken };
  loadPlan(): { plan: WikiPlan; storage_token: FileToken };
  commit(change: ValidatedChangeSet): void; // 带每个读集的预期token和写集
  close(): void;
}
interface DerivedCache {
  getGeneration(fingerprint: string): GeneratedPage | undefined;
  putGeneration(fingerprint: string, output: GeneratedPage): void;
  rebuild(project: LoadedProject): void;
}
```

保留 WorkspaceEngine 外部功能入口；内部把 `project/pages/snapshot/saveProject/savePage/revision/transaction` 从直接 SQL 改为明确的项目文件操作。不要用“先把文件灌进内存 SQLite，跑原引擎，再导出”的双事实来源捷径，否则异常时仍难判断哪个状态有效。SQLite generation cache 可以继续使用，但缓存读写失败/不存在/损坏只导致 cache miss；文件提交成功后才能更新派生索引，缓存更新失败不能把已提交知识判成丢失。

对外最小增加：

- WikiPage 返回 `storage_token`；edit/resolve 请求带 `expected_storage_token`，与 expected_revision 一起检查。token 必须含真实磁盘 Markdown，不能只含 JSON revision。嵌入宿主写路径要求 token，避免老客户端静默跳过外部编辑保护。
- Project/计划读取返回 `plan_storage_token`；plan 更新带 `expected_plan_storage_token`。生成开始记录计划 token，提交前再次读文件比对，外部计划变更也能阻止旧生成提交。
- 若协议保持版本 1，必须同步修改字段白名单/校验和所有内部调用者；若存在跨版本独立客户端，则提升协议版本，不能悄悄让同版本写请求变为必填新参数。
- 内部 `ensureActiveProject(workspace, language)` 与 `listHostProjectDescriptors()` 分开。后者只根据 WorkspaceService 返回集合并叠加已有可重建摘要，不能 create/scan/migrate。当前 activate 才打开该根文件并按需导入。未激活项目可显示“尚未加载”，不要伪造为零页。

项目列表 id 需要在实施时选定一种策略：推荐把集合页选择参数设为 workspace（它本来就由 pi.openWorkspace 打开），activation 后再返回磁盘 project_id。不能为了给未激活项目找旧 id 而初始化全部项目；也不能以临时派生 id 覆盖持久 id、破坏已有草稿绑定。

## 写入、外部编辑和恢复

1. 所有存储 I/O 留在 Repo Wiki OS child。每个根+语言一次最多一个写事务；锁文件用独占创建，带进程/实例和操作 id，不能只按超时删他人锁。多应用实例竞争返回受控 busy。
2. 每次读取都以磁盘为准，严格 UTF-8、普通文件、路径组件无 symlink、真实路径仍在当前授权根内；保留现有限制（Markdown 2MB、计划100KB、safe slug），另给完整 namespace 和迁移总量设上限。Windows 要额外拒绝保留设备名、尾随空格/点、大小写折叠碰撞；现有字母数字 slug 正则不足以避开 `NUL` 等名字。
3. 不预先 rewrite 外部编辑的 Markdown。读取时根据正文与 baseline 算 edited 状态，返回内容 token；原冲突/归档状态优先。已登记正文缺失、未知孤立 `.md`、损坏 metadata 分别报可恢复的 missing/untracked/corrupt，不把缺失当空正文自动写回，不把未知页自动删掉。
4. UI edit/resolve 先比较 revision+storage token，失败409并保留草稿。生成提交前重读当前 Markdown，继续用 `three_way_merge(baseline, latestHumanText, generated)`；overlap 保持人工正文及旧 baseline，把生成稿和来源存 pending。外部计划改变则整轮拒绝。
5. 先把完整写集及 before/after 哈希写入同文件系统的 `.transactions/<txid>/`，fsync staged 文件并写 prepared 标记；确认取消/读集后进入不可中断的本地发布段。单文件用 rename 原子替换，不逐页向 UI 报完成；最终写 committed 标记，再清理 journal，最后更新缓存。
6. 每次 open 在对外读知识前先恢复本根未完成事务。待应用文件 hash==before 才补写，==after 视为已完成，其他值一律保留（说明有外部编辑），把事务标为 blocked 并返回恢复冲突。不能拿旧 backup 无条件回滚覆盖人后写的文件。恢复、重试都不得触发 provider。
7. 应用读者通过同一存储层/锁观察完整状态；未完成或 blocked 事务不能作为成功整轮结果显示。故障注入必须覆盖每个写步骤。

需要明确的能力边界：Node 的 compare-hash 后 rename 不是与任意外部编辑器共享的原子 compare-and-swap。应用锁只能串行化本产品实例；外部程序恰好在最后一次校验和替换之间写同一个 inode 时，不能声称绝对零丢失。最小落地应在替换前保留原文件的独立备份及 journal、紧贴发布前复核，并对未知新哈希停止恢复。若产品要求对任意外部写入也严格无覆盖，必须额外选定 Windows 文件锁/原生条件替换，或将外部改稿变为显式导入；不能用普通 rename 冒充这项保证。同样，多个普通文件对任意外部读者没有一次性原子可见性；这里承诺的是应用读者的提交隔离和崩溃恢复。

## 旧 DB 按需迁移

入口只接受宿主传来的当前 canonical workspace 和 language，不能接受 renderer 提供任意 DB 路径/输出目录。迁移来源固定为旧 userData/repo-wiki/workspace.sqlite3；若新项目文件已经存在且有效，它们永远优先，不能因为旧 DB 较新就反向灌回。

建议流程：

1. 在首次激活且该语言目录完全不存在时，旧写者先干净停止/冻结；当前新引擎不得再创建或写旧 DB。检查 DB/journal/WAL 状态，只复用 copy-first 的只读 fd 快照方式。源 DB 即便 `readOnly:true` 打开，在 WAL 场景也可能改 SHM，因此不直接用 SQLite 打开源。
2. 快照可复制整个旧 DB 到宿主临时缓存目录，但副本中只导出 canonical path（Windows pathKey 一致）+language 匹配的 project。所有其他项目不初始化、不扫描、不写文件。旧库中多个不同 id 匹配同一根+语言时返回 ambiguous migration，不凭 row 顺序选。
3. 对副本进行 schema/integrity/JSON/计划/slug/namespace/大小校验，收集所选 project 所有 namespace 的 page 和 snapshot，包括 cards、人工编辑、pending、archived。重建 revision 下界。generation_cache 不导入，也不迁移运行中的 watch 自动行为；嵌入态保持 watch=false。
4. 在当前项目内的同级临时目录生成完整新语言目录；逐文件读取验证和哈希，再用独占发布安装不存在的 `<language>` 目标。目标已存在时不得 merge-overwrite。临时目录带 txid/owner，只清理自己创建且身份匹配的路径。
5. `migration.json` 含 schema_version、legacy_project_id、源 DB/WAL 哈希、所选记录摘要哈希、namespace/page 数量、目标文件清单/哈希、完成时间、copy-first 模式。它是导入收据，不是锁，不含绝对私有路径。写入前后的源 DB/WAL/SHM 名称/stat/hash 均相同才能发布。
6. 成功后旧 DB 原样保留，不 DELETE、不改 schema、不删除源 DB/WAL/SHM；仅后续显式维护才可处理旧备份。来源不存在或没有匹配记录则正常新建项目文件；来源存在但损坏/忙/有 journal/变化时返回明确错误，不能静默新建把旧知识隐藏。

幂等规则：目标完整且格式有效直接加载，不重复导入，也不要求已被人编辑后的目标哈希仍等于 migration receipt；receipt 是历史证据。目标缺失且同 txid staging 完整时复核源摘要并继续独占发布。目标部分存在/无有效 schema/与 staging 冲突时保留双方并返回409，不能用旧 DB 修补未知用户文件。发布成功后崩溃、缓存丢失、重复 activation 都不再读取旧 DB 或触发模型。

现有 migrateWorkspace 的“目标必须不存在、源 byte 不变、停服离线、SQLite 只碰副本、SHM 不复制”纪律应保留；拆出安全快照 helper 即可，不需要改它原有对外 CLI 语义。

## 定向测试清单

全部使用 tmpdir 夹具和确定性 provider/loopback；绝不以真实7项目或用户库验收。优先在现有 core engine/cards/migration/scanner 测试与宿主项目 integration 上扩展；存储纯逻辑不需要新 UI 场景，新增 token/外部编辑提示时只跑现有 repo-wiki 场景。

| 组 | 必须覆盖的案例 |
| --- | --- |
| 文件成为事实 | 完整生成后关闭，删除/损坏整个派生 SQLite，再开可读全部正文、计划、sources、baseline、pending、archived；不调用 provider；直接改 `.md`/plan.json 后重读看到新值 |
| 旧语义 | 保留 engine.test 的人工三方合并、overlap、显式resolve、archive、branch/language、cards namespace、单轮取消、源码/计划变更拒绝、export/import 回归 |
| CAS | UI读取后外部改正文但 JSON revision 不变，edit/resolve 409；外部改 metadata、plan、缺文件也拒绝旧写；A→B→A及重启草稿仍绑定原项目id |
| 不自喂 | 只增删改 docs/repo-wiki 中正文/meta/journal，不改变 source hashes、page dependency invalidation、worktree_hash/dirty判定，不把生成稿放入模型上下文 |
| 缓存 | generation cache 缺失/损坏/写失败不能丢页；缓存命中与文件一致；缓存损坏不会把旧缓存正文当当前人工正文；force仍绕过生成缓存 |
| 新库初始化 | 没旧库/无匹配project时只初始化当前语言；plan一次性兼容导入；已有 plan.json 优先；重复激活不扫描/不改mtime/不重复分配id |
| 无损迁移 | 自造旧库含2+项目、2语言、2分支、wiki/cards、人工edit、conflict pending、archive、嵌套slug；只迁当前根语言全部namespace；其他目标路径不存在；源 DB/WAL/SHM 字节与文件清单不变 |
| WAL和格式 | 已提交WAL、离线含未提交帧WAL、rollback journal、源copy中变化、损坏JSON/schema、未知table/trigger、超限均按现有纪律通过/拒绝；不能skip Windows SHM锁案例 |
| 幂等/冲突 | 重复迁移、发布后崩溃、receipt存在但正文被编辑、目标抢占、同路径重复旧project、已存在手工docs、部分目标、stale staging，均不覆盖/不重复导入 |
| 崩溃恢复 | 在stage/prepare/第1页发布/metadata发布/project counter发布/commit标记/缓存更新逐点失败；重开后安全补完或blocked保留外部编辑；不提供混合成功视图、不调模型 |
| 路径安全 | traversal、绝对slug、symlink/junction及中途替换、大小写碰撞、NUL/CON/尾点、输入语言非法、只读项目、磁盘满/权限错/rename失败；不写授权根以外 |
| 宿主边界 | WorkspaceService登记7个临时根，集合页零init/zero scan/zero migration；激活A仅A产物存在，切B才B初始化；移除授权根后拒绝；旧context和旧child事件仍隔离 |

## 收敛后的实施接口（主协调已定方向）

主协调已建立 `.agents/notes/proposed/architecture/2026-10-31-repo-wiki-project-files-and-lazy-service.md`：目录固定 `docs/repo-wiki`，旧 DB 原件不写，新缓存另文件，journal/recovery 不覆盖未知冲突，仅当前根迁移。此处是提交给 service/宿主 owner 的具体接口契约，尚未写产品代码。

```ts
type ScanOptions = { target?: ContentTarget; signal?: AbortSignal };
type HydrateOptions = { signal?: AbortSignal };

// 当前项目准备：只访问本根知识文件、必要的固定旧库快照及新缓存。
// 不Git、不遍历源码、不provider。首次准备可有迁移I/O，所以是async且可取消。
hydrate_project(path: string, language?: string, name?: string | null,
  options?: HydrateOptions): Promise<Data>;

// 保留旧同步函数供新fixture/已hydrated调用者兼容；不再扫描或Git。
// 尚未hydrate且有固定旧库需要确认时409要求走hydrate，禁止抢建空文件遮蔽迁移。
create_project(path: string, language?: string, name?: string | null): Data;

// 只投影当前引擎已hydrate的项目，不发现新宿主项目、不磁盘遍历、不Git。
list_projects(): Data[];
get_project(id: string): Data;
changes(id: string, target?: ContentTarget): Data;

// 单页读取刷新对应正文/meta文件，以便外部编辑在打开时可见；无全仓扫描。
get_page(id: string, slug: string): Data;

// 唯一显式源码检查入口；异步分段I/O与异步Git，循环中检查signal并让出事件循环。
scan_project(id: string, options?: ScanOptions): Promise<Data>;

// 生成保留现入口，但内部初始/最终校验使用异步scan，不再调用同步scanner。
generate(id: string, provider: GenerationProvider, force?: boolean,
  progress?: Progress, target?: ContentTarget): Promise<Data>;
```

`hydrate_project` 是 service 的 create/当前项目读取准备入口。已准备项目去重返回缓存状态，不能每次 hydrate 复制旧库或重读全部正文；文件刷新可在单页打开、显式扫描、保存/生成前进行。新项目默认计划先用 `defaultPlan([], language)` 的三个基础页，或已有 plan.json/兼容根计划；不能为了补模块页而首屏扫描。后续显式 scan 可以提供候选模块信息，但不能无条件改写用户计划。

缓存快照最小状态：

```ts
type CachedScanState = {
  state: "unknown" | "ready" | "stale";
  scanned_at: string | null;
  identity: Record<string, unknown>; // 上次明确扫描获得；未知时不伪装当前Git分支
  // ready/stale时保留现有changes结果字段；unknown不能等同无变化。
};
```

`changes` 永远即时返回上次结果加上述 state；页面轮询它不会发起工作。只读文件 hydrate 可用 namespace.json 的上次 identity 作为浏览定位；unknown 项目没有历史 identity 时显示尚未检查，不在 get/list 内同步执行 Git。“当前 Git 分支”只由显式异步 scan 刷新，scan 切换 namespace 后相关旧页面写入 token 必须失效。

`scan_project` 负责一次真实扫描，返回现有 changes 数据+缓存状态并持久化可重建摘要。service owner 负责同项目合并、运行态、请求取消/超时与任务生命周期，不能通过每次 poll 调用它来重建原问题。core 保证 scan 执行期间能够处理 AbortSignal；只把同步 scan 包在 async 函数里不合格。scanner 新增 `scanRepositoryAsync(root, options & { signal? })` 及异步 Git 身份；原同步 API 可保留给既有直接工具测试，但生产 hydrate/get/list/changes/generate 不得经过它。

service 中生成队列的 identity 比较不能再调用 cached `changes` 期待新Git结果；需要 `await scan_project` 得到明确扫描结果或直接复用 generation 初始异步扫描的身份。source读取也不得为了一个行区间全仓扫描，应在当前计划/已扫描覆盖允许的相对路径上读取单个安全文件；未获得覆盖时返回“先检查源码”或显式await扫描，由service决定用户可见任务态。

数字 revision + 文件/计划 token 保持为建议实现；跨版本兼容策略由 contracts/service owner 一并定下。journal只承诺本应用读者隔离与可检测的崩溃恢复，上文列出的任意外部程序极小写入竞态仍是明确工程边界。
