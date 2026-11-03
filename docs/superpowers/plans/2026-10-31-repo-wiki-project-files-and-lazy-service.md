# Repo Wiki 项目文件与按需服务实现计划

> **面向 AI 代理的工作者：** 使用 subagent-driven-development，独立文件职责并行实现，交叉边界由控制者统一，测试与审查结果记录到工作区报告。

**目标：** 宿主已有项目即时可见，重任务后台按需执行；项目 Markdown / 元数据 / 计划为事实来源，SQLite 可安全重建。

**架构：** activation 只绑定上下文，当前项目 hydrate 才访问项目文件与启动服务，生成前才取得知识模型 lease。Repo Wiki OS child 保持长驻并隔离上下文，扫描采用可取消异步路径，读取状态不扫描。项目文件采用版本化格式和可恢复提交，按需从只读旧库迁移。

**技术栈：** TypeScript / React / Electron、Node.js 文件系统和 SQLite，保留现有 WikiService / Pi SDK 调度，无新增产品依赖。

**规格：** [决策与验收](../../../.agents/notes/implemented/architecture/2026-10-31-repo-wiki-project-files-and-lazy-service.md)。用户已明确批准实施本方案，不提交或推送。

## 全局约束

- 保留开工时 567 项未提交状态，基线 HEAD 310e57280b58766ad1f67cd5b2ff7e5d61667ee2，工作区记录在 .tmp-repowiki-optimization。
- 不批量扫描、初始化或迁移用户 7 个项目；测试仅使用隔离 fixture，不删除用户缓存或真实数据。
- 不调用付费模型，不重启正在使用的应用，不改变安全设置。
- 项目事实目录为 docs/repo-wiki，扫描强制排除此输出目录。旧 workspace.sqlite3 保持原件，新缓存用不同文件。
- token、宿主登记授权、路径/symlink 校验、旧事件隔离、未保存编辑与冲突保护不能退化。
- 页面 storage_token 与 expected_storage_token、计划 plan_storage_token 与 expected_plan_storage_token 贯穿 UI / contracts / service / core。token 若给为 64 位 hex，嵌入修改请求缺 token 报 409；UI 回传编辑开始的原 token。生成/导入文件提交也做 CAS。
- 扫描单飞按项目/语言/目标/context 隔离，旧 A 取消不影响新 A；每个 run 在 submit 前固定 model lease 的 cacheKey。
- 只跑本需求 repo-wiki UI 场景；全仓既有类型诊断单独报告。

## 审查重点

- 已有同名目录或未完成迁移：不覆盖未知/人工文件，重复执行与恢复保持完整。
- 外部 Markdown 编辑与应用保存竞争：文件 token / revision 检查，不能用旧缓存覆盖。
- 缓存丢失：正文、基线、冲突候选、卡片、计划与 revision 均从项目文件恢复。
- 慢扫描/路径校验：项目首屏不被阻塞，取消后不继续请求模型或写入，不能累积重叠工作。
- A-B-A / 配置切换 / 崩溃：进度属于原请求上下文，模型缓存 key 与实际生成 lease 保持一致。

## 文件与任务

### 任务 1：项目文件存储与扫描核心

负责 core/src/engine.ts、scanner.ts、新 project-files.ts 与相关 core tests；不改 service/process/main/UI。

- [x] 编写并观察失败：项目文件读写、删除 fixture 新缓存重建、旧库按当前项目迁移及重复/失败恢复、外部编辑和不可写目录。
- [x] 实现 hydrate_project(path, language='zh', name?, {signal}={})：只加载当前根、恢复/迁移/轻量初始化，不执行 Git/源码扫描/模型。
- [x] get_project/list_projects/changes 只读元数据与已完成扫描缓存；get_page 识别外部编辑。新增 scan_project(id,{target,signal}) 显式扫描，生成前后调用异步扫描并在提交前检查取消。
- [x] generate 增加第六个可选参数 {signal?:AbortSignal}，保持已有调用兼容；异步扫描使用 scanRepositoryAsync(root, options, signal)。
- [x] WorkspaceEngineOptions.snapshotLegacy?:(from,to,signal?)=>Promise<MigrationResult> 提供可取消快照注入；生产进程使用 Worker，纯 core 旧直接调用可保留原同步迁移兼容。
- [x] 文档 Markdown + JSON 计划/元数据为事实；原旧 DB 保持、新索引另文件。文件提交先成功，索引可重建；迁移冲突和权限失败不吞掉。
- [x] 运行相关 core 回归并落盘 RED/GREEN 日志与报告。

### 任务 2：服务、进程与生成 lease

负责 packages/service、packages/process、contracts 中 process wire/action 扩展及 tests；不改 core/main/UI 或 shared host.ts。

- [x] 编写并观察失败：慢扫描中 health/run/cancel 可响应；同项目扫描合并，取消/超时真实停止后续扫描工作；上下文切换不重启 child。
- [x] create 调 core.hydrate_project，不扫描；changes/project/run 不触发源码扫描；显式 refresh scan 与 generation 才扫描。
- [x] RepoWikiProcessClient 提供 invokeScoped(action,input,{contextId,modelLeaseId?})、registerModelLease(id,{cacheKey,complete}):()=>void、cancelContext(contextId):Promise<void>。
- [x] scoped wire 请求绑定原 context；modelRequest 携带 lease id，使用对应 complete/cacheKey；progress 保留原 scope，不能贴当前 token。生成 lease 必须在 submit 时固定。
- [x] cancelRequest 有真实处理器，AbortSignal 贯穿 async scan/生成；同项目扫描单飞，健康/状态读取不排在扫描任务后。
- [x] 同 host bundle 的 legacy-snapshot Worker 模式复用 migrateWorkspace，复制期间控制 IPC 可响应；取消 await worker.terminate 后才允许 core 清临时目录。真实大旧库 fixture 验证取消后不发布项目文件，旧库不变且可重试。
- [x] 嵌入模式无固定频率全量扫描。watch 使用变化通知/节流合并，产物文件变化不反馈生成；独立模式兼容要求通过相关测试说明。
- [x] 运行 service/process 回归并落盘日志报告，与 core owner 对齐精确接口。

### 任务 3：宿主快照与按需准备

负责 electron/app/repoWikiService.ts、workspaceService.ts、main.ts、repoWikiKnowledgeModel.ts 和相关宿主 tests；拥有 contracts/src/host.ts。

- [x] 失败测试：7 项目快照下禁止调用慢 allowedWorkspaces/模型/child/scanner，activate 仍返回；未授权 hydrate 拒绝。
- [x] HostProjectSummary={key,path,name}，HostProjectsSnapshot={revision,state:'pending'|'ready'|'error',projects,error?}。
- [x] HostActivation={workspace,language,project_id,status:'bound'|'pending'|'empty',context_id,projects_revision}。repoWiki_hostProjects 只读快照，repoWiki_activate 只绑定，repoWiki_hydrate({__repoWikiContext}) 返回 {context_id,project}。
- [x] HostActivationRequest.view_id?:string 每视图挂载独立且该视图重试保持不变；同路径新 view 也新 token，旧响应清理不能撤销新视图。
- [x] repoWiki_release({__repoWikiContext}) 返回 {released:boolean}，只撤销匹配的当前上下文；旧 A 迟到 release 不改变 B，模块卸载取消旧任务且不停止 child。
- [x] WorkspaceService.getProjectSnapshot() 同步读内存；readProjectSnapshot() 仅读宿主登记，不逐项目 stat/realpath。数据操作再核验当前根及登记撤销，renderer 快照不能授予访问权。
- [x] 替换 vendor registration 昂贵的每请求 project 授权预读，保留 schema/窗口/frame/context/project/path 验证。
- [x] 普通切换只取消旧 scope、轮换 token；模型仅 generate 前 resolve，register lease 后 invokeScoped。配置变化仍派发前拒绝旧请求。
- [x] 运行宿主/授权/生命周期回归，记录首屏 API 时间；不访问真实用户项目。

### 任务 4：即时 UI 与非重叠状态更新

负责 RepoWikiWorkspace、vendor web App/Panel/ProjectCollection、runtime fixture、定向 React tests 与 repo-wiki harness/probe；不改 main/service/core。

- [x] 失败测试：服务/模型/文件系统永不返回时，宿主7项与当前项目壳仍立即可见，无全屏同步占位。
- [x] 首帧直接使用宿主已有 registeredProjects / activeWorkspace；HostProjectSummary 单独渲染，不伪造 vendor Project 或其 id。
- [x] 当前项目后台 hydrate，局部显示准备/错误/重试；集合选择复用原宿主打开项目流程。
- [x] 删除固定2.5秒 detail/changes全量刷新；运行中仅串行轻量 run 状态兜底，事件优先，关闭/切换清理。
- [x] 保留原风格、来源/源码/文档/卡片/编辑/namespace/关闭保护；验证 A-B-A、草稿、旧事件、恢复。
- [x] 运行 React/vendor UI 相关测试与仅 repo-wiki 实际 Electron 场景，记录冷首屏测量及截图。

### 任务 5：实际链验收与收尾

- [x] 在隔离 fixture 运行真实 WorkspaceService / RepoWiki child / AgentData child / SDK loopback 链，保持共享并发、配置切换与取消，不付费。
- [x] 集成验证 7 项目首屏不迁移/扫描其他根，后台慢扫描可取消、状态及时返回、同进程 A-B-A。
- [x] 文件迁移/手改/卡片/冲突/删除新缓存重建/重复迁移与失败恢复都有真实文件证据。
- [x] 最终 npm run typecheck:repo-wiki、npm run build、npm run verify-notes，定向 diff 检查与独立审查。
- [x] 更新决策和 AGENTS 场景说明，归档日志/时间/截图/文件清单，分别标注通过、失败、未运行；不提交、推送或重启应用。
