# RepoWiki 宿主流程二次修复只读审查

日期：2026-10-31。只审查本次宿主知识调度、项目同步、上下文及 UI 契约，不评价工作区大量无关未提交改动。未修改产品代码、未运行测试、未派子代理。以下结论来自当前源代码及既有测试的静态核对；后续父线程修复和验收结果需另行补记。

## 结论

- **规格合规：暂不通过。** 已实接生产 WikiService 的同一全局限流器，自动项目投影和普通 workspace 切换主路径成立；但 scratch 空态、真实子进程恢复、语言命名空间回到集合仍存在流程缺口，同 provider/id 配置变更尚未进入执行时身份校验。
- **质量：需要修复后复审。** 取消路径和旧上下文防护整体清晰；UI fixture 在空态和子进程恢复两点上提供了生产并不存在的行为，现有 UI 绿色结果不能证明这两个真实后端契约。本文没有重复运行父线程已有测试。

## 必须修复

### 1. 普通对话 scratch 永久停在同步中，而非宿主空态

位置：`electron-agent/electron/app/repoWikiService.ts:213-235`；`electron-agent/src/features/repoWiki/RepoWikiWorkspace.tsx:28-33`。

`activate` 对所有非空 workspace 建立 `loading` 上下文。宿主 `WorkspaceService.rememberProject` 明确排除 `worksDir` 下的普通对话（`workspaceService.ts:340-342`），因此 scratch 永远不可能出现在 `syncProjects` 结果中，`activate` 也没有把这种确定的非项目转换成 `empty`。真实应用 activeWorkspace 是非空 scratch cwd，Workspace 于是每 750ms 重试，App 一直显示“正在同步宿主项目…”，连其他已打开项目的集合也被加载分支遮住。

现有真实后端测试反而锁住了错误结果：`repoWikiHostProjects.integration.test.ts:121-123` 对 `createConversation().cwd` 期望 `loading`，再手工 `activate(null)` 才期望 empty。真实 UI 没有该 null 转换。与此同时 UI fixture `testing/runtimeFixture.ts:73` 直接给 scratch 返回 empty，测试与真实后端不一致。

应由可信宿主区分“项目尚待登记”与“普通对话目录”，保留前者的登记重试，使后者进入可操作的集合/空态；不要把所有未登记路径立即登记为批准项目。

### 2. 真实 RepoWiki child 崩溃恢复后，新实例的实时进度全部被拒

位置：`electron-agent/vendor/repo-wiki/apps/web/src/App.tsx:615-627`；`packages/process/src/client.ts:184-191`；`electron-agent/electron/app/repoWikiService.ts:332-335`。

App 的 cursor 第一次接受 instance_id 后，就拒绝任何不同 instance_id，直到 client prop 改变。真实 ProcessClient 的 crash restart 复用同一个对象；RepoWikiService 没有订阅其生命周期，也不轮换 context_id / 发布宿主工作区刷新。Wrapper 的 client 也因此不变。恢复 child 使用新的 instance_id、从 1 开始的 sequence，所有后续 progress 都被旧 cursor 拒绝。轮询可以晚些改 run，但实时进度路径永久失效。

UI fixture 的 `restartChild`（`testing/runtimeFixture.ts:140-146`）却主动更新 contextId 并发送 workspaces 事件，这一可信握手在生产没有实现。因此相关 UI 测试不覆盖真实恢复行为。应基于可信 supervisor 生命周期完成新实例握手及 cursor/context 轮换，同时继续拒绝旧实例、旧事件；不宜无条件接受任意不同 instance。

### 3. 语言切换更新 main 当前 project_id，却没有同步宿主 UI 上下文，回到集合会打不开项目

位置：`electron-agent/electron/app/repoWikiService.ts:148`；`vendor/repo-wiki/apps/web/src/App.tsx:695-700,742-764`；`workspace/ProjectCollection.tsx:85-109`；`src/features/repoWiki/RepoWikiWorkspace.tsx:65-70`。

触发：宿主 A 当前 zh → 在面板切文档语言到 en → 返回项目集合 → 再点 A。

语言 create 成功后 main 把同一个 context 的 project_id 改成 en；App 自己 routeTo(en)，但 RepoWikiWorkspace 的 activation.project_id（从而 hostContext.projectId）仍是旧 zh。集合每仓库优先显示 zh 变体。点击时 `switchProject` 发现该 zh id 等于过期的 hostContext.projectId，就直接 routeTo(zh)，随后的 project/page 请求被 main 以“不是当前 host project”拒绝 403。如果 activation 因其他刷新已变成 en，点击 zh 则调用 onSelectWorkspace，而同路径在 `openWorkspace` 直接返回，UI 没有路由变化。

这是一条可见的原有阅读能力回归，不能只靠后台语言复用测试通过来证明。需要统一当前命名空间选择：语言切换同步更新可信 hostContext，集合重新进入时使用该仓库的当前变体，或通过明确的可信选择接口切换变体。

### 4. 缓存配置 revision 未参加执行校验，同 provider/id 的新配置可写入旧 cacheKey

位置：`electron-agent/electron/app/repoWikiKnowledgeModel.ts:18-26`；`electron/agentData/wikiEngine/service.ts:411-420`；`electron/agentData/createAgentDataModelPort.ts:13-19`；`electron/main.ts:352-357`。

resolver 的 cacheKey 包含 models.json / agentDataModel 的 configurationIdentity，但传到调度器和最终模型端口的 expectedModel 只有 provider/id，两层校验也只比较这个字符串。旧绑定的任务等待共享限流时，若同 provider/id 的 endpoint/请求参数等配置已经 refresh，而 RepoWiki 的定时/显式 configuration refresh 尚未停掉旧 child，这个任务会使用新配置并把生成内容归到旧 cacheKey。两秒轮询不是执行时原子保障。

应把 opaque 配置 revision 传入并在实际 provider dispatch 使用同一解析结果校验，或锁定与 cacheKey 对应的完整请求配置快照。现有测试只证明新 resolver 调用会产生新 key、以及 provider/id 改变会拒绝；没有覆盖“相同 provider/id、配置 revision 改变、旧任务已在队列”的窗口。

## 已确认符合的部分

- `AgentDataRuntime.start` 仅构造一个生产 WikiService（runtime.ts:127）；`completeKnowledge` 调用该实例（:347）。旧 ingest 将 `this.globalLlmLimit()` 传到 `runIngestIncremental`（service.ts:1374-1378），新 completion 也使用同一字段（:409），不是闲置 TaskQueue 或另建限流通道。
- `createRefreshingLimit` 保持一个 scheduler、active 与 queue；配置变化只更新 max，不换 limiter（concurrency.ts:45-50,60-100）。排队 signal 会移除队项；运行中槽位直到 fn settle 才释放（:80-85）。
- 模型原始 systemPrompt/user/maxTokens 经 llm 第四参数 → runtime completeSimple → AgentDataModelPort → main.model.complete → shared main ModelRuntimeHost；RepoWiki JSON 仍留给 child 校验。
- 取消从 RepoWiki ProcessClient 的 AbortController → AgentDataService 私有 knowledge.cancel → runtime controller → host model reverse RPC `main.model.abort` → main provider signal。runtime.close 也 abort knowledgeCalls 并等待 inFlight 清零；main agentdata-host exit abort 当前 modelCalls。
- WikiService dispatch 和 main 模型端口两层 provider/id checks 存在，能够防止排队后切换到另一个 provider/id 时污染旧模型缓存（配置 revision 限制见发现 4）。
- WorkspaceService 的 registry queue 串行化 list/remember/forget，落盘后发布变更；main 订阅后调用 onHostProjectsChanged。项目批准源仍是宿主 `listProjects`，renderer activate 的路径没有授予额外根权限。
- host `syncProjects` 对 canonical path+language 先查再 create，合并并发 projection/create；重入不需 renderer 手动 create，也不会自动 generate。
- workspace 切换在 await 前 retire 旧 client 和 context；request token、AsyncLocalStorage context、client identity、前端 scope/client wrapper共同覆盖 A→B→A 的旧响应/事件。空 approved roots 不启动上游“空列表即无限制”的 child。
- embedded child 禁 demo provider，并将 automaticGeneration 关掉；watch 只检测变更、不自动调用模型。
- 组件没有以 workspace key 强制重挂；App 缓存跨项目编辑草稿，并在模块离开 guard 中保护缓存草稿。

## 恢复修复时一并核对的边界

- `ProcessClient.start` 的物理 child message 回调（client.ts:134-159）没有检查 `this.child === child`，自动重启又复用 supervisor 对象。新增生命周期轮换时，必须在入口拒绝旧物理 child 的迟到 event / modelRequest，避免把旧事件重新贴上新 context。
- ProcessClient 达到 maxRestarts 后要求创建新 supervisor（client.ts:75-80,193-199），而同配置 ensureConfiguration 原样返回旧 client。应在可信 failed 生命周期中退休旧 supervisor，或提供明确的重试动作，避免同 workspace 永久 503。
- App 的 project effect 依赖 request（:554-612），request/client/token 改变时会从 draftCache 重置 editing。当前正在编辑的草稿只在 workspace/project/status 转换的 layout effect 中缓存。若修复恢复流程时仅轮换同 workspace、同 project、ready 状态下的 token，可能直接丢失当前 dirty editor；需先缓存或明确保留编辑状态并加场景。
- hostComplete 的固定 120000ms（child.ts:45-48）现在包括知识队列等待。队列超过两分钟会取消尚未调用 provider 的请求。应明确这是整体等待预算，或有意调整队列/执行超时策略；不能声称无限等待共享队列。

## 审查限制与后续证据

未运行任何额外测试，没有真实 provider 或 UI 操作。父线程提供的已通过调度/模型/后端测试及正在收敛的双 OS child + SDK loopback 验收，本文没有当作独立实跑证据。修复以上边界后，应更新对应的定向后端/契约/UI 场景，特别是让 fixture 与真实 activate/lifecycle 契约相同。没有权限或工具阻塞。

## 最终定向复核（取代上面的初审结论）

复核对象为父线程宣布冻结后的本轮产品源。仅重新阅读对应源和已保存证据，没有重新运行测试或修改实现。

**规格合规：通过本次限定范围的定向复核。质量：通过，未发现仍阻断本轮交付的问题。** 初审四项问题以及 physical child、failed retry、dirty token 三个补充边界均已闭合；以下为逐项依据。

| 初审项目 | 冻结源码中的修复 | 已存证据 |
| --- | --- | --- |
| scratch 永久 loading | `WorkspaceService.isConversationWorkspace` 只按真实 worksDir 分类；main 注入该分类，activate 在 ensureConfiguration 前返回 empty，不授予项目权限；UI empty 不安排 loading 定时重试 | project-backend-alignment-report.md 的真实 createConversation 测试；ui-alignment-report.md 的非空 scratch 组件/Electron 场景 |
| child 重启后进度丢失 | RepoWikiService 订阅 crashed/ready/failed，换权威 context 并在 ready 通知重激活；Wrapper 作废旧 token，新 client 重建 cursor；保留旧 instance/run/seq 防护 | 真实 kill-child 的新旧 token/instance 集成回归；UI 有可信握手后的新进度及旧事件拒绝 |
| 语言切换/集合双状态 | create 新 namespace 旋转 token并通知；可信 activate 的 project_id 只能选当前授权 path 下既有变体；UI 通过该接口切同路径 namespace；集合优先当前 project_id，避免强跳 zh | 真实 child 的 zh/en 切换与集合重入；UI 英文→集合→英文及同路径切回中文 |
| 同 ID 配置污染旧缓存 | 一份 identity 覆盖实际 model 快照、SDK getCompatibilityRequestConfig、models.json 源与 agentDataModel；expectedConfiguration 经私有 IPC/llm 第四参数到最终端口；SDK transformHeaders 中 beforeDispatch 重检 identity 与实际配置 headers，原 headers 原样返回；最终调用使用已捕获 model | workflow-configuration-guard-red.log 保留旧实现真实 SDK 红灯；最新 workflow-integration.log/report 已 PASS，证明同 ID header 改变产生新 key、旧排队请求拒 MODEL_CHANGED、新绑定发送 header 2 |

补充边界复核：

- ProcessClient 的 `child.on('message')` 入口现已拒绝 `this.child !== child`；RepoWikiService 在异步授权事件发送时还检查 supervisor、物理 PID、instance、context，不能把旧物理 child 的事件贴成新上下文。
- maxRestarts 耗尽和首次启动失败保留失败 supervisor；普通激活/轮询不无限重建，只有界面显式 retry:true 才退休并创建新 supervisor。真实预算耗尽/显式重试测试已存证。
- App 的 contextId 同时参与 render scope 和 layout scope。即使 React 批处理跳过 loading 帧，也先缓存当前 dirty page/revision/draft，再让新 request/client 重置并恢复编辑。UI 报告包含恢复后失败保存仍保留、随后成功保存的组件/Electron 回归。
- 原先确认的生产 WikiService 同一 globalLimiter、动态 active/queued 预算、queued cancel 不 dispatch、active cancel 向下到 SDK且 settle 前不让槽、授权根来源、自动项目去重和 embedded 禁 demo/watch 自动生成均保持。

复核读取的已保存验证材料：

- `project-backend-alignment-report.md`：后端 66/66、process 10/10、独立 watch 4/4，真实进程/存储边界明确。
- `ui-alignment-report.md`：组件/client 21、vendor 71、真实生产构建离屏 Electron 69 PASS / 0 FAIL；只跑 repo-wiki 场景。
- `workflow-integration-report.md` 与 `workflow-integration.log`：最终 Result: PASS，真实父进程 / AgentData child / RepoWiki child；生产 WikiService 与真实 Pi SDK 到 loopback HTTP。7 组覆盖自动项目、模型 B、现有 Wiki global=1 共享、queued/running cancel、A→B→A、model-id guard、same-id 配置 header guard。最后配置组日志为 `2026-10-31T09:34:00.529Z PASS`。
- 父线程另外报告模型叶子 3 文件 22 测试及严格 RepoWiki typecheck 通过；本文没有将这些称作本审查者独立执行的检查。最终构建由父线程收尾。

**明确保留的预算：** RepoWiki broker 的 120 秒是包含共享队列等待的整体预算。超过预算会取消该 completion，不能解读为共享队列可以无限等待。这是已声明的有界行为，不再列为未解决缺陷。

本轮指定审查范围内没有剩余阻断项，也没有被拒绝、待批准或结果不确定的工具操作。
