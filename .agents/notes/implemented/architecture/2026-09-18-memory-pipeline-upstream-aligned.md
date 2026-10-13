# Agent Note: 记忆管线分层提炼，节奏、窗口与去重对齐上游

Status: implemented

## Problem

记忆分 L0–L3 层。L1 提取提示词移植自 TencentDB（52f602dc），层调用与 L2 场景节流对齐 TencentDB（663f3ee9，规格 `docs/superpowers/specs/2026-09-18-memory-l2-throttle-design.md`），2026-10-06 再按计划 `docs/superpowers/plans/2026-10-06-memory-pipeline-upstream-alignment.md`（e265c44d）整体对齐上游。以下各节是这次对齐中逐条定下、仍有效的规则。

动机（用户确认）：Pi 自己改出来的版本成本高、失败多，所以改回上游 TencentDB-Agent-Memory 的做法。

### memory_scene 也不再重复发送场景正文，解析失败留下模型原文，用量以埋点 token 为准不做字节换算

2026-10-06 打开记忆系统、在一个新会话里跑了几轮，埋点数据如下：

| 类型 | 任务 / attempt | prompt token |
|---|---|---|
| memory_scene 成功 | 1 / 1 | 66,593 |
| memory_extract 失败 | 4 / 8 | 13,276 |
| memory_extract 成功 | 2 / 2 | 6,262 |
| memory_persona 成功 | 1 / 1 | 3,359 |

memory_extract 去重之后，最贵的变成了 memory_scene。它的 input 是 63.5 KB，其中 `scenes`（现有全部场景文件）占 60 KB；`sceneUserPrompt` 已经把每个场景的正文内联进消息体，`Input:` 行又整个序列化了一遍，user 消息达到 124,321 字符。

新会话的 5 个抽取任务里有 3 个因为输出格式失败（两个 `memory extraction output is invalid`，一个 `invalid JSON`），花掉了抽取 token 的 68%。这类失败不是确定性的：`dd38bb31` 重试两次都失败，紧接着输入几乎一样的 `76997ac5` 一次就成功了。原始输出解析失败后就丢了，看不出模型返回了什么。

用量校准：同一个中转（`custom-muc3psr5/deepseek-v4.1-flash`）对几乎相同的 prompt，未命中缓存的部分都在 2,100 左右，缓存命中一次报 384、一次报 2,432，每次 attempt 的合计一个是 2,485、一个是 4,545。按实际渲染的 system + user 字符算，当天样本在 1.9 到 4.5 chars/token 之间，中文越多越低。handoff 里的 0.215 chars/token 和约 16.8k token 的固定前缀，在这条链路上都不存在。

### 系统任务记录模型用量，memory_extract 不再重复发送对话载荷，empty content 不重试

2026-09-08 至 09-28 的记忆任务共发出 49.8 MB input，其中 memory_extract 占 46.5 MB（305 个任务）。这些调用走 `ModelRuntimeHost.completeSimple`，不写 session JSONL，用量面板看不到，`service_tasks` 也没有 token 列，改了什么都无法验证收益。

`serviceTaskPrompt` 先用 `formatExtractionPrompt` 把 `delta` / `background` / `previousSceneName` 渲染成正文，再在 `Input:` 行把整个 `task.input` 序列化一遍，同一份对话发了两次。`delta` 与 `background` 占 input 的 95%。

失败任务占了 68% 的 input，其中 `error='empty content'` 有 108 个任务、216 次 attempt。重试来自 `TaskQueue`：registry 里 memory_* 的 `maxAttempts` 是 2。`SystemWorkerManager` 自己的重试循环在生产里 `maxAttempts` 取默认值 1，不是翻倍的来源。

`empty content` 的成因有一部分光看代码看不出来。pi-ai 的 `completeSimple` 不抛异常：HTTP 错误、限流、上下文超长都以 `stopReason: 'error'`、content 为空的消息返回（`AssistantMessageEventStream` 把 `error` 事件的 `event.error` 当作 result）。`formatNonStream` 只看 text 块，于是把 provider 的报错也记成 `empty content`。

### 记忆任务超时对齐上游（180s / 300s），抽取与去重输出上限 4096，不传 reasoning

记忆任务统一 60 秒超时，历史上有 36 个任务因此失败（72 次 attempt）。上游 L1 抽取、去重、L3 是 180 秒，L2 是 300 秒；L1 输出上限 4096 token。我们的系统 worker 只传 systemPrompt / user / signal。

### 去重期间游标不提交的批次仍算进行中，后继抽取等 completeDedup 提交后再接续；去重 Input 不再重复 matches

抽取结果有候选时，completeExtraction 不直接写库，而是入队 memory_deduplicate，游标要等 completeDedup 写完才提交（commitCapture）。旧实现在入队去重之后立刻 finishCapture(extractTaskId)，把这一批从 pending 里移除，并按「有更新的输入就接着抽」去发后继 force 任务。此时游标还停在这一批之前：store.capture 算出的 delta 会连同这一批一起带上，同一批对话被抽第二遍；去重任务又还在排队，两边的写入还会交错。光看 completeExtraction 的代码看不出来，因为 finishCapture 在非去重路径里紧跟在 commitCapture 之后，调用顺序看上去是一样的。

另一处是 memory_deduplicate 的 Input 行。入参里的 matches 已经被 formatBatchConflictPrompt 渲染进正文（新记忆和候选各一遍），Input 行又把整份 matches 序列化一次，候选池大时同一份内容发两遍。

### 去重候选改为关键词重叠召回（中文二元组 + 英文词，阈值 0.3）

recallCandidates 用整条新记忆做 lower(content) LIKE '%…%'，只有和旧记忆一字不差的才能命中，所以 memory_deduplicate 在库里一次都没执行过（0 条）。上游 l1-dedup.ts 用向量召回 top-5。

### 记忆抽取按上游节奏：每 5 轮一批、预热 1→2→4→5、空闲 600 秒补抽、启动后补抽

我们每次 agent_end 都抽取一次。上游 pipeline-manager.ts 是每个会话累计 everyNConversations（默认 5）轮才抽，新会话阈值从 1 开始，每抽一次翻倍（预热）；没到阈值时空闲 l1IdleTimeoutSeconds（默认 600）秒补抽；关闭时冲掉剩余。

2026-10-06-memory-task-usage-and-payload-dedupe.md（已被 2026-10-07-memory-extract-window.md 取代）否决过 everyN 节流，理由是调用次数只占成本的 6%。但上游控制成本靠的是「节奏 + 每批 10+5 上限」两者配合，单看频率会漏掉后一半。上限已在 2026-10-07-memory-extract-window.md 落地，这里补上节奏。

### 抽取输出按上游宽松解析：剥 think、去围栏、对象里找数组、修复控制字符与 priority

2026-10-06 一个新会话的 5 个 memory_extract 任务里有 3 个因格式失败（两个 `memory extraction output is invalid`，一个 `invalid JSON`），花掉了抽取 token 的 68%。我们的解析要求整段输出能被 JSON.parse，而且必须是场景数组或 {l1,l2,l3}；对象套数组、单个场景对象、字符串里有裸换行、priority 写成单词，都会整批失败。上游 l1-extractor.ts:571-681 对这些都有处理。

### memory_extract 只送最近 10 条对话加 5 条背景，工具输出不进抽取；delta 只当游标

历史 311 个 memory_extract 任务的载荷里，工具输出占 94.7%（42.3 MB），用户发言 0.6%，assistant 文本 4.5%。delta 不设上限，老会话第一次捕获会把整段历史一次发出（实测 286 KB）。上游 TencentDB-Agent-Memory 只送 user/assistant 文本（l0-recorder.ts:551-590），assistant 去掉代码块，每批最多 10 条新消息加 5 条背景（l1-extractor.ts:149-182）。

### L2 只内联与新记忆相关的场景正文（最多 3 个），没给正文的已有场景不许写也不许删

被推翻的笔记在「放弃的方案」里写过：只发相关场景「会改变上游模板『全部场景内联』的语义」。这句话是错的。上游 scene-extraction.ts:551-565 只给文件清单和摘要，正文由模型用 read 工具按需读；「全部内联」是 Pi 移植时因为系统 worker 没有工具而自己加的。2026-10-06 一次 L2 调用就用了 66,593 prompt token，占当天记忆 token 的 74%，而且场景越多越贵。

## Decision

### memory_scene 也不再重复发送场景正文，解析失败留下模型原文，用量以埋点 token 为准不做字节换算

memory_scene 的 `Input:` 行去掉已经渲染过的字段：`memories`（正文里整段序列化）、非空的 `sceneSummaries`、字符串 `currentTimestamp`，以及每个场景条目的 `content`。场景的 `filename`、`summary` 和其余字段保留；`filename` 或 `content` 不是字符串的条目渲染时会被跳过，所以整条保留。`maxScenes`、`mode` 和来源字段不动。memory_persona 的重复只有约 2.6 KB，不改。

`SystemWorkerManager` 拿到模型文本后、解析之前，通过 `hooks.onRawOutput` 交出原文。`TaskQueue` 只在这次 attempt 失败时把它写进 `service_tasks.raw_output`（新列，截到 8000 字），任务成功时清空。格式类失败保留重试。

用量统计直接读 `input_tokens + cache_read_tokens + cache_write_tokens`，不再用 `LENGTH(input)` 换算。只有估算埋点之前的历史数据时，才按约 2 chars/token 粗算，并注明误差可能有一倍。

### 系统任务记录模型用量，memory_extract 不再重复发送对话载荷，empty content 不重试

用量埋点。`ShortCallInput.onUsage` 在 `runtime.completeSimple` 返回后、文本校验之前回报 `{ model, usage }`，所以空内容和报错的那次调用也会记上。回报沿 `SystemWorkerManager.run(task, hooks)`、`executeServiceTask(task, hooks)`、`TaskQueue` 传回，`TaskQueue` 把它累加到 `service_tasks` 新增的 `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` / `model` 列。这几列用 `ensureColumn` 加，不动 `schema_version`。各次 attempt 都累加进同一行；一次也没拿到用量的任务这几列是 NULL。缓存读写单独成列：handoff 实测有约 16.8k token 的固定前缀，只看 `input` 会把缓存命中算漏。

M1：只对 memory_extract，`Input:` 行去掉本次真正渲染过的字段。`newMessages` 是数组时渲染的是它，否则是 `delta`；`background` 同理；`previousSceneName` 是字符串时去掉。`source` / `fingerprint` / `userId` / `projectId` / `workspace` / `sessionId` / `mode` 原样保留。其余 kind 不变。用本机 305 条历史 memory_extract 重放，user 消息平均从 316,642 字符降到 157,056 字符（比值 0.496，最大的一条从 3,757,389 降到 1,857,650）。逐条比对，保留字段的键和值没有任何差异。

F1：`formatNonStream` 先看 `stopReason`，`error` / `aborted` 时直接返回 provider 的 `errorMessage`。真正没有文本时仍以 `empty content` 开头，后面带上 `stopReason` 和块类型，例如 `empty content (stopReason=length, blocks=thinking)`。

F2：`TaskQueue` 遇到 `empty content` 开头的错误不再重试。provider 报错（限流、网络）照旧按 registry 的 `maxAttempts` 重试。

### 记忆任务超时对齐上游（180s / 300s），抽取与去重输出上限 4096，不传 reasoning

超时值以 `electron/agent/shortCall.ts` 的 `KIND_TIMEOUT_MS` 为唯一来源：`ServiceTaskRegistry` 从它导入，`BUILTIN_SERVICE_TASKS` 里 memory_extract / memory_deduplicate / memory_scene / memory_persona / goal_judge / wiki_page_generate 的 `timeoutMs` 直接引用 `KIND_TIMEOUT_MS[kind]`，不再手抄第二份。memory_extract、memory_deduplicate 传 maxTokens 4096；memory_scene、memory_persona 不设上限，因为它们要输出整篇 Markdown。ModelRuntimeHost.completeSimple 只在给了 maxTokens 时才透传。

### 去重期间游标不提交的批次仍算进行中，后继抽取等 completeDedup 提交后再接续；去重 Input 不再重复 matches

去重分支不调 finishCapture，也不从 pending 里删这一批：把 extractTaskId 记进 PendingDedup，并在 pending 里补登记（重启后从队列恢复的抽取任务原本不在 pending 里）。这一批在去重结束前一直算进行中，同来源的新一轮 capture 命中它，返回 queued 并入这一批，不另起抽取。去重结束的三条路径各自收尾：completeDedup 在 commitCapture 之后 finishCapture；memory_deduplicate 失败或取消时（taskSettled），以及去重入队被拒时，删除 pendingDedup 并 finishCapture。收尾后的接续逻辑沿用 finishCapture：只有比这一批更新的输入才发后继任务。提交后接续的 delta 只剩新的一轮；失败后游标没动，接续的 delta 带上整批未提交内容，等于连同新输入重抽，这是失败重试该有的行为。

memory_deduplicate 且 matches 是数组时，Input 行只去掉 matches，mode 等其余字段保留。旧形状（newMemories / candidates）不动。

### 去重候选改为关键词重叠召回（中文二元组 + 英文词，阈值 0.3）

新增 memoryTerms：中文按二元组、英文取 3 字符以上的词（去掉结尾的 . _ -）、去停用词，按文本出现顺序出词，查询侧最多取 64 个。

召回分两步：

1. store.searchL1ByTerms 粗筛。只在 L1 JSON 的 content 字段里数关键词子串命中数（非 JSON 内容按原文），不看整段 JSON，否则 type、priority 这些键名会让每行都命中。保留命中数不低于 minShared 的，按命中数从多到少、同分最近更新的在前，取前 50。词去重后最多 64 个，lower(content) 只在 `WITH … AS MATERIALIZED` 里算一次。
2. recallCandidates 在调用方精确打分：查询词在候选词集合里的命中比例不低于 0.3，并且命中词数不低于 min(3, 查询词数)，取前 5。

粗筛的 minShared 取 max(1, min(3, 词数), ceil(0.3 × 词数))，和第 2 步的两条下限同一个函数。SQL 子串命中数不小于 JS 词集合命中数，所以这个下限不会漏掉第 2 步本来会留下的候选。

completeExtraction 对每条新记录只召回一次，「要不要去重」和「组装 matches」共用同一份结果。召回在主进程同步执行，不重复算。

### 记忆抽取按上游节奏：每 5 轮一批、预热 1→2→4→5、空闲 600 秒补抽、启动后补抽

MemoryService 按来源（user、workspace、session、source）记录计数和阈值，都在内存里，只存来源标识，不带 transcript。一次 capture 算一轮；没到阈值时返回 extraction: 'deferred'，并重置空闲计时。到阈值后先算抽取窗口（延后的轮次不会反复解析 transcript）：窗口为空就返回 'skipped'，只把计数清零、取消该来源的空闲计时，不翻倍阈值；真正入队才计数清零、阈值翻倍直到 everyN。没入队就不该推进预热。

任务进行中到来的轮数照样计数，任务结束后（finishCapture）够阈值就接着抽，不够就等空闲。这个进程里没见过该来源（重启后恢复的任务）时不知道积了多少轮，照旧立刻接着抽。

启动补抽代替上游的关闭时冲掉：recoverPendingCaptures 只登记请求，第一次见到开着开关的 capture 后（已见过则立刻）再等 60 秒，对有 pending 的来源补抽，最多 5 条、updated_at 新的优先，逐个进行：一个来源的抽取任务落定（抽取完成、有去重时去重结束、任务失败或取消，MemoryService 把它从 pending 里移除）才处理下一个，不会重启后一次把所有残留来源压进队列。空闲补抽和启动补抽共用 flushSource，带 force 标记绕过阈值，force 只在主进程内部传，RPC 的 memory.capture 不会传。

补抽必须遵守用户开关 MEMORY_EXTRACT。主进程读不到这个设置，它只通过扩展每次 memory.capture 带的 extract 标志传进来，所以 MemoryService 记下最近一次非 force capture 的 extract 取值（extractObserved，未见过为 undefined）：收到 false 就取消所有来源的空闲计时和补抽计时（开关是全局的），补抽请求保留；收到开着的 capture 才挂补抽计时器；flushSource 在没确认开着时直接返回，任务结束后的接着抽在确认关着时也不入队。

dispose 之后 finishCapture 的后继、空闲计时、补抽都不再动作。

参数都可以通过 MemoryServiceOptions.extractCadence 覆盖，测试用 { everyN: 1, warmup: false } 保持旧行为。默认计时器 unref，空闲补抽不拖住进程退出。

### 抽取输出按上游宽松解析：剥 think、去围栏、对象里找数组、修复控制字符与 priority

新增 memoryOutputParse.ts，移植上游的 <think> 剥离、代码围栏剥离、sanitizeJsonForParse、repairExtractionJson。memory_extract 依次尝试：整段解析得到数组或信封；整段是单个场景对象就包成数组；整段是带别的字段的对象就在属性值里找场景数组；整段解析不出来才取第一个 [ 到最后一个 ] 再解析。返回数组前都要过同一个判定：空数组放行（模型明确说没有记忆），非空数组至少有一个带 memories 数组的对象，否则按解析失败处理。这个判定是必须的：flattenSceneExtraction 会跳过没有 memories 的元素，completeExtraction 在 l1 为空时照样提交游标，把裸 L1 记录数组或 [1] 当成结果返回，就是把这批对话静默当成没有记忆、永久跳过。输出里还有未闭合的 <think>（被 max_tokens 截断）时不走贪婪回退，直接失败。flattenSceneExtraction 对每条记忆补默认值：priority 非数字时转数字或给 50，source_message_ids 转字符串，metadata 不是对象时给空对象。其余 JSON kind 也先剥 think 和围栏，再走净化与修复。

### memory_extract 只送最近 10 条对话加 5 条背景，工具输出不进抽取；delta 只当游标

新增 buildExtractionWindow：按 pi 的角色行切分 transcript，只留 user/assistant；assistant 去代码块、去内联图片；按上游 shouldExtractL1 过滤；同一轮里被工具调用隔开的 assistant 文本合成一条（任何 user 段，包括被过滤掉的 /compact，都会断开合并；被过滤掉的 assistant 纯代码块不会）；单条截到 4000 字；最后取 10 条新消息，背景从「更早的会话文本 + delta 里没进窗口的消息」里取最后 5 条。

任务输入新增 newMessages / backgroundMessages，去掉 background 字符串。delta 保留，只给 captureFromTask / commitCapture 做游标；systemWorkerManager 的 Input 行一律不带 newMessages、backgroundMessages、delta、background、previousSceneName。窗口为空（新增内容只有工具输出）时不入队，直接提交游标。memory.capture 的回执新增 extraction 字段，扩展看到它就不走本地兜底抽取。

被推翻的旧笔记里，以下结论仍然有效：service_tasks 的 token 用量埋点（input / output / cache_read / cache_write_tokens、model 按 attempt 累加）；formatNonStream 先看 stopReason、provider 报错透出原文；empty content 开头的错误不重试。被推翻的只有「newMessages 是数组时，没渲染的 delta 保留在 Input 段」这一条。

### L2 只内联与新记忆相关的场景正文（最多 3 个），没给正文的已有场景不许写也不许删

主进程用关键词重叠（memoryTerms）挑出和本批新记忆最相关的最多 3 个场景内联正文，其余只出现在摘要清单里。预筛规则：

- 按条计分。每条新记忆各自取词（`scene_name` + `content`，默认词数上限），场景至少被一条记忆命中才入选，零分不选。排序键依次是被多少条记忆命中、各条记忆重叠词数之和、文件名；先看命中条数，是为了不让单条长记忆的重叠词数压过多条记忆的共同指向。
- 多数场景共有的词不计分。先算好每个场景的词集（文件名 + 摘要），统计每个词出现在多少个场景里；场景总数 ≥ 4 时，计分忽略出现在超过一半场景里的词。
- 场景数 ≥ maxScenes − 1 时全部内联：橙色预警只能 UPDATE 不能 CREATE，红色预警必须 MERGE，两种情况模型都要看到全部正文。

提示词写明只能改或删正文已提供的场景，可以新建。completeScene 落库前丢掉对「已存在但没给正文」的场景的写入和删除，丢弃时 console.warn；重启恢复的任务从存储的输入里还原哪些场景给过正文（带 content 的条目就是给过的，所以升级前入队、每个场景都带 content 的旧格式任务对任一已有场景都可写）。

拼 prompt 时场景总数和红 / 橙 / 黄预警档位按 `scenes` 的全部条目算，不再按带正文的条目算：预筛之后带正文的最多 3 条，按它算会让 13 个场景的黄色预警消失。正文区仍只渲染带 content 的条目。

被推翻的旧笔记里，以下结论仍然有效：memory_scene 的 Input 行去掉已渲染字段（memories、sceneSummaries、currentTimestamp、场景 content）；service_tasks.raw_output 在解析失败时留下模型原文；用量统计直接读埋点 token，不做字节换算（同一中转对相同 prompt 报出的数相差近一倍，当天样本在 1.9 到 4.5 chars/token 之间）。

### 涉及文件

- `electron-agent/electron/pi/systemWorkerManager.ts`
- `electron-agent/electron/app/appServer/taskQueue.ts`
- `electron-agent/electron/app/appServer/types.ts`
- `electron-agent/electron/agentData/storage.ts`
- `electron-agent/electron/agentData/runtime.ts`
- `electron-agent/electron/agent/modelRuntimeHost.ts`
- `electron-agent/electron/main.ts`
- `extensions/_shared/oneshot.ts`
- `electron-agent/electron/agent/shortCall.ts`
- `electron-agent/electron/app/appServer/serviceTaskRegistry.ts`
- `electron-agent/electron/app/memoryService.ts`
- `electron-agent/electron/app/memoryTerms.ts`
- `electron-agent/electron/app/memoryDedup.ts`
- `electron-agent/electron/agentData/memoryStore.ts`
- `electron-agent/electron/agent/memoryOutputParse.ts`
- `electron-agent/electron/agent/memoryExtraction.ts`
- `electron-agent/electron/app/memoryExtractionWindow.ts`
- `extensions/memory/capture.ts`
- `electron-agent/electron/app/memoryLayers.ts`
- `electron-agent/electron/agent/memoryLayerPrompts.ts`

### 来源

- `docs/decisions/electron-agent/agentdata/2026-10-06-memory-scene-dedupe-raw-output-calibration.md`
- `docs/decisions/electron-agent/agentdata/2026-10-06-memory-task-usage-and-payload-dedupe.md`
- `docs/decisions/electron-agent/agentdata/2026-10-07-memory-call-limits.md`
- `docs/decisions/electron-agent/agentdata/2026-10-07-memory-dedup-commit-before-successor.md`
- `docs/decisions/electron-agent/agentdata/2026-10-07-memory-dedup-keyword-recall.md`
- `docs/decisions/electron-agent/agentdata/2026-10-07-memory-extract-cadence.md`
- `docs/decisions/electron-agent/agentdata/2026-10-07-memory-extract-output-parse.md`
- `docs/decisions/electron-agent/agentdata/2026-10-07-memory-extract-window.md`
- `docs/decisions/electron-agent/agentdata/2026-10-07-memory-scene-inline-related.md`
- 52f602dc
- 663f3ee9
- e265c44d

## Alternatives considered

### memory_scene 也不再重复发送场景正文，解析失败留下模型原文，用量以埋点 token 为准不做字节换算

- 把场景条目整个从 Input 去掉：`summary` 不在正文里，删掉会丢信息。
- 每次只发和新记忆相关的场景，不发全部：这会改变上游模板「全部场景内联」的语义，属于结构性改动，不在这次范围内。
- 把格式类失败也划进不重试：实测重试会成功，划进去会丢记忆。
- 原文写进 `error` 列：`error` 会在任务视图里展示，而且会被前缀匹配，塞进几千字的模型输出两边都会受影响。
- 每次 attempt 都留原文：成功的那次已经有 `output`，再存一份只是占空间。
- 在笔记里定一个统一的 chars/token：同一个中转对同样的 prompt 报出的数相差近一倍，单一比值会给出虚假的精度。

### 系统任务记录模型用量，memory_extract 不再重复发送对话载荷，empty content 不重试

- 直接删掉整个 `Input:` 行：上面 7 个字段从没被 `userBodyFor` 渲染过，删掉模型就看不到它们。
- 对 memory_scene / memory_persona 一并去重：`sceneUserPrompt` 只取 `scenes` 里的 filename/content，`personaUserPrompt` 也只取部分字段，逐字段确认之前不动它们，而且它们不是开销大头。
- 全局把 `maxAttempts` 改成 1：会影响所有 kind，还和「失败不重发积压」（阶段 2 的 M3）有顺序约束。这次只按错误类型分级。
- 在 `SystemWorkerManager` 的重试循环里做 F2：生产里那条循环只跑一次，改了也不会减少 attempt。
- 无 text 块时把 thinking 块当作回答：推理文本不是约定的 JSON 输出，交给 `parseCompleteOutput` 只会换一种失败方式，还可能抽出错误的记忆。先靠新的错误信息看清真实分布再决定。
- 加 `everyN` / warmup / idle debounce 节流：调用频次实测只有 1.15 次/轮，攻击的是只占 6% 的部分，还会让积压变大，更容易触发超大请求失败。
- 让 `completeSimple` 改返回 `{ text, usage }`：Wiki 等调用方都要跟着改，失败的那次也拿不到用量。用回调只加一个可选字段。
- 用量写进 `usage` JSON 列：按列存可以直接用 SQL 求和、和 `LENGTH(input)` 对比。

### 记忆任务超时对齐上游（180s / 300s），抽取与去重输出上限 4096，不传 reasoning

- 传 reasoning: 'minimal' 压低思考：pi-ai 不传 reasoning 就等于关闭思考（openai-completions.js 里 enable_thinking = !!reasoningEffort），传 'minimal' 反而会打开。
- 显式传 temperature：上游 Chat Memory 管线也不传；先看宽松解析之后的失败率再决定。
- 给 L2 也设 4096：场景文件常有几千字，截断会写坏场景。

### 去重期间游标不提交的批次仍算进行中，后继抽取等 completeDedup 提交后再接续；去重 Input 不再重复 matches

- 在 completeExtraction 里先 commitCapture 再入队去重：游标提前提交，去重失败时这一批永久丢失，且抽取结果还没落库，是更坏的失败模式。
- 后继任务发出时从 delta 里手工扣掉这一批：要在 MemoryService 里重做 store 的游标算术，commitCapture 已经会按 delta 前缀裁剪 pending，应该让它来裁。
- 去重期间让新一轮另起任务、靠队列顺序保证先后：任务入队时 delta 就已经算好，排在后面也还是带着旧批次；去重失败时顺序保证也不存在。
- Input 行里 matches 整体替换成条数或 record_id 列表：正文已经完整渲染，Input 行再留任何摘要都只是噪音。

### 去重候选改为关键词重叠召回（中文二元组 + 英文词，阈值 0.3）

- 上 embedding：要配置 embedding provider、加向量表和索引，放到检索那份计划里一起做。
- SQLite FTS5：中文需要分词器，内置的 unicode61 按字切效果差；而且要新建虚表和触发器。
- 阈值 0.5：中文改写后二元组重合我们估计通常在 0.3 到 0.6 之间，0.5 会漏掉不少。这是经验估计，没有拿真实记忆库实测过。
- 粗筛用 instr 对整段 JSON 做「命中任一词」再按 updated_at 取前 50（第一版做法）：键名让每行都命中，实际退化成「最近 50 条」，库变大后更旧的真重复被挤掉。改成只看 content 并按命中数排序。
- 只用比例阈值、不加命中数下限：查询词多时，共享一个短语（4 个字的词组就有 3 个二元组）就能过 0.3，召回很多不相干的旧记忆。

### 记忆抽取按上游节奏：每 5 轮一批、预热 1→2→4→5、空闲 600 秒补抽、启动后补抽

- 计数和阈值落库：重启后预热从 1 重新开始，只是早期多抽一次，代价很小，不值得为此加表。
- 退出时冲掉：Electron 退出时等不了模型返回，改为启动后补抽。
- 只做空闲补抽、不做 everyN：长会话一直在聊就一直不抽，pending 越积越大，最后被 10+5 窗口截掉。
- 同一 fingerprint 重复到达时不计轮：扩展重发同一份 transcript 时可以少数一轮。否决的理由不是「失败后原样重试要靠它立刻重新入队」：生产默认下失败时阈值已经 ≥2，原样重发只让计数 +1，仍是 deferred，并不能立刻重新入队。保留计轮是因为重复到达本身也是一次 agent_end，按上游口径就算一轮；为它单开去重判断没有收益。
- 启动补抽一次性并发入队，只靠条数上限兜底：上限只能限制总量，限制不了瞬时排队；记忆任务共用系统任务队列，一次压进 20 个会让用户刚发起的抽取、场景整合排在它们后面。改成每个来源落定后再处理下一个，同时把默认上限从 20 降到 5。
- 启动补抽不看开关、到点就抽：用户关了 MEMORY_EXTRACT，重启后仍会把上次留下的 pending 送去抽取，绕过开关。
- 主进程自己读 MEMORY_EXTRACT：主进程读不到这个设置，要读就得新加一条通道，而每次 capture 本来就带着 extract 标志，复用它不用加接口。

### 抽取输出按上游宽松解析：剥 think、去围栏、对象里找数组、修复控制字符与 priority

- 完全照上游，找不到数组时当作「没有记忆」直接提交：2026-10-06 的数据显示同样的输入重试会成功（dd38bb31 失败、紧接着的 76997ac5 成功），直接提交会丢掉这批记忆。所以仍然抛错，交给 TaskQueue 重试一次。
- 用 JSON mode（response_format）：上游 Chat Memory 也没用，而且中转和不同 provider 的支持参差不齐。
- type 缺失时默认 episodic（上游做法）：缺 type 的记录现在是被 l1RecordSchema 的 type: z.string() 丢掉的。不跟上游是为了不引入默认类型；episodic 在 chat 模式下是有效类型，默认它会把没写 type 的记录原样存进 chat 记忆，而 work 模式下才会被类型过滤丢掉。
- 回退路径不做判定、拿到数组就返回（即最初的实现）：截断的 <think> 里的 [1]、裸 L1 记录数组都会被当成「没有记忆」提交，和上面「完全照上游」有同样的问题。

### memory_extract 只送最近 10 条对话加 5 条背景，工具输出不进抽取；delta 只当游标

- 在扩展里改 flattenTranscript，捕获时就不存工具输出：conversation_search 依赖完整的 transcript，L0 归档会因此变样。
- 不合并同一轮的 assistant 段：一轮常被工具调用切成好几段，10 条新消息只能覆盖两三轮，和抽取节奏的 5 轮对不上。
- 不截单条：一条长报告就能把批量上限抵掉。
- 窗口外更早的 delta 消息另开任务补抽：和上游的批次语义不一致，而且会把节省的成本又花回去。
- 把 delta 从任务输入拿掉，改用 memory_captures.pending 或偏移量做游标：captureFromTask 在进程重启后要靠任务输入还原游标，commitCapture 用 delta 做前缀比对来只消费本批内容，换成偏移量要改游标模型，超出本次范围。
- 背景对整段历史做完整切分清洗、再留最后 5 条：background 是整段更早的会话，可达 MB 级，在主进程同步执行。改为只在 delta 窗口非空、且 delta 自己填不满背景时才取值，并从尾部按 64 KB 起、每次放大 4 倍的窗口解析，窗口从角色行开头切，拿到多于所需条数（窗口第一条可能和窗口之前的 assistant 合并过，只算半截）才停，放大到整段时与全量解析一致。

### L2 只内联与新记忆相关的场景正文（最多 3 个），没给正文的已有场景不许写也不许删

- 给 L2 worker 开只读 read 工具，完全对齐上游：要让系统 worker 跑工具循环，改动大，用户选择了主进程预筛。
- 只发摘要、一律不内联正文：UPDATE 要输出完整正文，模型看不到原文就只能凭摘要重写，会丢内容。
- 按 L1 的 scene_name 精确匹配文件名：L1 的情境名是一句话（「用户在围绕英语时态学习」），和场景文件名对不上。
- 整批新记忆拼成一个查询、取前 96 个词：L2 批次最多累积 200 条记忆，约 25 字一条时第 4 条就占满 96 个词，后面的记忆不参与选场景。改为按条分别取词、分别计分。
- 只按总得分排序：单条长记忆的重叠词数会压过被多条记忆同时指向的场景，所以先按被多少条记忆命中排序，总得分只做第二键。
- 写死一份词表，把「记忆」这类常见前缀词加进停用词：词表要跟着场景命名手工维护，换个前缀就失效。改用场景集合内的词频，出现在超过一半场景里的词自动忽略。

## Consequences

### memory_scene 也不再重复发送场景正文，解析失败留下模型原文，用量以埋点 token 为准不做字节换算

场景数越多，memory_scene 越贵：每次都要发全部场景正文，去重只砍掉了重复的那一份。场景数逼近 `maxScenes` 时，单次就会有几万 token。

`raw_output` 里可能出现对话内容的摘录，和 `input`、`memories` 的敏感程度相同。

如果要精确核算成本，应换一个用量上报可信的 provider 再校准；这个中转的数字只适合看相对变化。

### 系统任务记录模型用量，memory_extract 不再重复发送对话载荷，empty content 不重试

token 与字节的换算还没校准：记忆系统目前关着（`MEMORY_EXTRACT=0`），要重新打开、跑一次抽取，拿新列和 `LENGTH(input)` 算出本机的 chars/token，结果另写一篇笔记。在那之前，`LENGTH(input)` 只能当相对负载看。

以前被记成 `empty content` 的 provider 错误现在会带着原始报错重试一次，所以 empty content 的 attempt 会少于原来的一半，provider 错误的 attempt 会多出来。看新数据时两类要分开统计。`formatNonStream` 也被 `pi oneshot` 子命令和 Wiki 生成使用，它们拿到的错误文本同样变成了 provider 的原始信息。

memory_scene / memory_persona 的载荷仍然可能重复；如果新埋点显示它们的占比上来了，再逐字段确认后去重。

### 记忆任务超时对齐上游（180s / 300s），抽取与去重输出上限 4096，不传 reasoning

排队阻塞有两层：先是 TaskQueue 对系统任务一次只启动一个（`startedSystem`，见 taskQueue.ts 的 `startAvailable`），其次 SystemWorkerManager 的 ShortCallQueue 也是串行，所以一个卡住的 L2 最多会让后面的 goal_judge、wiki 等 300 秒。如果出现明显排队，再把记忆任务和其他系统任务拆成两条队列。

两层超时同刻到期时外层 TaskQueue 的 withTimeout 先触发（它注册定时器早于内层），失败任务的 error 是 `service task timed out after Nms` 而不是 `aborted`；内层被 abort 的 complete 已在飞、ShortCallQueue 仍被占着，直到内层自身超时才释放。这正是超时值必须单一来源的原因：registry 侧一旦被改小，外层会先放行下一个系统任务，而内层还卡着。

### 去重期间游标不提交的批次仍算进行中，后继抽取等 completeDedup 提交后再接续；去重 Input 不再重复 matches

去重期间（等待模型的几秒到几十秒）同来源的 capture 返回 queued 却不会立刻入队新任务；这批的轮数照常计入节奏计数，去重结束后够阈值就接着抽，不够就等空闲补抽。

去重任务如果一直不结束（队列卡住），这个来源的后续输入会一直并入这一批，直到任务失败或超时；memory_deduplicate 有超时，超时算失败，会走 abandonDedup 释放。

matches 里被 asDedupMatches 丢弃的畸形条目现在也不会出现在 Input 行里。MemoryService 生成的 matches 总是合法形状，所以只有手工构造的任务才会受影响。

### 去重候选改为关键词重叠召回（中文二元组 + 英文词，阈值 0.3）

去重任务会真正开始执行，每批有候选时多一次模型调用（输出上限 4096）。如果误召回导致模型频繁判 skip、丢掉新记忆，先把阈值调高再看。

粗筛有 LIMIT 50，按命中数优先：命中词多的先进入候选池，命中少的在库很大时仍可能被截掉，但截掉的是命中最少的，不再是最旧的。minShared 还让命中不足的行根本不进入排序。

shared ≥ min(3, 词数) 的下限会漏掉「只有一两个词的改写」：查询词不足 3 个时按词数算（词全中才算），3 个以上的查询至少要共享 3 个词。这对短记忆偏严，换来的是长记忆不会因为共享一个短语被召回。注意这个下限挡不住共享一个 4 字词组的情况（3 个二元组正好 3 个），要挡它得把下限提到 4 或把比例阈值提高，目前没做。

SQL 里每次要对当前范围内全部 L1 行做 lower、json_extract 和最多 64 次 instr，线性增长。本地实测（内存库、L1 5000 行、查询 55 个词）单次约 50–65 ms，每条新记录召回一次，这段在主进程同步执行。再大的规模要换成预存的小写 content 列或 FTS。

### 记忆抽取按上游节奏：每 5 轮一批、预热 1→2→4→5、空闲 600 秒补抽、启动后补抽

窗口外的消息被视为已处理，所以节奏越慢，单批里被跳过的早期对话越多。everyN 是 5 时，一批约 5 轮，正好落在 10 条新消息之内（每轮合并成 user + assistant 两条）。

如果某个来源的抽取每次都失败，每次启动会多试一次，不会无限重试：失败后只有出现更新的输入才会再入队。

失败后的重试要等阈值或空闲（默认 600 秒）才会再入队，比以前（每次 agent_end 都抽，重发即重试）慢。测试用 { everyN: 1, warmup: false } 保持旧的立即重试。

补抽受 MEMORY_EXTRACT 约束靠的是 capture 携带的 extract 标志，不是读设置：重启后要等第一次开着开关的对话进来才补抽，一直没有对话就一直不补。开关关闭期间被取消的空闲计时不会自动恢复，等该来源的下一次对话或下次启动。

启动补抽最多 5 条、新的优先、逐个落定；更旧的 pending 留给对应来源的下一轮对话，不会在这一轮被送去抽取。串行意味着某个来源的任务一直不落定（比如队列卡住）时，排在它后面的来源这一轮不会被补抽；dispose 会放行等待，不会挂住。

节奏状态不落库，重启后每个来源的预热从 1 重来；进程内的来源条目只增不删，每条只有几个字段。

### 抽取输出按上游宽松解析：剥 think、去围栏、对象里找数组、修复控制字符与 priority

贪婪地取 [ 到 ] 时，如果模型在 JSON 前后的文字里也写了方括号，括号里的内容通常解析不出来，按解析失败重试；括号里的内容恰好是合法 JSON 但不是场景数组（如 [1]）时，按上面的判定也会失败重试，不再被当成空结果。整段已经是合法 JSON 对象时不再对原文做贪婪正则：对象里找不到场景数组（如 {"l1":[…],"summary":"x"}）就原样交给 parseMemoryExtraction 的严格校验，同样可重试。解析失败时的原文在 service_tasks.raw_output 里，可以据此继续补容错。

### memory_extract 只送最近 10 条对话加 5 条背景，工具输出不进抽取；delta 只当游标

一批里超过 10 条之前的对话不会被单独抽取，提交游标时视为已处理，这和上游一致。工具输出里的事实（比如某个命令的报错）只有在 assistant 文本里转述过才会被记住。截断以「…（已截断）」结尾，模型能看出来。

service_tasks.input 仍存完整 delta（含工具输出），落库体积没有按比例下降，只是不再发给模型。

扁平 transcript 里工具输出中恰好以 `user: ` / `assistant: ` 开头的行仍会被当成对话进入窗口，这是 transcript 格式本身的歧义，旧的 messagesFromTranscript 也一样；彻底解决要让 sidecar 传结构化消息。

### L2 只内联与新记忆相关的场景正文（最多 3 个），没给正文的已有场景不许写也不许删

预筛靠关键词，相关场景用词差别大时可能漏选，模型就会新建一个本该合并的场景；场景数逼近上限时会全部内联、强制 MERGE，把这类重复收回来。场景文件名常带共同前缀（如「团队记忆-」），这类出现在多数场景里的词不再计分；代价是新记忆只含这类共有词时一个场景都不内联，该记忆只能走新建或靠摘要判断。场景少于 4 个时不做共有词过滤，此时共同前缀词仍会让每个场景各得一分，最多内联 3 个。被丢掉的写入或删除会在主进程日志里留一行 `console.warn('[memory] 丢弃对未提供正文场景的改动', 文件名数组)`，只在确有丢弃时输出；要看丢了什么改了什么，查这行日志，再对照 service_tasks.output 和 L2 的实际变化。

## Verification

verify: n/a 回填的历史决定，源记录（docs/decisions）未记录验证
