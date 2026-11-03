# Task 4 brief

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

### 任务 4：即时 UI 与非重叠状态更新

负责 RepoWikiWorkspace、vendor web App/Panel/ProjectCollection、runtime fixture、定向 React tests 与 repo-wiki harness/probe；不改 main/service/core。

- [ ] 失败测试：服务/模型/文件系统永不返回时，宿主7项与当前项目壳仍立即可见，无全屏同步占位。
- [ ] 首帧直接使用宿主已有 registeredProjects / activeWorkspace；HostProjectSummary 单独渲染，不伪造 vendor Project 或其 id。
- [ ] 当前项目后台 hydrate，局部显示准备/错误/重试；集合选择复用原宿主打开项目流程。
- [ ] 删除固定2.5秒 detail/changes全量刷新；运行中仅串行轻量 run 状态兜底，事件优先，关闭/切换清理。
- [ ] 保留原风格、来源/源码/文档/卡片/编辑/namespace/关闭保护；验证 A-B-A、草稿、旧事件、恢复。
- [ ] 运行 React/vendor UI 相关测试与仅 repo-wiki 实际 Electron 场景，记录冷首屏测量及截图。


## Execution contract

Read the repo AGENTS.md and proposed decision first. User approved implementation; do not request fresh design permission. Preserve unrelated dirty changes, no commits/push/paid providers, no user app restart. Only edit owned files; coordinate shared boundaries through root. Do not spawn helpers/reviewers. Run RED before product behavior changes, save exact commands/logs and results in .tmp-repowiki-optimization/task-4-report.md, report concise status and concerns. Fixtures only for migration/cache deletion.
