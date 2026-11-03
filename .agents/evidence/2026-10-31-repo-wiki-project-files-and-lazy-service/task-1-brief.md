# Task 1 brief

## 全局约束

- 保留开工时 567 项未提交状态，基线 HEAD 310e57280b58766ad1f67cd5b2ff7e5d61667ee2，工作区记录在 .tmp-repowiki-optimization。
- 不批量扫描、初始化或迁移用户 7 个项目；测试仅使用隔离 fixture，不删除用户缓存或真实数据。
- 不调用付费模型，不重启正在使用的应用，不改变安全设置。
- 项目事实目录为 docs/repo-wiki，扫描强制排除此输出目录。旧 workspace.sqlite3 保持原件，新缓存用不同文件。
- token、宿主登记授权、路径/symlink 校验、旧事件隔离、未保存编辑与冲突保护不能退化。
- 只跑本需求 repo-wiki UI 场景；全仓既有类型诊断单独报告。


## Shared interfaces (frozen)

- [ ] 实现 hydrate_project(path, language='zh', name?, {signal}={})：只加载当前根、恢复/迁移/轻量初始化，不执行 Git/源码扫描/模型。
- [ ] get_project/list_projects/changes 只读元数据与已完成扫描缓存；get_page 识别外部编辑。新增 scan_project(id,{target,signal}) 显式扫描，生成前后调用异步扫描并在提交前检查取消。
- [ ] generate 增加第六个可选参数 {signal?:AbortSignal}，保持已有调用兼容；异步扫描使用 scanRepositoryAsync(root, options, signal)。
- [ ] create 调 core.hydrate_project，不扫描；changes/project/run 不触发源码扫描；显式 refresh scan 与 generation 才扫描。
- [ ] RepoWikiProcessClient 提供 invokeScoped(action,input,{contextId,modelLeaseId?})、registerModelLease(id,{cacheKey,complete}):()=>void、cancelContext(contextId):Promise<void>。
- [ ] HostProjectSummary={key,path,name}，HostProjectsSnapshot={revision,state:'pending'|'ready'|'error',projects,error?}。
- [ ] HostActivation={workspace,language,project_id,status:'bound'|'pending'|'empty',context_id,projects_revision}。repoWiki_hostProjects 只读快照，repoWiki_activate 只绑定，repoWiki_hydrate({__repoWikiContext}) 返回 {context_id,project}。
- [ ] WorkspaceService.getProjectSnapshot() 同步读内存；readProjectSnapshot() 仅读宿主登记，不逐项目 stat/realpath。数据操作再核验当前根及登记撤销，renderer 快照不能授予访问权。

### 任务 1：项目文件存储与扫描核心

负责 core/src/engine.ts、scanner.ts、新 project-files.ts 与相关 core tests；不改 service/process/main/UI。

- [ ] 编写并观察失败：项目文件读写、删除 fixture 新缓存重建、旧库按当前项目迁移及重复/失败恢复、外部编辑和不可写目录。
- [ ] 实现 hydrate_project(path, language='zh', name?, {signal}={})：只加载当前根、恢复/迁移/轻量初始化，不执行 Git/源码扫描/模型。
- [ ] get_project/list_projects/changes 只读元数据与已完成扫描缓存；get_page 识别外部编辑。新增 scan_project(id,{target,signal}) 显式扫描，生成前后调用异步扫描并在提交前检查取消。
- [ ] generate 增加第六个可选参数 {signal?:AbortSignal}，保持已有调用兼容；异步扫描使用 scanRepositoryAsync(root, options, signal)。
- [ ] 文档 Markdown + JSON 计划/元数据为事实；原旧 DB 保持、新索引另文件。文件提交先成功，索引可重建；迁移冲突和权限失败不吞掉。
- [ ] 运行相关 core 回归并落盘 RED/GREEN 日志与报告。


## Execution contract

Read the repo AGENTS.md and proposed decision first. User approved implementation; do not request fresh design permission. Preserve unrelated dirty changes, no commits/push/paid providers, no user app restart. Only edit owned files; coordinate shared boundaries through root. Do not spawn helpers/reviewers. Run RED before product behavior changes, save exact commands/logs and results in .tmp-repowiki-optimization/task-1-report.md, report concise status and concerns. Fixtures only for migration/cache deletion.
