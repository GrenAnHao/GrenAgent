# 完整复刻执行记录

## 目标与边界

- 用户已明确 apply `replicate-qoder-repowiki`，规划位于 `openspec/changes/replicate-qoder-repowiki/`，schema spec-driven，初始 0/41 项。
- 固定 Qoder 0.5.1/context 1.0.91.b22f2d0a revision2026102902 的可见本地合同；native engine `qoder-wiki-local-v1`，不是再次借用旧页面 DAG。
- 最初仅准编写用例与静态审阅。用户本轮已授权离线 CLI、定向类型检查及临时知识 child 构建；仍禁止 UI/Qoder/付费模型、桌面重启及真实任务操作。未完成的界面/供应商验收不能因 CLI 通过而打勾。
- 禁止操作真实任务/数据库、提交/推送/发布、凭据读取或清理其他改动。使用现有脏工作区和当前 codex/repo-wiki-knowledge-kernel 分支，不能通过干净 HEAD/worktree 覆盖未提交的真实基线。
- 现有大量 RepoWiki 源码是未跟踪工作，必须作为当前基线保留；review 使用此次改动前文件副本和定向 diff，不把所有未跟踪文件当成本次新增。

## 所有权

- root：整体合同、主进程/AgentData/worker 接线、整合、OpenSpec tasks 打勾与用户交付。
- 执行者使用 GPT-6.1 Terra；独立审查用 Sol。只并行不同写区，服务状态机/存储由一个 owner 完整负责。
- 具体任务交付和接口随后记在本记录，收到 valid 结果后直接交消费者，不重复生产者工作。

- native_reference_terra：已交 reference/**、12 模板/公共纪律、动态渲染、用途解析/配置、未执行完整夹具、ISC 许可及收集器接线；另交 native UI/合同、手册和离线 workflow 夹具。
- native_store_terra：contracts/store/service 及测试；稳定接口已交root/engine，admission/model/files/outbox消费者由root接线。状态机写区不由其他owner修改。
- native_engine_terra：fullGeneration/incremental/runner/authorConfig/sessionRuntime/repositoryTools/repository及测试，消费reference和store接口；root主进程SDKadapter与runtime/repo接线独立进行。

## 已批准的规格纠正

原版QUn增量目录分析还提供SearchWiki/ReadWiki。用户已明确选择完整补齐：只读本运行冻结priorCatalogue/priorPages，仅此purpose挂载，不写入/不跨项目/不增加外部访问。root已同步proposal/design/prompts spec/tasks3.3；参考owner交schema，engine owner注册纯快照工具，其他purpose仍只有四个源码工具。

## 验收含义

代码完成、静态审查、尚未执行的夹具、CLI 固定 provider、用户界面/供应商测试是不同状态。此前静态交付没有新引擎运行证据；现已运行临时仓库的真实子进程生成/发布/读回，最新结果见末节。它不代表真实供应商或用户项目已验收。

## 主代理整合结果

- native host 复用既有 repo-wiki-host 的独立 RPC；main 批准模型桥与 AgentData 共享并发门/目标锁已接入，native 服务是唯一运行 owner。
- NativeWikiController 处理新版确认、完整输入幂等、selected operation / revision / model / author / scope 绑定；切换页面只释放视图，不取消 native 业务。撤权会暂停派发，已登记 owner 的释放不依赖被撤销的读取权限。
- SQLite publication 先提交，轻量分页 outbox 再消费任务和 ProjectFiles 投影；成功页三方合并、失败页和旧草稿保留，只有显式删除才归档。历史被替代 publication 不可反向覆写新文件。
- 新旧版本共享目标排他；本项目作者配置使用 revision + token CAS、branch 归档；显式保存 native 配置写 schema 2 供旧 reader 拒绝接管。native 停用仍能读取；项目身份 registry 使文件 hydrate 异常时可进入 native 只读壳。
- 原版目录 parent/ordinal/sectionName 被投影到阅读树；源码引用由正文持久 engine 决定，不依赖暂态面板选择。默认概览与 native 任务详情区分 published / readable / failed / partial / projection。
- 费用策略独立于 150000 context：新任务可设累计请求/Token 上限；repair/resume 保留历史与上限。页面、排队、provider 调用在途和工具计数来自持久事件，不冒充真实 wire HTTP 包计数。
- 根入口与文件适配另有未执行定向 fixture；manual-only workflow 使用临时仓库与固定内存模型，不含网络/凭据回退，不冒充完整双进程或真实进程崩溃的已运行证据。

## 交付材料

- `docs/repo-wiki-qoder-reference.md`：reference / host-adapter / unknown 与来源。
- `docs/repo-wiki-native-manual.md`：用户自行构建、用例、本次定向 UI 场景、真实模型、停止及回滚步骤。
- 本目录 `reference-report.md`、`engine-report.md`、`store-report.md`、`native-ui-report.md`：分区交付与接口。
- 本目录 `native-static-review.md`：独立 Sol 静态审查、具体问题及回修结果；包括新任务详情与仍被发布/恢复引用任务的删除保护。当前静态审查范围没有未解决的确定发现。

未执行 `verify-notes`、类型检查、测试、构建、UI、应用重启或任何模型调用；用户未授权这批自动运行，也没有新 native 真实闭环证据。OpenSpec 8.3/8.4 必须保持未完成，未提交/发布/归档。

此前 OpenSpec 曾记录代码交付 39/41；这没有覆盖正常入口仍使用旧 v2 的实际缺口，不是生成验收证据。2026-11-03 已重开受影响的接线、状态、兼容、文档、夹具及静态审查项，按实际返修结果重新交付。8.3（用户手动构建/类型/用例/UI）与 8.4（用户授权真实模型验收）继续保持未完成。

## 2026-11-03 正常入口纠正

- 用户要求 Qoder 的流程成为实际使用路径，停止继续给旧 v2 加预算补丁。根因是此前 native 只有第二入口，正常概览/生成/重试仍读取旧 KnowledgeKernel。
- 正常宿主 Wiki 概览嵌入 native 面板，默认 auto 配置在用户点生成时按需保存，再 prepare→确认→start；旧任务的状态/事件不覆盖 native，cards 仍使用原合同。旧任务/九份草稿显式只读，不自动迁移或续费。
- start 先持久 native operation，完成 AgentData 任务投影后才允许 dispatch，返回实际 task_id；项目活动按 native projectId/workspace/language 归属。旧 knowledge 查询只筛 metadata.repoWiki.key，native.metadata.nativeWiki 不遮蔽旧任务。
- 新增 `repo-wiki-primary` 场景及后端未执行断言，覆盖主入口、task_id、旧历史、A→B、发布读取刷新和投影失败同请求重试。源文件修改前副本位于 `../2026-11-03-qoder-primary-entry/preimage/`。
- Sol 独立静态审查发现并交回 Terra 返修：新运行被旧 operation 查询锁住；native 发布后外层目录/正文未刷新；同项目页面切换可能丢弃一次性项目刷新。当前返修与复核记录见 `../2026-11-03-qoder-primary-entry/review.md`。
- 本次没有构建、测试、应用载入或模型调用，不改真实任务、数据库、费用上限或历史成果；新入口源码不能代表当前旧进程已更新。

本次返修后的代码/静态交付重新登记为 39/41，剩余仍仅 8.3/8.4 人工验收；不是沿用旧勾选证明入口可用。原有 `RepoWikiWorkspace.test.tsx` 的受影响用例已同步，未删除旧 cards 合同覆盖。Sol 的三项具体发现均已回修并定向复核；新构建是否通过、真实 SDK/模型生成及正式发布阅读仍无运行证据。

## 正常概览的界面回修

用户随后提供实际载入截图：native 入口虽已切换，但显示成贴左的 HTML 调试表单。原 `NativeWikiPanel` 未复用既有产品布局/antd 控件；这张截图是界面退化的运行证据，不是新生成失败。现已恢复既有居中概览/状态卡/语言分段/森林绿主动作，其他动作收进更多菜单，费用/作者 JSON/运行详情折叠。native RPC、业务生命周期、任务投影、外发确认和原上限保留；主按钮仅按 native 状态选择实际动作。

本次只由主代理静态对照源码、样式和调用方；未运行任何 UI/构建/模型，也没有回修后的截图，不把此前 Sol 的接线审查当成此次视觉证据。修改前源码、用户截图及未执行的定向 probe 说明见 `../2026-11-03-repo-wiki-overview-ui/README.md`。7.3 在补齐代码与 probe 后重新登记，8.3/8.4 继续未完成。

## 首次生成的公共校验冲突

用户接着报告 `Unexpected request property`。根因不是模型：renderer 的公开 `validateRequest` 在通过 native 专用规则后，又用缺少 token/费用字段的旧 native 字段表拦截；旧 CAS 格式还与 native 首次保存的空 token 冲突。现已将 native 字段/令牌校验集中于其专用 validator，公共 action/对象/序列化/8 MiB 保护及旧接口规则保持。

新增未执行的公开入口/renderer adapter 回归，并把现有合同用例接入 Repo Wiki 专用 Vitest 配置，避免用例仅落盘却不被既有入口收录。详见 `../2026-11-03-repo-wiki-native-request-contract/README.md`。本次没有执行验证、构建、重启或模型；7.1 的代码接线修正重新登记，人工验收继续未完成。

## 用户授权后的 CLI 全链实跑

用户要求不再逐个 UI 报错修复，而是检查首次生成到发布并提供一条快 CLI。现已交 `npm run test:repo-wiki-flow`：前置 Repo Wiki tsc、构建临时知识 child，通过真实公开请求/main/Node child/SQLite/ProjectFiles/任务视图；固定 provider 与本地 AgentData RPC/slot 是明确替身。四种源码工具实际执行，任务身份与公开页面/磁盘逐字核对。

本轮实跑查出并修正外部 Qoder 输出误入源码、旧预检 source pin 的后续失败、TaskView 项目 ID 丢失以及三处类型推导缺口。root/ Terra 跑最终命令 9 文件48项通过，定向类型检查和 child 构建通过，总34.12秒；Sol 独立只读审查无阻断。原始日志和逐层覆盖/不覆盖见 `../2026-11-03-repo-wiki-cli-flow/REPORT.md`。旧段落中的“未运行”是各次静态交付时的记录，不能倒写成当时通过。

只构建测试 child，没有构建/重启桌面、运行 UI 或真实模型，没有更改用户任务/数据库。当前8.3的桌面/UI及8.4的真实模型部分继续未完成，CLI与类型检查结果已单独记录。日常约定已接入AGENTS，逻辑改动先跑CLI，视觉改动才追加对应UI场景。
