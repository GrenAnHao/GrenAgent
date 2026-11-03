# Agent Note: Repo Wiki 项目文件事实来源与按需服务

Status: implemented

> **适用范围更新（2026-11-02）：** 本篇涉及的生成权威、依赖图、预算、全页发布与恢复合同适用于 legacy Wiki / 知识卡及其历史任务；不把它们作为 `qoder-wiki-local-v1` 的合同。native Wiki 的独立服务、部分发布和兼容边界见 [原版内核变更](../../proposed/architecture/2026-11-02-qoder-repowiki-native-replica.md)；该变更仍待整合和用户验收，旧任务不自动升级。原有历史证据仅证明当时的版本。

## Problem

当前接入在首次展示前同步所有宿主项目，等待模型描述与 Repo Wiki 子进程；缺失项目记录先扫描源码。页面每 2.5 秒查询 changes 又执行全扫描，轮询可重叠；watch 定时器在筛选开关前读取全部项目并重复 Git。实际本机 7 个宿主项目根目录核验每项仅 0.6–2.7ms，首次 activate 却需 33.48 秒，后续查询持续约 30 秒。单 RPC 超时未停止子进程扫描。

文档、人工修改、生成基线、冲突候选、计划和项目元数据当前只在 userData 的 workspace.sqlite3，无法按项目携带，缓存丢失也会丢唯一数据。用户已批准把项目文件作为事实来源，并解耦首屏和重任务。

## Decision

本篇“切项目/关闭即取消生成”的视图生命周期约定已由 [AgentData 持久化任务](2026-11-01-repo-wiki-agentdata-durable-tasks.md) 取代：视图 token 仍隔离授权和订阅，生成使用稳定任务 context，离开页面继续后台执行，应用重启自动续跑。文件事实源、CAS、按需准备与轻量首屏继续沿用本篇。

Renderer 直接复用宿主已有项目状态，首屏不等模型、文件系统核验、Repo Wiki 服务或扫描。activation 只建立可信窗口的工作区上下文与令牌；实际读取/修改前另做当前项目授权并按需准备。集合来自宿主，Repo Wiki 不维护另一套可见项目来源。其他 6 个项目不在首屏逐个扫描、初始化或迁移。

Wiki 文档、计划和元数据保存于项目内 docs/repo-wiki，使用固定目录和版本化格式；Markdown 是文档正文，元数据保留 revision、来源、生成基线与冲突候选。现有 .pi 和 .gren 都有忽略/运行时目录约定，因此选可见、可版本管理的 docs 目录；scanner 必须排除产物，避免递归摄入。SQLite 改为独立新索引文件，只缓存项目文件投影、检索和生成缓存；删除测试索引后能从项目文件恢复全部文档与人工编辑。

仅当前需要的项目按需从旧 DB 迁移。旧 DB 原件保持，新的缓存使用不同文件。迁移采用暂存、校验和完成标记，重复执行幂等；已有非本工具文件或不同正文不覆盖，返回可恢复冲突。提交文件失败或无写权限明确报错，不能只落 SQLite 后宣称保存成功。读取项目文件要识别外部 Markdown 编辑并保留，不以缓存覆盖事实来源。

Repo Wiki 独立 OS 进程继续拥有扫描、生成编排和索引缓存。普通切项目只切上下文、取消旧任务、隔离旧事件，不必停止整个进程。模型绑定推迟到生成前，继续使用 AgentData / WikiService 共享调度与派发前配置校验。只读状态不启动全扫描；显式扫描合并同项目工作，必须可取消并保持 IPC 响应，超时不留下不断追加的任务。

## Storage and cancellation contract

页面返回 storage_token，项目返回 plan_storage_token；edit / resolve 接收 expected_storage_token，plan 接收 expected_plan_storage_token。给定 token 为 64 位 hex；嵌入服务缺预期 token 时返回 409 要求重新读取。UI 保存编辑开始或计划打开时的原 token，不能用后台刷新后的新 token 覆盖。直接 core / 非嵌入旧调用可保留可选参数兼容，但每次写仍先核对磁盘内容并使用跨 namespace 持久递增 revision。生成和导入提交也比较开始时读到的文件 token。

可恢复 journal 保留独立 before 备份；恢复遇未知内容时阻断该项目的应用读写并报告冲突，不能将混合提交结果伪装为成功。扫描单飞至少包含项目、语言、目标与 context；旧 A 取消不影响新 A。每个生成 run 在 submit 前固定 model lease 和 cacheKey，模型响应与进度始终属于原 context。

模块每次挂载持有独立 view_id，并在该视图的所有 activation 中保持不变；同路径重挂载的新 view 也取得新 token，避免旧 activation 响应迟到后清理新视图。模块卸载使用携带原 token 的 repoWiki_release，仅匹配当前上下文时取消并释放；旧 A 迟到清理不能撤销 B。普通离开不停止 Wiki child，生成 lease 在终态、取消、上下文释放及 stop 时释放。

生产 child 的旧库 copy-first 快照在可终止 Worker 中复用既有 migrateWorkspace 算法，保持控制 IPC 可响应；取消等待 worker 结束后再清理临时目录，避免 Windows 打开句柄与恢复冲突。沿用同一 host bundle 的 worker 模式，不增加打包资源。常规项目文件提交属于有 journal 的原子提交阶段，不能以请求超时跳过文件提交校验。

磁盘 project.json.id 保留可携带的 portable 身份；公开运行/缓存 id 按规范化 workspace、language 与 portable id 派生，复制文档到另一克隆不能覆盖缓存中的原项目。磁盘身份变化时旧运行 id 的修改请求返回 409，明确 hydrate 后才能绑定新身份。显式导出刷新当前事实文件，普通状态查询继续只读缓存。

Windows 对 docs/repo-wiki 产物路径统一大小写折叠排除，覆盖枚举、Git 身份、删除检测、来源读取和 watch；原生 watcher 的祖先目录 change 重复通知不触发重新扫描，文件及 rename 事件仍保留。派生 generation_cache 的坏 JSON 按 miss 处理；事实文件已发布但 SQLite COMMIT 失败时明确返回“文件已保存，索引更新失败”的可恢复错误，不回滚或覆盖事实文件。本轮不增加损坏缓存的自动隔离/删除，明确报错后可从文件重建。

宿主快照只负责展示与登记身份，数据访问仅实查当前根；canonical 结果必须匹配既有授权，symlink 改指向不能自动扩权。未知/失败快照不授予访问权，且不能在首屏重新遍历所有根。

## Historical note audit

- [独立进程接入](../../implemented/architecture/2026-10-31-repo-wiki-process-integration.md)：部分重叠，独立 OS 进程、构建打包和许可理由仍有效；存储事实来源由本篇更新，两篇互链，不归档。
- [宿主工作流修正](../../implemented/bug-fix/2026-10-31-repo-wiki-host-workflow-alignment.md)：部分重叠，真实 WikiService 调度、上下文、草稿及配置身份仍有效；全项目投影、首屏等待和切项目重启由本篇取代，保留原验证边界。
- 两篇 Windows Git / HTTP / WAL 笔记：独立兼容约束，仍有效。

## Alternatives considered

- 只延后 SQLite 查询和提高超时可以少改代码；不用，因为未解除全项目扫描和持续重叠，也没有文档可恢复的事实来源。
- 仅将 DB 定期导出 Markdown 可以迅速得到可读文档；不用，因为人工编辑与计划仍只归 DB，文件不是事实来源，缓存重建仍可能丢数据。
- 使用 .pi/repo-wiki 或 .gren/repo-wiki 可复用隐藏运行时目录；不用，因为本仓 .pi 被整体忽略，.gren 也按工作区内部状态隐藏，不利于文档随项目保存与版本管理。
- 首次升级迁移全部已登记项目可一次完成格式切换；不用，因为用户明确要求按需迁移，且会重新产生首屏串行 I/O 和项目写入。
- 活动期间持续检查模型并在设置变更时终止已派发 HTTP，能更快停止旧配置请求；本轮采用每个 run 固定模型 lease、派发前校验与明确取消入口，使设置保存不异步打断已授权的在途请求。旧配置不会写入新模型缓存，后续旧配置派发会被拒绝；该边界不能表述为所有旧轮询重启语义都保留。

## Behavior

7 个宿主项目在模型不可用、服务未启动、慢文件系统或扫描进行中仍可直接展示。生产渲染夹具从模块点击到 7 个摘要和当前项目壳可见为 318.8ms，期间故意阻塞 activation / host snapshot；真实隔离七项目 activation 为 7.576ms，未做模型解析、逐根授权 I/O 或启动 child。这与此前 OneDrive 现场 33.48 秒样本的时点/数据不同，不作为同环境倍速结论。A-B-A、关闭、取消、旧事件、同路径重挂载和人工草稿保护均有回归。

隔离 fixture 验证旧文档、人工修改、冲突候选、知识卡片与计划迁移；重复执行、半途失败恢复、未知目标冲突、fsync / COMMIT 故障及权限错误不丢事实。删除新缓存后文档、revision、portable 身份与运行身份恢复。七条旧项目记录只发布当前根，其他六根不建知识目录，旧库字节不变。真实知识调度继续共享预算、模型配置与取消，最终 provider 为 loopback，不调用付费服务。

## 验证

先观察关键 RED，再实现并验证。证据位于 `.agents/evidence/2026-10-31-repo-wiki-project-files-and-lazy-service/`，各组重叠，不相加为总数：

- core 全套 7 文件 144 项通过；后续身份、Windows 排除、导出及缓存故障修复涉及的 5 文件 98 项再次通过；快照 hook 的 15 项定向通过。原有语义断言保留，旧隐式 scan 测试改为显式 scan / hydrate。
- 实际 Electron-as-Node 的 service / process 68 项通过，后续 Windows watcher 24 项与权限边界 2 项通过。约 50MiB 旧库验证 Worker 复制期间控制可响应、取消不发布、原库不变、同 PID 重试与 stop 清理。
- 宿主相关 65 项通过，view ownership 23 项与测试类型边界 19 项再验通过；同路径迟到 activation / release 的 RED 已保留。
- React 30 项、vendor UI 71 项、实际静默 Electron repo-wiki 76 PASS / 0 FAIL；只跑 1/44 个场景。六张截图已检查。
- 最新实际 WorkspaceService / Repo Wiki child / AgentData child / WikiService / ModelRuntimeHost / Pi SDK 回环集成 3 文件 12 项通过，6.90 秒。扫描期间 health / run 11.427ms；超时后重试成功，取消后模型调用为 0。源码指纹与性能 JSON 关联。
- `npm run build` 和 `npm run typecheck:repo-wiki` exit 0。实际生产 bundle 放入 app.asar.unpacked 形式路径后 Worker 迁移、人工文件保存、旧 token 拒绝、同 PID 重进与停止通过，child PID 46732、父 PID 66948，模型调用为 0。
- 独立规格/质量审查通过，三项 Important 全部修复，42 文件最终 SHA 核对无差异。最终笔记门禁与定向空白检查通过。

## Consequences

多文件落盘增加 journal / token / 恢复代码；通过项目文件获得可携带、可重建和可检查的数据。Windows rename / 权限 / OneDrive 失败会明确报错，部分提交未知内容保留备份并阻断该项目读写。外部程序不参与本工具锁时，不能宣称具有跨任意编辑器的内核级 CAS。普通读取显示上次已检查分支和状态，统计后台补齐。

配置变更拒绝后续旧配置派发；已派发 HTTP 不仅因设置改变而主动 abort，明确取消、切项目、关闭仍真正传递 abort。新缓存损坏会明确失败，原事实文件保留，本轮不做自动 quarantine / 删除；可以重建缓存。纯 core / standalone 直接 API 仍保留同步迁移兼容 fallback，GrenAgent 生产 child 必须使用已验证的 Worker 注入。

全工程 Node 类型检查仍有 150 条原有诊断，本次新增的两条测试 fake 类型问题已修掉；实际 Repo Wiki strict 工程通过。没有重启用户实例、扫描/迁移真实七项目、删除用户缓存、付费调用、提交、推送或发布。原有无关 dirty 内容保留。
