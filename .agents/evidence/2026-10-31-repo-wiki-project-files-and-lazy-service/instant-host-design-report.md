# Repo Wiki 即时宿主首屏：只读设计报告

日期：2026-10-31。范围：静态读源码、既有笔记与测试；本报告不表示已经实现或验证优化。没有读取用户项目目录、运行应用/模型、重启用户实例、提交或推送。只新增本报告文件。

## 结论

将三件事拆开：宿主项目展示、当前上下文授权、当前 Wiki 数据加载。首屏直接使用 `useSessionStore.activeWorkspace` 与已有 `registeredProjects` 展示名称/路径；`activate` 只绑定主进程权威上下文；单独 `load` 在后台启动独立 child 并仅加载当前 workspace/language。Wiki DB 的 `project_id` 不是宿主项目的显示身份，也不应成为首屏前置条件。模型准备移到明确生成之后；切换 workspace/language 轮换上下文与取消任务，不应因此杀掉 child。

## 当前确定的阻塞链

- `electron/app/repoWikiService.ts` 的 `activate()` 会先 `canonicalWorkspace()` 同步 realpath，然后 `ensureConfiguration()` → `approvedRoots()`（`listProjects` + 所有 root realpath）→ `resolveModel()` → `client.start()` → `syncProjects()`（逐个 root `create`）。`status: loading` 同时表示宿主未登记、child 未启动、Wiki 未加载，renderer 被迫 750ms 重试激活。
- `ensureConfiguration` 的 key 包含 `activeWorkspace` 与模型 cacheKey；`activate` 又在路径/namespace 切换时直接 `retireClient()`，所以 A-B-A 是重复启动路线。
- `RepoWikiWorkspace.tsx` 在等激活结果前只传 `status: loading`，没有传宿主项目列表；vendor `App.tsx` 看到 loading 就不加载 `/health`、`/projects`，并清空项目路由和数据。首屏依赖 Wiki DB，虽已有宿主快照也不能先显示。
- vendor `App.tsx` 的 2500ms interval 同时发 detail/changes/run，未合并在途请求。vendor Electron 注册器对每个带 `project_id` 的请求还先读一次 `project` 进行路径授权。不能把每轮的成本只算成三次请求。
- vendor `engine.list_projects()` 不是廉价 SQL 列表：每个项目多次计算 `currentNamespace`，再算 identity，会调用 Git。`create_project()` 在 `scanRepository` 后才用 `list_projects()` 去重。只在宿主加 Promise 去重不足以去掉此成本。
- vendor `WorkspaceService.inspectWatch()` 先 `visibleProjects()` 再 filter watch；所有 watch=false 也会每 1500ms 进入 Git 列表。timer 在构造时始终安装。
- process child 当前完全忽略 `cancelRequest` 消息；即使正确传播 AbortSignal，正在执行的同步扫描也不能立即响应 child IPC。真实取消不能仅以 UI 状态变化或父进程 Promise rejection 作为证据。

## 建议的 typed 契约

单独新增 renderer-safe 的 `packages/contracts/src/host.ts`，主进程、renderer adapter、Panel 共用；不在 `RepoWikiWorkspace`、service、Panel 各自重复字符串联合类型。保持通用 `Project` 与 `RequestMap.projects: Project[]` 的既有含义，避免伪造 Wiki id 或把 `host:<path>` 塞进必须匹配 `[a-zA-Z0-9_-]+` 的 project_id。

```ts
export interface HostProjectSummary {
  key: string;                 // 宿主规范化路径身份，不是 Wiki project_id
  workspace: string;           // 展示/选择路径；主进程仍独立授权
  name: string;
  wiki?: {
    project_id: string;
    language: string;
    page_count?: number;       // 未取得真实快照时省略，不能伪造 0
    card_count?: number;
    snapshot_at?: string;
  };
}
export interface HostProjectsSnapshot {
  revision: number;
  state: 'pending' | 'ready' | 'error';
  projects: HostProjectSummary[];
}
export interface HostActivationRequest {
  workspace: string | null;
  language?: string;           // 默认 zh；不依赖 DB id 就能选 namespace
  retry?: true;               // 仅显式恢复耗尽的 supervisor 预算
}
export interface HostActivation {
  context_id: string;
  workspace: string | null;
  language: string;
  status: 'bound' | 'pending' | 'empty';
  // bound = 宿主已授权，可以开始 load；不表示 child/Wiki/model 已就绪
  project_id: string | null;   // 可以从缓存带回，无缓存时 null
  projects_revision: number;
}
export interface HostLoadRequest {
  __repoWikiContext: string;
  refresh?: boolean;          // 明确刷新才重新检查工作树
  target?: 'wiki' | 'cards';
}
export interface HostLoadResult {
  context_id: string;
  project: Project;
  run: Run | null;
  // changes 可在一次当前项目扫描后带回，不再并发启动第二次扫描
  changes?: Record<string, unknown>;
}
export interface HostRequestMap {
  repoWiki_activate: HostActivationRequest;
  repoWiki_hostProjects: Record<string, never>;
  repoWiki_load: HostLoadRequest;
}
export interface HostResponseMap {
  repoWiki_activate: HostActivation;
  repoWiki_hostProjects: HostProjectsSnapshot;
  repoWiki_load: HostLoadResult;
}
```

`packages/renderer` 增加 `createGrenRepoWikiHostClient`（activate / projects / load / subscribeContext）或对应的 typed wrapper。通用 RepoWikiClient 保持原 actions。Panel 的 HostContext 则在上述传输 DTO 外加 UI callbacks、load 状态与已有项目快照，不将 callbacks 放 IPC DTO。建议 Panel 使用 `activation.status` 和 `load.status: idle | loading | ready | error` 两个字段，彻底去掉 overloaded loading。

事件 `repoWiki://workspaces` 建议区分：`{kind:'projects', revision}` 只更新展示列表；`{kind:'context', context_id, reason:'revoked'|'crashed'|'failed'}` 才撤销旧 token。项目数据到达可直接由 `load` response 更新，不必轮换 token 再触发激活循环。语言选择走 `{workspace, language}` 激活，旧 `project_id` 激活入口若兼容保留，必须通过已有绑定校验，不能信任 renderer 指定的任意 id。

## 宿主快照及权限不变量

1. **展示不授予权限。** renderer 的 registeredProjects 只负责首帧；不能作为 allowedRoots，也不能因 renderer 有路径就允许 load/create。`key` 也不是权限凭证。
2. **主进程必须有自己的宿主登记快照。** 不能让 `repoWiki_hostProjects/activate` 再调用会对全部路径 stat/realpath 的 `WorkspaceService.listProjects()`。在宿主已执行 listProjects/ensure/forget 时同步更新 `{revision, canonical roots, state}` 内存快照，并给 RepoWikiService 只读 accessor。启动初始未知为 pending，后台一次读取权威登记；未授权前界面仍可展示已有 renderer 快照，但不可读取 Wiki/源码。项目变更通知递增 revision，撤销必须立即生效。
3. **activation 无项目 I/O。** 校验请求 schema、当前 BrowserWindow/顶层 frame 身份，并与主进程快照匹配；没有快照只能返回 pending，不扫描、不 resolveModel、不启动 child、不 create。null/真实 scratch 是 empty，不能永久 retry。scratch 的分类也应从已知宿主 worksDir/记录得到，不能把文件系统查询塞回激活关键路径。
4. **仅当前项目按需实查。** load/真实数据操作对选中 root 做 async canonical/path existence 校验；等待后再次确认 context object、授权 revision、sender trust。持久化路径指向别处或 symlink 变化时拒绝访问并要求宿主重新登记；不要把 renderer 路径重新 canonicalize 后自动扩权。vendor 对源码相对路径、安全打开、超限等校验保留。
5. **A-B-A 仍是不同 token。** 先轮换 context、同步撤销旧 run lease/AbortController，然后异步 cancel child 内旧任务；旧 renderer 无法再操作 A，返回 A 得到新 token。child PID 可以相同。数据、进度、保存响应继续检查 context + project + child instance + sequence；不能在收到迟到事件时用“当前 context”重新贴 token。每个 run/request 在建立时就绑定原 context。
6. **同一 token 可以从 project_id:null 补全为真实 id。** `load` 结果绑定同一 context；在途切换则丢弃。没有必要仅因 DB id 变为已知就 rotateContext，造成 renderer 重建和第二次加载。草稿缓存继续按真实项目 id/namespace 缓存。
7. **权限撤销和崩溃可重启，日常导航不重启。** 先保留“approved roots 变化 → 停止旧 child”的最小安全路线；不把 roots scope 退化到当前项目。模型变化只使 run lease 失效并取消旧调用。启动 child 必须以 embedded deny-by-default 表示空权限，不能落入 `[] = unrestricted`。child 构造若仍逐个 canonicalize root，也要改成接受主进程已规范化快照、到目标访问时实查，避免后台 load 又触及所有未选 root。
8. **取消优先于模型准备。** cancel/run/status 不能先 `resolveModel`，也不能排在 `ensureConfiguration`/扫描的 transition 队列后。运行已建立 lease 后，即使项目刚被移除，内部撤销仍能取消对应 job；外部旧 renderer token 仍然拒绝。实际取消必须穿过 child run AbortController → host completion → AgentData 队列/HTTP AbortSignal。

## 当前项目加载与便宜目录

新增一个 **process 内部的只读 metadata index action**，例如 `projectIndex: {} -> Array<{id,path,name,language,watch}>`，SQL 读取保存的 project 记录，禁止 identity/currentNamespace/scan。不要改变既有 `projects` 的分支/语言统计语义来冒充便宜列表。此 action 只被主进程用于当前路径/语言定位，不必暴露到 renderer 或 HTTP route；如果现有统一 Action 类型实现成本更低，可加入 action schema 后仍由 host registration 拒绝其 renderer 调用。

`load` 在主进程按 context/workspace/language 合并并发，然后 ensure child（不绑定模型）→ metadata index 找当前项目 → 不存在才 create 当前项目 → 一次当前 project detail。`create_project` 去重移到 scan 前，且用 raw project records，不能调用当前 list_projects 去重。metadata index 可按 path/language 定点查询进一步收窄。

现有项目详情仍可在后台读取当前 Git namespace；首次需要扫描创建计划时不阻塞宿主首帧。collection 的其它 6 个项目继续显示宿主名称/路径与未知计数，没有 Wiki metadata 也能点击。若要补统计，可异步提供明确标注为 snapshot 的保存摘要；不能为了准确显示所有项目的当前 branch 计数，再偷偷全项目 Git 查询。

模型不能以 child 环境变量固化为导航配置 key。生成前主进程绑定不可变、opaque 的 run lease（context/workspace/project/model configuration/cache key）；私有 process 命令为该 run 配置 HostModelProvider，模型请求必须携带可查验的 lease/run 身份。旧 run 的后续页面不能借当前 B 的模型执行。继续保留既有 expectedModel/expectedConfiguration、知识库全局并发与模型原样转发纪律。

## Renderer/vendor UI 最小改动

- `RepoWikiWorkspace`: 首 render 读 activeWorkspace + registeredProjects；不等任何 invoke 就把项目卡/当前项目名称交给 Panel。typed activate 独立 effect；bound 后按 context_id 调用一次 load。pending 主要由宿主登记事件推进；可保留有上限、单飞的登记补偿，不能 750ms 不断重复启动完整配置链。
- `RepoWikiPanel`: HostContext 同步定义移到共享 host contract；props 补 hostProjects、当前 workspace display identity、load 状态；所有后台失败只影响数据区域，宿主项目列表一直可选择。
- vendor `App`: 嵌入态不再 bootstrap `Promise.all(health, projects)`，host 项目来源直接是 props。当前项目没有 DB id 时画原概览框架/名称与明确加载态；数据库项目 id 到达才允许 page/edit/generate。集合项选择走 workspace/key，现有 standalone 路由依旧走真实 project id。
- `ProjectCollection`: 把展示 item 收窄为 `{key,name,path,projectId?,...optional persisted summary}`；现有 Project[] 可在 standalone 做 adapter。`onSelect` 回传展示 key；未知数量保持“— / 待同步”。不制造假的 Project。
- 取消 2500ms 全量 detail+changes+run interval。首次 load、显式刷新、当前 generation 终态与成功 mutation 后刷新必要数据；活动 run 如果需要断线补偿只 poll 便宜 run action，使用 single-flight `setTimeout` after settle，有离开 cleanup；terminal 事件后仅刷新一次 detail/changes。watch 事件可使当前数据 stale，但不能触发重叠 scan。
- watch timer 仅在有 enabled watch 时存在；持久化 watch id 可从 raw metadata 读取，`inspectWatch` 只访问这些 id，不能先 list_projects 全部。embedded 保留 watch 只标 needs_generation、不自动调模型。

## 分文件落地顺序

1. 新建 proposed 性能/生命周期笔记，并与 `2026-10-31-repo-wiki-host-workflow-alignment.md` 部分互链：保留权威上下文、知识调度、取消与草稿要求，明确取代“导航/模型配置串行替换整个 child”事实。process integration 架构笔记只同步现状，不改写其独立进程理由。
2. `contracts/src/host.ts` + `renderer/src/index.ts` + typed tests：共享宿主 DTO、host wrapper、运行时 schema/未知字段拒绝。
3. `electron/app/workspaceService.ts` + `electron/main.ts`: 提供主进程已登记快照 accessor/订阅，复用宿主已有 listProjects 结果，activation 不重新遍历 root；已登记变化失败时 fail closed。
4. `electron/app/repoWikiService.ts`: 拆 bindContext / ensureChild / loadCurrent / prepareGeneration；移除 syncProjects 全根 create；取消路径不依赖模型或配置队列；sender、context 与 run origin 三层校验保持。
5. `core/engine.ts` + `service/service.ts` + process contracts/client/child/host-provider：廉价 metadata index、scan 前去重、watch 按需、模型 per-run lease、可取消 request/run。同步 scan 的可响应取消方案需和 process 性能实现一并解决。
6. `RepoWikiWorkspace.tsx` + vendor `RepoWikiPanel.tsx`、`App.tsx`、`ProjectCollection.tsx`: 宿主首帧、后台当前项目、无假 DB id、事件刷新与单飞 run 补偿。
7. 更新 `testing/runtimeFixture.ts`、backend/unit/integration tests 与唯一 UI 场景 `repo-wiki`；不要扩大到全部 UI 场景。

## 必要验证（设计，尚未执行）

- **首帧结构测试**：7 个 registeredProjects，hold activate/load/model/child-start Promise 全不完成；首次 render 仍有 7 张可选择宿主卡与当前项目名称。单纯测 mock resolve 很快不构成证据。
- **激活独立测试**：对 resolveModel/client start/scan 设永不完成或直接 throw；activate(bound) 仍完成且这些 spy 都为零。pending/empty 不创建 child；null/真实 scratch 不无限重试。
- **按需测试**：7 个真实临时 repo，打开 A 只发生 A create/scan；重复 activate/load 合并；另 6 个 repo 的 scan/Git spy 为零。使用临时仓库，不触及用户项目。raw index 不调 currentNamespace/identity。
- **静止无工作测试**：fake timers 经过多个 2500/1500ms，inactive watch 时零 scan/Git/全列表；活动 run 只轻量单飞 poll，hold response 不重叠；终态后停止，后续终态通知不重复刷新。
- **稳定子进程测试**：真实 OS child A-B-A，PID 保持，token 三次不同；旧 pending read/write/progress/model response 全拒；语言空间同路径切换同样隔离，草稿恢复。
- **授权回归**：跨窗口、子 frame、导航后拒绝；renderer 伪造 workspace/key/project_id；宿主移除项目及快照读失败；root symlink 变化；外部与空 root；child crash/旧 instance；耗尽预算必须显式 retry；mutation 不重放。
- **真实取消测试**：AgentData 队列中取消不 dispatch；运行中取消关闭 loopback HTTP 连接、释放/保持调度槽按既有规则；扫描中 cancel 要在 scan 未结束时被 child 接收并停止剩余工作，不允许仅 Promise reject；页面不覆盖、返回 A 无旧任务复活。
- **UI harness**：只 `npm run ui:check -- repo-wiki`；hold child 数据时检查宿主名称/卡片、选择、局部加载/重试、A-B-A 草稿、生成/停止状态、旧事件过滤、浅色森林绿。不能用 UI I/O 桩宣称后端取消已验证。
- `npm run typecheck:repo-wiki`、相关定向后端/renderer tests、构建、根目录 `npm run verify-notes`。报告实际命令/结果，不跑不相关全量 UI。

## 备选方案

- **仅并发创建 7 项目**：最少改变现有 Project[] UI，可能缩短首等；但仍把磁盘扫描放 activation 关键链，制造并行 I/O 压力且 cancel 不响应，不能满足既定首屏与按需要求。
- **先传假的 Project id，随后替换**：复用当前列表组件最多；但 ID 会流入 schema、路由、草稿缓存与授权判断，placeholder 更替造成新一轮失效。采用独立 HostProjectSummary 更明确。
- **每 workspace 保留一 child**：能让 A-B-A 很快且隔离模型；但增加 7 个 OS 进程/SQLite owner/定时器，掩盖全列表与扫描问题。单 child + context/run lease 足够。
- **全局缓存所有 /project、/changes 响应加长 TTL**：减少轮询代码改动；但旧 branch/identity、人工编辑与变化状态仍可能假新鲜，也不能解决冷启动全部 create。采用事件失效与显式当前项目 load。
- **删除主进程上下文只在 UI 丢旧响应**：实现最短；但旧 renderer mutation/model 请求依然能到后端。必须保留主进程权威 token 与 run origin 校验。

## 本次只读检查边界

已读 AGENTS、项目 write-notes skill 和四篇既有 Repo Wiki 笔记。`rg` 在当前 shell 不可用，使用 Get-Content / Select-String / 受限目录 Get-ChildItem 阅读源码。未运行性能测量、测试或应用；33.48s/30s 是父任务提供的现场数据，不是本报告新增测量。报告属于施工前建议，正式决策由主任务在 `.agents/notes/` 落地。
