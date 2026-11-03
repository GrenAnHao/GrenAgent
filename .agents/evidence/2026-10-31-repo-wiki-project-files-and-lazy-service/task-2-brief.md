# Task 2 brief

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

### 任务 2：服务、进程与生成 lease

负责 packages/service、packages/process、contracts 中 process wire/action 扩展及 tests；不改 core/main/UI 或 shared host.ts。

- [ ] 编写并观察失败：慢扫描中 health/run/cancel 可响应；同项目扫描合并，取消/超时真实停止后续扫描工作；上下文切换不重启 child。
- [ ] create 调 core.hydrate_project，不扫描；changes/project/run 不触发源码扫描；显式 refresh scan 与 generation 才扫描。
- [ ] RepoWikiProcessClient 提供 invokeScoped(action,input,{contextId,modelLeaseId?})、registerModelLease(id,{cacheKey,complete}):()=>void、cancelContext(contextId):Promise<void>。
- [ ] scoped wire 请求绑定原 context；modelRequest 携带 lease id，使用对应 complete/cacheKey；progress 保留原 scope，不能贴当前 token。生成 lease 必须在 submit 时固定。
- [ ] cancelRequest 有真实处理器，AbortSignal 贯穿 async scan/生成；同项目扫描单飞，健康/状态读取不排在扫描任务后。
- [ ] 嵌入模式无固定频率全量扫描。watch 使用变化通知/节流合并，产物文件变化不反馈生成；独立模式兼容要求通过相关测试说明。
- [ ] 运行 service/process 回归并落盘日志报告，与 core owner 对齐精确接口。


## Execution contract

Read the repo AGENTS.md and proposed decision first. User approved implementation; do not request fresh design permission. Preserve unrelated dirty changes, no commits/push/paid providers, no user app restart. Only edit owned files; coordinate shared boundaries through root. Do not spawn helpers/reviewers. Run RED before product behavior changes, save exact commands/logs and results in .tmp-repowiki-optimization/task-2-report.md, report concise status and concerns. Fixtures only for migration/cache deletion.
