# GrenAgent AI 调度真实调用链追踪

追踪日期：2026-10-31。仅阅读源码和既有决策、运行确定性测试；没有修改生产代码、测试代码、配置或笔记，没有调用真实模型。此文件是调查交付物。

本文记录修复前的调用链快照。后续已按明确的接入要求选择共享真实 WikiService 限流实例，而非 TaskQueue 方案；实现与新证据见 [scheduler-alignment-report.md](./scheduler-alignment-report.md)。

## 结论

用户反馈成立：当前 RepoWiki `main.ts:354–364` 只解析应用默认模型后，直接调用 `ModelRuntimeHost.completeSimple()`。它没有经过 `AgentDataRuntime.runServiceTask()`、`TaskQueue`、`SystemWorkerManager`，而且绕开了已配置的 `agentDataModel`。因此当前实现只能称为复用模型运行时和凭据，不能称为接入后台系统任务调度。

但当前仓库也没有一个所有 AI 请求共用的完整调度器。必须区分以下三条实际存在的路径：

| 路径 | 实际排队 / 并发 | 配置 / 用量 / 取消 |
| --- | --- | --- |
| 主交互 / Goal 会话 | `PiRuntimeService.queuedTurns` 按 workspace + sessionId 排队；`WorkspaceHandle` 驱动真实 SDK session | 会话偏好模型、thinking、Fast；usage-ledger；`session.abort()` |
| 后台通用系统任务基础设施 | `TaskQueue` 系统任务一次一个，再进入 `SystemWorkerManager` 的 `ShortCallQueue` | `agentDataModel`；`service_tasks` token 计数；目前只有排队取消及整体关闭/超时 abort，缺少按任务运行中取消 |
| 当前 AgentData 知识库 Wiki 抽取 | 每个 Wiki 的 `buildQueues` + 单库 `wikiLimit` + 一个 WikiService 实例内跨 Wiki 的 `globalLlmLimit` | 同样读取 `agentDataModel`；直接 model reverse IPC；未接系统任务账本；取消是阶段检查，未 abort 在途模型 |

全生产源码搜索显示，`runServiceTask()` 目前只有 facade → runtime 的定义/转发，没有实际业务调用方（测试除外）。`TaskQueue` / `SystemWorkerManager` 确实由 `assembleAgentData()` 装配，属于可以接入的现存设施，不能把它描述成现有 Wiki ingest 已经采用的路径。2026-10-31 Memory 移除后，旧记忆管线笔记已归档，不能用旧文档推断当前生产调用方。

## 当前 RepoWiki 路径和必须保留的边界

```text
RepoWiki OS child
  HostModelProvider.generate_page()
  → child.ts hostComplete() 发 modelRequest { id, input }
主进程 RepoWikiProcessClient.complete()
  → RepoWikiService 注入的 ModelComplete(input, signal)
  → main.ts resolveModel 的绑定闭包
  → ModelRuntimeHost.completeSimple({ ...input, signal, model })
  → 主进程唯一 ModelRuntime / SDK provider
```

- `electron-agent/electron/main.ts:341–374`：创建 RepoWikiService，`resolveModel()` 读 models.json 后调用 `resolveDefaultModel()`，缓存身份包含 model + models.json 内容；没有 `agentDataModel`。
- `electron-agent/electron/app/repoWikiService.ts:30–35`：`RepoWikiModelBinding { cacheKey; available?; complete: ModelComplete }`，明确要求 complete 始终对应同一个 cacheKey 的模型。
- 同文件 `:139–155`：模型和允许目录变化停止旧 supervisor，再创建独立 RepoWiki child；重型扫描、SQLite、生成逻辑继续在 child。
- `vendor/repo-wiki/packages/contracts/src/index.ts:175–183`：`ModelComplete(input: { systemPrompt: string; user: string; maxTokens?: number }, signal: AbortSignal): Promise<string>`。
- `vendor/repo-wiki/packages/process/src/client.ts:153–157,210–229`：每个 modelRequest 产生 AbortController；modelCancel / child 退出会 abort，当前输入回调拿不到 request id 或项目/运行元数据。
- `vendor/repo-wiki/packages/process/src/host-provider.ts:63–94`：必须原样保留 RepoWiki systemPrompt、user、maxTokens（知识卡 1600 / Wiki 8192）。返回值必须是 page JSON 文本，再由 child 解析并严格校验来源/行号。
- `vendor/repo-wiki/packages/process/src/child.ts:45–48`：当前 broker 等待上限 120000ms；引入排队后要明确等待预算是否包含排队，避免未执行任务先被上游超时取消。

**不能直接用 `wiki_page_generate` 包一层**：`SystemWorkerManager` 对该 kind 强制“输出 Markdown”并拼 `Task kind / Input`，与 RepoWiki page JSON 契约不同；其 `expectedModel` 也只比 provider/id，不能证明配置版本相同。

## 后台系统任务的精确接口与反向 IPC

```text
AgentDataRuntime.runServiceTask(input)
  → TaskQueue.enqueue({ ...input, system: true })
  → executeServiceTask(task, hooks)
  → SystemWorkerManager.run({ id, kind, input }, hooks)
  → ShortCallQueue.run(...)
  → AgentDataModelPort.complete({ user, systemPrompt?, maxTokens?, signal?, onUsage? })
agentdata-host：main.model.complete { requestId, input, withUsage }
主进程：completeAgentData()
  → refreshConfig() / getConfig('agentDataModel') / applyAgentDataModel()
  → ModelRuntimeHost.completeSimple()
  → ModelRuntime.completeSimple()
```

| 接口 / 实现 | 位置 | 当前语义与缺口 |
| --- | --- | --- |
| `AgentDataService.runServiceTask(input: Omit<QueueTaskInput,'system'>): Promise<unknown>` | `electron/app/agentDataService.ts:184–186` | 只访问 `this.runtime`。默认 child 模式没有 runtime，直接报 `agent data runtime is not started`，不能直接从 main 调用 |
| `AgentDataRuntime.runServiceTask(input: Omit<QueueTaskInput,'system'>): Promise<unknown>` | `electron/agentData/runtime.ts:314–323` | 强制 system=true；完成返回 task.output，其他终态抛错；没有 signal 或取消入口 |
| `QueueTaskInput` | `electron/app/appServer/taskQueue.ts:7–16` | `id,kind,input,threadId?,sourceProjectId?,sourceSessionId?,capabilities?,system?` |
| `TaskQueue.enqueue / cancel` | 同文件 `:36–54` | 入库后排队；cancel 仅对 queued 生效，running 原样返回 |
| `TaskQueue.startAvailable` | 同文件 `:95–105` | 同 thread 串行；system 任务全局一次一个；非 system、不同 thread 没有统一总并发限制 |
| `TaskQueue.run` | 同文件 `:109–143` | timeout + registry output 校验 + 重试 + 终态记录；外层 timeout 只 reject，不中止底层 executor |
| `ServiceTaskHooks` | `electron/app/appServer/types.ts:78–82` | `onUsage?`、`onRawOutput?`，无 signal |
| `SystemWorkerManager.run` | `electron/pi/systemWorkerManager.ts:37–38` | 使用唯一 ShortCallQueue 串行；close 和 timeout 可以 abort；没有 cancel(taskId) |
| `AgentDataModelPort` | `electron/agentDataProcess/assemble.ts:12–15` | `describe():Promise<string>`；`complete({ user,systemPrompt?,maxTokens?,signal?,onUsage? }):Promise<string>` |
| 装配 | `electron/agentDataProcess/assemble.ts:39–56` | 同时注入 direct completeSimple 和 TaskQueue executor，两条路径不同 |
| child model reverse RPC | `electron/agentDataProcess/host.ts:43–58` | signal → `main.model.abort {requestId}`；usage → event map；模型请求使用 `main.model.complete` |
| main reverse handlers | `electron/main.ts:215–235` | requestId → AbortController；completeAgentData；onUsage 通过 IPC emit 回 child；host 退出统一 abort(:263–264) |
| 跨进程允许方法 | `electron/agentDataProcess/contract.ts:7–15` | 当前只有 admin / 注册工作区 / 插件 / shutdown，没有 serviceTask run/cancel/describe |

取消已有的最后一段链是可复用的，但只靠它还不够：必须让 RepoWiki 的 AbortSignal 穿过 serviceTask facade、child task queue、SystemWorkerManager 才能到这段模型 abort。

用量精确回路：`ModelRuntimeHost.completeSimple():96` 在文本格式校验前调用 onUsage；主进程 emit `agentdata.model.usage`；`host.ts:37–40` 路由到同 requestId 的 hook；`TaskQueue.recordUsage():154–162` 将 input/output/cacheRead/cacheWrite 累加到同一 service_tasks 行，重试也累计。`ModelRuntimeHost` 返回 SDK 结果后才有 usage，如果 SDK 在返回消息前直接 reject 而没有用量，则本层没有可计数的数据。它不是主交互 usage-ledger，现有 TaskQueue 也不存 cost。

## 已配置模型 / 供应商来源与 UI 字段

- 主进程共享凭据与模型目录：`main.ts:138–144` 的 `ModelRuntime.create({authPath: agentDir/auth.json, modelsPath: agentDir/models.json})`。不应让 RepoWiki child 新建第三份 auth/OAuth 所有者。
- 应用默认：`ModelRuntimeHost.resolveDefaultModel():69–76` 使用 `SettingsManager.create(userData,getAgentDir())` 的 defaultProvider/defaultModel；配置无效或缺 auth 时回退第一个 available 模型。它不读取当前会话或 `defaultSessionModel` 字段。
- 后台 AgentData：`main.ts:146–155` 每次 refreshConfig/getConfig('agentDataModel')，`agentDataModelOverride()` 在 `agentData/agentDataSettings.ts:2–6` 按第一个 `/` 拆 provider/modelId；空或不合法沿用应用默认；显式模型找不到时 `ModelRuntimeHost.resolveCallModel():129–133` 抛错。
- `settingsSchema.ts:584–589`：`agentDataModel`，即时，留空=应用默认模型。这个才是 RepoWiki 按后台系统任务语义应复用的配置域。
- `settingsSchema.ts:610–628`：`KNOWLEDGE_WIKI_INGEST_CONCURRENCY` 默认3，1–10；`KNOWLEDGE_LLM_GLOBAL_CONCURRENCY` 默认5，1–20。当前 consumer 仅是旧 Wiki ingest，不是 TaskQueue 配置。
- `settingsSchema.ts:597–607` 的 `KNOWLEDGE_WIKI_INGEST_MODE` 控制旧知识库 two-stage/single-stage，不适用于 RepoWiki 自己的 generation pipeline。
- `settingsSchema.ts:124–145`：`defaultSessionModel`、`titleModel`、`enhancePromptModel` 各有独立含义，不能拿其中任意一个冒充后台设置。
- `settingsSchema.ts:472–505` 普通 SUBAGENT_MODEL / CHEAP / STRONG / ALLOWLIST 与 `:525–568` ULTRA_SUBAGENT_MODEL / SCOUT / WORKER / PLANNER / REVIEWER / ALLOWLIST 是另一组路由域。

现有 `describeAgentDataModel()` 若有 override 直接返回该字符串，没有检查真实模型/凭据可用性；新增绑定解析需在宿主解析真实模型，不能只把这个字符串当“已配置可用”。模型缓存身份应同时覆盖 agentDataModel 选择、解析后的 provider/model 和真实影响 provider 请求的配置版本；原样 hash 整份 models.json 只能覆盖其中一部分。

## 主交互与现有 Wiki 抽取，不能混用的细节

主交互：`ipc/register.ts:744` → `agentProcess/mainBindings.ts:115` 的 pi.send → `agentProcess/runtimeGraph.ts:159` → `PiRuntimeService.send():317` → `WorkspaceHandle.prompt()` → SDK session.prompt。`PiRuntimeService.enqueueTurn():724–731` 以 sessionKey 排队，`agent_abort` 最终 `session.abort():1622`。会话模型/思考/Fast由 canonical session preferences 写入真实 SDK；交互/子代理 usage 由 `extensions/usage-ledger/index.ts:18–34` 的 message_end 进入账本。把 RepoWiki 塞进 enqueueTurn 会变成真实聊天回合、引入会话/工具权限和 JSONL 所有权，不能认为这是后台短调用的等价替换。

现有知识库：`WikiService.ingest():1210` → `enqueueBuild():1257`（buildQueues 按wikiId串行）→ `runBuild():1319` → `createLlmClient(this.complete):1340` → `runIngestIncremental():1348` → runtime 注入的 `options.completeSimple():126–128` →同一 AgentDataModelPort reverse RPC。这里没有 TaskQueue。

`wikiEngine/ingest/concurrency.ts:15–18,25–36` 从 runtime config 覆盖同名 env，动态读取设置；`:44–55` 值变化会新建 limiter，旧进行中调用继续占旧 limiter，不能声称切换时严格维持一个全局 active 计数。`WikiService:392` 的 globalLlmLimit 是实例私有；`runIncremental.ts:89–99` 包整个 extractSource、`ingest/index.ts:262–264` 包 mergePage、`runIncremental.ts:162–163` 包 overview。它不是所有模型请求的共享入口。

`wikiEngine/llm.ts:8–12,79–80` 的 CompleteFn 只有(system,prompt,label?)，没有 signal/usage，而 ChatParams 已有的 abortSignal/maxOutputTokens/temperature 没有往下传；旧 Wiki 的取消仅 `service.ts:1313–1321,1355–1357` 的阶段检查。不能沿用这个窄接口给新 RepoWiki，否则会丢掉已经具备的在途取消和 maxTokens。

## 最小可接入方案：让系统任务 facade 在 child 模式真的可用

建议保留 RepoWiki 独立 OS child 和现有 ModelComplete 协议；只替换它在宿主的 completion 实现。以下是**待实现方案**，不是当前已经存在的接口。

```ts
// main-process facade; AbortSignal 永不序列化
AgentDataService.runServiceTask(
  input: Omit<QueueTaskInput, 'system'>,
  options?: { signal?: AbortSignal },
): Promise<unknown>;
AgentDataService.cancelServiceTask(id: string): Promise<void>;

// 主 → agentdata-host 的受信任进程方法；不要对 extension socket 开放任意任务执行
'agentdata.serviceTask.run'    // params = 序列化 QueueTaskInput
'agentdata.serviceTask.cancel' // params = { id }

// 新专用 kind，保留 RepoWiki JSON文本和已有 child 严格校验
type RepoWikiCompletionTaskInput = {
  request: { systemPrompt: string; user: string; maxTokens?: number };
  expectedSelection: string; // opaque host selection/config revision
};
// kind = 'repo_wiki_generate', outputSchema = string
```

1. **跨进程 submit / cancel**：扩展 `agentDataProcess/contract.ts`、`host.ts`、`AgentDataService`，默认 child 和 inproc 走相同 runtime 队列。`runServiceTask()` 必须先确保服务启动，按 task id 把 signal 转换成单独 cancel IPC。取消先于入队、取消与完成竞态都要确定处理；不允许取消 A 影响 B。
2. **补齐运行中取消**：TaskQueue 为每次 active execution 管理 AbortController，把 signal 通过执行契约传到 SystemWorkerManager.run；SystemWorkerManager 的队列需要消费外部取消（排队时取消不发模型，在途取消与 timeout/close 链接）。TaskQueue 的 cancelled 终态必须压过迟到成功，不重试已取消任务；外层 timeout 也要 abort 并等待/隔离底层结束，不能只Promise reject后释放调度名额。
3. **专用 passthrough task kind**：registry 注册严格的 repo_wiki_generate input/output schema；SystemWorkerManager 对它使用原 request，不拼接通用 prompt、不解析成对象、不输出Markdown。child 继续负责 page JSON / 来源范围校验。超时与重试预算只有一个来源；RepoWiki 当前 host broker 120秒上限需一起校对排队等待，不能偷偷重放生成操作。
4. **统一宿主选择**：抽出 main.ts 已有 AgentData 配置解析作为单一 resolver，返回绑定的真实模型与 opaque revision，供 describe/cache identity 和 complete 共用；RepoWiki 的 complete闭包只调用 AgentData serviceTask。执行时 expectedSelection 校验与“选定并使用同一模型”需在宿主同一次解析中完成，避免 describe后配置切换、complete又读取新模型而把新内容放进旧缓存。显式不可用应报MODEL_UNAVAILABLE/MODEL_CHANGED，不能静默换模型污染缓存。
5. **真实用量**：沿现有 ServiceTaskHooks → reverse usage event → TaskQueue token行记账；sourceProjectId/sessionId来自宿主可验证上下文（不能让renderer随便指定）。当前ModelComplete没有项目/运行metadata，如需精确归属，最小增补一个可选request context，由受信任 RepoWiki child附run/project关联，main校验到已批准根；不要把API key或raw models.json传进child/renderer。
6. **重启/退出不重放**：当前runtime启动只将 `wiki_page_generate` 未完成任务标failed(:109)，其余 queued/running会recover。新kind必须同样将失去原RepoWiki generation owner的任务落定为 interrupted/cancelled，不能AgentData child重启自动付费回放。RepoWiki child退出应取消它已登记的任务，且配置切换停止旧child后不能留下后台模型调用。

这可以证明 RepoWiki 真实经过既有系统任务队列/worker/模型配置/usage反向IPC，复用现有固定 system并发=1，且不把扫描和存储移入AgentData或主进程。

**关于“复用现有并发”的边界**：上面复用的是通用系统任务 lane，不能声称它自动服从旧 Wiki 的 `KNOWLEDGE_LLM_GLOBAL_CONCURRENCY`。如果验收要求 RepoWiki 与旧Wiki共用这项用户设置，必须再把并发所有权从 WikiService 的私有限流器提升为 agentdata-host 装配级共享调度端口，让两条生产路径都进入同一实例；不能只在 RepoWiki端新建一个同值limiter。还要避免旧extract/merge已持有名额时，底层complete再次获取同一名额导致concurrency=1死锁。这是独立的明确契约调整，不是改一行complete即可完成。

## 验证证据和后续证明方式

已实跑（模型均为桩，未外发源码）：

```powershell
cd electron-agent
$env:TEMP='C:\Users\rxstudio\AppData\Local\Temp'
$env:TMP=$env:TEMP
node node_modules/vitest/vitest.mjs run electron/agentDataProcess/host.test.ts electron/app/appServer/taskQueue.test.ts electron/app/appServer/serviceTaskRegistry.test.ts electron/pi/systemWorkerManager.test.ts electron/agent/shortCall.test.ts electron/agentData/agentDataSettings.test.ts
```

结果：6文件、50测试通过，exit 0，2.48s。初次运行的默认沙箱TEMP SSR缓存rename报EPERM，6套件零测试；改用已授权临时目录后以上完整定向重跑通过。没有使用提权或重试被拒操作。

这些现有测试证明：系统任务串行与持久化、取消排队、重试用量累加、raw输出留底、SystemWorker混合kind串行/timeout/close、反向IPC usage先于响应以及child signal到main abort。`host.test.ts:14–15` 明确是RpcPeer和fakeProcess，不能把它当真实OS child证明；它也尚未证明RepoWiki接入新任务链。

实现后至少需要以下有辨别力的定向验证：

- main配置A默认、AgentData配置B：RepoWiki必须用B；为空回A；无效B不可悄悄改A。检查服务任务行model及宿主桩实际入参，不能仅断言resolver被调用。
- 真实 `AgentDataService(mode:child)` → 新process method → runtime.enqueue → SystemWorker → reverse model完整链；用gate并发提交不同kind证明与现有系统任务共享同一lane，且定时器/usage结果都来自正确task。
- 排队取消不调用模型；运行中取消穿透到main AbortSignal；A取消不影响B；晚到成功不覆盖cancelled；timeout释放后无仍在运行的模型并发泄漏。
- 原RepoWiki systemPrompt/user/maxTokens字节一致，返回page JSON经child原有严格校验并落盘；沿用原来源/人工编辑保护测试。
- 修改agentDataModel或同provider/id的配置时旧缓存身份失效；排队途中换配置报MODEL_CHANGED或原绑定完成，不能把新模型结果写进旧key。
- 成功、格式失败、重试的input/output/cacheRead/cacheWrite逐次累计到service_tasks；无usage保持NULL；不虚报主会话usage面板已含后台短调用。
- 真实Electron RepoWiki child + 真实agentdata-host，模型只在main端用确定性桩：PID隔离、生成、取消、退出、agentdata-host崩溃不重放、RepoWiki child退出无孤儿任务。必要时以生产CJS产物复跑。
- 如果做共享Wiki并发端口，旧Wiki与RepoWiki混合请求实际active计数不超过配置值，concurrency=1无双重限流死锁，运行时改并发无新旧limiter绕过预算。

本次为只读调查，没有执行UI全量或真实供应商调用，没有把后续方案标记为完成。

## 已读约束 / 相关决定

- 根AGENTS.md：重要行为/跨文件契约变更必须先搜笔记、留笔记、verify-notes；本次只写调查交付物。
- `.agents/notes/implemented/architecture/2026-10-16-agentdata-host-process.md`：保留agentdata-host数据库单一所有者、main唯一短调用auth/OAuth、异步reverse RPC；禁止child新增第三份ModelRuntime，禁止main重开agent-data.db。
- `.agents/notes/implemented/architecture/2026-09-10-pi-sdk-in-process-host.md`：会话JSONL同一时刻一个持有者；后台短调用和会话不是同一个对象。
- `.agents/notes/implemented/simplification/2026-10-31-remove-agentdata-memory.md`：Memory已撤除，保留通用任务基础设施，旧记忆文档仅作历史。
- `.agents/notes/implemented/architecture/2026-10-31-repo-wiki-process-integration.md`：独立RepoWiki OS child、独立dataDir、禁止把engine放主进程；当前短调用接法需要按本次纠正更新其说明与验证证据。
