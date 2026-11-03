# Agent Note: Repo Wiki 复用宿主知识调度与项目流程

Status: implemented

## Problem

用户实测发现首版只是把独立 Repo Wiki 接进窗口：模型走应用默认模型的 ModelRuntimeHost 短调用，绕过 AgentData 的 agentDataModel 选择及已在生产使用的 WikiService 全局并发门；项目只预填路径，仍要求手工连接。此前 mock 把 projects 列表预制好，未验证宿主项目登记自动转成 Wiki 项目，掩盖了流程缺口。

## Decision

任务账本与页面所有权现由 [AgentData 持久化任务](../architecture/2026-11-01-repo-wiki-agentdata-durable-tasks.md) 部分取代：生产生成登记 agent_jobs，并由可恢复执行器管理；关闭/切项目只释放视图订阅，原文取消旧生成与“不新增账本”不再适用于生产任务。知识模型、共享并发门、派发前配置校验继续有效。

Repo Wiki 的模型请求经 AgentDataService 的私有知识 completion 端口进入 agentdata-host，在同一 WikiService 实例的动态全局限流器中排队，再沿 AgentDataModelPort / main.model.complete / createAgentDataModelPort / ModelRuntimeHost / Pi SDK 执行。复用实际生产知识库的 agentDataModel 配置和限流实例；不将当前没有生产调用的 TaskQueue / SystemWorkerManager 包装成已经统一的业务调度。新增可取消的私有 IPC、调度时模型身份校验和输入原样转发，保留 Repo Wiki 自己的 JSON 与来源校验，不把请求套成旧 Markdown ingest 任务。

限流器在调整 KNOWLEDGE_LLM_GLOBAL_CONCURRENCY 时保留同一实例及 active / queued 预算。排队取消立即移除，执行中取消穿过双子进程和 main.model.abort；底层完成前仍占原槽。expectedModel 与 expectedConfiguration 贯穿私有 IPC，获取槽位后及实际 SDK 派发前复核。配置身份包含模型快照、SDK getCompatibilityRequestConfig 和 models.json 来源；仅比较裸模型对象无法识别同 ID 的 provider headers 改动，已用真实 SDK 复现后修复。传给 SDK 的模型使用绑定快照，transformHeaders 校验后原样返回 headers，保留 null 删除语义；不记录密钥或原始配置。

宿主 WorkspaceService.listProjects 是项目集合的唯一来源，主进程按规范化 path + language 复用/创建 Wiki 元数据，合并并发同步，避免重入反复扫描。RepoWikiWorkspace 观察 activeWorkspace，原版面板自动选择对应 Wiki 项目，移除嵌入态手工路径/克隆/模型模式设置。补宿主项目登记变化通知，处理 activeWorkspace 先变化而 ensureWorkspace 稍后完成的窗口。

每个可信窗口经 repoWiki_activate 获取当前 workspace / project_id / context_id，后续调用携带 __repoWikiContext。切换时使旧上下文失效、取消旧生成并拒绝迟到结果/事件；同路径语言 namespace 也走权威 activation。真实临时对话 cwd 由 WorkspaceService.isConversationWorkspace 判为 empty，不进入登记重试循环。重复进入不重复建项目，集合页选择其他项目复用 pi.openWorkspace 与 applyOpenedProject。

崩溃恢复由主进程轮换上下文并通知 UI，底层再按物理 child 身份过滤迟到消息；自动重启预算耗尽后只允许显式 retry:true 重建。UI 在上下文重置、A-B-A、退出/重入时保留未保存编辑，关闭保护同时检查缓存草稿。嵌入模式禁用 demo 与 watch 自动生成，扫描只标记 needs_generation。扫描、索引、存储、生成编排继续在独立 Repo Wiki OS child。

## Alternatives considered

- 只把默认模型改成 agentDataModel 改动很小；不用，因为仍绕开已配置的共享并发门和取消路径，无法证明调度复用。
- 改走当前 TaskQueue / SystemWorkerManager 能获得任务表和串行队列；不用，因为源码追踪显示现有 Wiki ingest 并不经过它。另建该路线仍无法与正在运行的知识库共享已配置的限流实例。
- 在前端遍历路径并逐个 create 最省主进程修改；不用，因为 renderer 的项目投影不负责授权，且 create 去重前扫描，登记竞态与重复进入会产生额外工作。

## Behavior

双 OS child 加真实 SDK 的 loopback provider 验证：旧 wiki.ingest 占用 global=1 时 Repo Wiki 等待；排队取消不调用 provider，运行中取消关闭 HTTP 连接并保留原页面。应用默认模型 A 与知识模型 B 不同时请求实际使用 B。排队时模型身份或同 ID provider headers 改变，旧请求在派发前报 MODEL_CHANGED，新绑定发送新 headers 并使用不同缓存身份。

真实 opened-projects.json 自动投影项目，无会话也可出现，不手工调用 create。当前项目切换、空项目、重入、语言 namespace、崩溃后的新实例和旧事件隔离都有对应验证。保留原浅色森林绿、集合/概览/阅读、知识卡片、源码与来源跳转、编辑冲突保护；UI 场景从空 Wiki registry 开始，避免预制列表掩盖同步缺口。

## 验证

先写能复现旧行为的失败测试，再实现。证据位于 `.agents/evidence/2026-10-31-repo-wiki-host-workflow-alignment/`，各组有重叠，不合并为总数：

- 调度回归 19 文件 101 项通过；追加配置贯穿回归 4 文件 27 项通过；模型端口与 ModelRuntimeHost 3 文件 22 项通过。
- 宿主后端 66/66、process client 10/10、独立模式 watcher 4/4 通过；宿主 UI/client 21 项与 vendor UI 71 项通过。这些组的完整输出保留在工具执行记录，目录内报告记录命令与结果，不伪造原始日志。
- repo-wiki 实际 Electron 场景 69 PASS / 0 FAIL，仅运行 1/44 个场景；截图已检查。
- 真实 WorkspaceService → Repo Wiki child → AgentData child → WikiService → 主进程 ModelRuntimeHost / Pi SDK → loopback HTTP 的 1 个工作流、7 组行为通过，耗时 77.49 秒。主 PID 4724、AgentData PID 91152、Repo Wiki PID 62152。无付费调用。
- 实际 BrowserWindow + 正式 preload / IPC 检查自动项目、上下文、跨窗口及导航后拒绝、子进程停止通过，主 PID 60972、child PID 70424。
- 最终 npm run build 与 npm run typecheck:repo-wiki exit 0。根目录 npm run verify-notes 通过；保留原有 6 条旧证据措辞警告。

## Consequences

全项目投影、首屏准备与项目切换重启已由 [项目文件与按需服务](../architecture/2026-10-31-repo-wiki-project-files-and-lazy-service.md) 取代；真实知识调度、配置身份与上下文隔离约束继续有效。当前模型变更守派发前身份，已经派发的 HTTP 不因设置变化自动中断，明确取消仍传递 abort。

旧工程没有统一覆盖所有 AI 功能的公共调度服务，本次明确复用实际知识库调度，不宣称交互会话或闲置 TaskQueue 全部统一；未新增 service_tasks 账本或自动重放。旧 Wiki ingest 的数据库所有权不变，主进程与 Repo Wiki child 不打开 agent-data.db。

Repo Wiki 模型桥单次 120 秒总预算包含共享队列等待，超时会取消，不能无限排队。全工程 tsconfig.node 检查仍有 150 条既有诊断，本次相关源码的严格 RepoWiki 工程通过；没有将定向通过表述为全仓类型检查通过。未生成安装包，未提交、推送、发布，未调用用户付费模型。
