# 并行子代理“启动失败”排查报告

后续状态：前端空数组展示缺陷已修复并验证，见 [修复验证](../2026-10-28-subagent-empty-array-display/README.md)。本文保留修复前的调查结论与代码行号，历史现场记录不变。

排查日期：2026-10-28。范围：`spawn_agent` 的入参、授权、调度、会话启动、直接依赖和结果卡片。仅新增本目录调查材料，没有修改生产代码、运行设置或他人已有改动。下列现场时间均为北京时间，原 JSONL 使用 UTC。

## 结论及证据边界

已证实两个不同的问题，不能统一称为“并行子代理进程启动失败”。

第一，截图“并行子代理 · 0 个”对应一个可稳定复现的前端缺陷：当模型调用单任务时同时填入 `tasks: []`，后端仍识别一个有效任务，前端却强制按组卡展开且只读空的 tasks 数组，最后显示零行。这既能隐藏成功启动的单任务，也能隐藏启动前拒绝的错误。这是解释截图的最强证据。

第二，今天本项目 10:42:15 有一次真实请求被拒，错误原文是“子代理已被禁用（设置 → 子代理 → 模型策略 = 禁用子代理）。如需使用请改为「继承父模型」或「选定模型」。”这是执行入口的配置门禁，发生在创建子代理之前。日志里的调用实际上是单任务后台 spawn。

13:29:19 的相同单任务参数形状成功创建 `sa-cbf156b7`，注册表随后为 done、exitCode 0。此次调查另执行一次真正 `tasks` 双任务并行检查，13:36:02 发起，13:36:04 返回，两项均 completed、failed 0。用户随后提供的新截图还能直接定位到 `sa-26f163fa`：该子代理 13:40:33 建立真实会话，13:40:35 已发起工具调用，随后的 bash、grep、read 工具结果均成功。因此新截图这次可以确认是界面漏显示，并非未启动；这不等于保证该子代理后续任务最终成功。

没有证据支持“所有并行任务都无法启动”。没有实测高于 2 的并行批次，也不能据此保证任意并发规模、worker 后端或供应商都健康。

截至本轮调查开始，本项目今天保存的主会话里找到两次直接 `spawn_agent` 调用：一次配置拒绝，一次成功；均不是非空 tasks 批次。另一个项目今天有两次成功的单任务后台调用。用户所说的其余多次现象尚未与具体会话时间逐一对应，不能替它们推断根因。调查期间另一个会话有新的成功调用，已在证据快照里按时间保留。

## 现场记录

原始失败会话：
`C:/Users/rxstudio/.pi/agent/sessions/--D--OneDrive-Project Files-Pi--/2026-10-28T02-27-42-014Z_01a18055-b13d-7250-9058-1f9de1e0bd30.jsonl`

- 第 36 行：10:42:15.639，`action: spawn`，非空 task，`tasks: []`、`chain: []`。
- 第 37 行：10:42:15.663，`isError: true`，上述“子代理已被禁用”原文，details 为空。
- 该请求从记录到结果约 24ms，结合执行入口代码，可以归类为启动前策略拒绝，不能归类为启动后退出或超时。

成功对照会话：
`C:/Users/rxstudio/.pi/agent/sessions/--D--OneDrive-Project Files-Pi--/2026-10-28T05-28-36-575Z_01a180fb-51df-7286-9055-c369174ce410.jsonl`

- 第 25 行：13:29:19.512，同样的单任务加空数组形状。
- 第 27 行：13:29:19.700，返回 agentId `sa-cbf156b7`、sessionPath、status running。
- `.pi/subagents/registry.db` 对应记录为 done，exitCode 0，完成时间为 13:32:35.464。该记录证明确实建立了子会话并完成，空卡不能当作执行失败。

真实双任务检查记录：
`C:/Users/rxstudio/.pi/agent/sessions/--D--OneDrive-Project Files-Pi--/2026-10-28T05-31-29-885Z_01a180fd-f6dd-7286-9055-c36d3b94b185.jsonl`

- 第 67 行：13:36:02.731，`action: run`，tasks 数量 2，两项均要求只返回固定标记，不调用工具。
- 第 70 行：13:36:04.553，count 2、failed 0；`sa-46370cb4` 和 `sa-23056277` 均 completed，分别返回 `PARALLEL_PROBE_ONE_OK` 和 `PARALLEL_PROBE_TWO_OK`。两份子会话建立时间相差约 3ms。
- 使用当时默认配置的 `custom-mvjk9w7k/deepseek-v4.1-flash`。该检查验证了真实执行入口、双任务调度、建会话、供应商请求和结果收集，未验证高并发压力。

用户最新截图对应的成功记录：同一成功对照主会话第 92 行，13:40:33.747 返回 `sa-26f163fa`、sessionPath、status running；第 94 行 send_message 返回投递成功。其子会话文件 `C:/Users/rxstudio/.pi/agent/sessions/--D--OneDrive-Project Files-Pi--/2026-10-28T05-40-33-030Z_sa-26f163fa.jsonl:11` 已有 13:40:35.848 的实际工具调用，第 12、13 行均为成功结果，第 14 行之后继续读文件。这个例子能直接将截图与“已经开工”联系起来。

运行诊断：
`C:/Users/rxstudio/AppData/Roaming/electron-agent/logs/runtime-diag.jsonl:52676`
在失败后约半秒的 agent-host 采样中，active 0、workerProcesses 0、heapUsed 67.6MB、heapLimit 4095.8MB、事件循环 p99 33ms；前后采样也都是 active 0。未看到该时间附近的 agent-host 非预期退出。当天日志里 12:39:15 的 agent-host 退出为 code 0、expected true，不能据此认定崩溃。采样不能排除采样间隙的全部瞬时情况，但与这次入口明确拒绝的证据一致。

可独立核对的精简快照见 [evidence.json](evidence.json)，测试日志及复现输出见同目录文件。

## 根因一：前后端对合法单任务参数的解释不一致

最小输入：

```json
{"action":"spawn","task":"只回复 OK","tasks":[],"chain":[]}
```

实际路径：

1. `extensions/multi-agent/tasks.ts:230` 的 normalizeTasks 先读顶层 task，再追加非空 tasks 项，得到一个任务。`index.ts:681` 使用此结果。空数组没有让后端任务消失。
2. `electron-agent/src/features/panels/subagentUtils.ts:60` 的 argsLookParallel 只判断 tasks 是否为数组，`[]` 也返回 true。
3. `electron-agent/src/features/chat/messagePrecompute.ts:57` 把这个 true 传为 expandSubAgents 的 asGroup。
4. `subagentUtils.ts:748` 在 asGroup 下改用 explicitWorks；`subagentUtils.ts:630` 的 explicitWorks 只遍历 tasks，忽略顶层 task，返回空数组。
5. `electron-agent/src/features/chat/ChatMessageItems.tsx:123` 因 argsLookParallel 为 true 跳过单任务卡，`:141` 渲染组卡；而 subAgentMode 在 `subagentUtils.ts:694` 实际返回 single，模式判断也不一致。
6. `electron-agent/src/features/chat/SubAgentGroupInline.tsx:282` 将非 chain 一律称为“并行子代理”，`:297` 显示 units.length，因此得到“0 个”。`:263` 只统计已有行上的 error；没有行就没有失败数。其 props（`:198`）不接收 result，整条调用的错误正文也没有进入这张组卡。

这同时解释了为什么成功和失败都可能看起来一样。与调用方有关的触发输入来自模型生成的工具参数，不是用户手工填错。该形状符合当前后端 schema：task、tasks、chain 分别为可选字段，没有禁止空数组（`extensions/multi-agent/index.ts:510`、`:517`、`:519`）。不能通过责怪调用者或修改后端并发上限来修好它。

还有一个同源的边界缺陷：同时提供 `task: "A"` 与 `tasks: ["B"]` 时，后端识别两个任务，前端 asGroup 只显示 B。它支持统一展示归一化的修复方向，不意味着今天确实发生了这种混用。链式调用若同时带 `tasks: []`，也会在 asGroup 分支丢失 chain 步骤，显示“链式子代理 · 0 步”；需要一并纳入修复验收。

同一空卡还影响后续结果归并：`messagePrecompute.ts:43` 把单代理后续取回结果归并到原卡 overlay 并隐藏后续卡，而 `ChatMessageItems.tsx:125` 只有单任务分支读取 overlay，组卡分支不读取。因此不能只改组头计数；任务身份、详情入口和后续结果展示也必须恢复。该影响由代码与只读子代理的函数复核支持，不代表今天所有历史调用都走过此后续路径。

## 根因二：至少一次请求命中禁用策略

`extensions/multi-agent/index.ts:621` 在 run/spawn 入口读取 SUBAGENT_MODE，等于 disabled 就抛出现场原文；创建子代理、并发预占都在后面。本次没有缺凭据、进程创建失败或模型超时的证据。

设置项定义在 `electron-agent/src/features/settings/settingsSchema.ts:458`。排查时 runtime-settings.json 与 settings.json 均为 SUBAGENT_MODE=custom，默认模型为 `custom-mvjk9w7k/deepseek-v4.1-flash`，SUBAGENT_MAX_PER_SESSION=20，启用模型自选且白名单含该路由。

当前文件值不能反证过去的 disabled。`extensions/_shared/runtime-config.ts:80` 的优先级是会话 WorkspaceContext.config、运行配置文件缓存、进程环境。`electron-agent/electron/agent/workspaceHandle.ts:162` 在 prompt 时解析配置并放入该轮上下文；`electron-agent/electron/app/piRuntimeService.ts:732` 构造这份配置。因而尚不能判断历史的 disabled 来自当时的设置，还是一轮仍持有旧配置；没有配置修改审计或该轮完整生效快照，不能声称是用户主动关闭，更不能直接认定热更新损坏。

区分办法：在保存设置和开始新轮时分别记录 SUBAGENT_MODE 的有效值及来源。如果新轮是 custom 且仍抛 disabled，继续查配置传播；若只在更改设置前开始的旧轮拒绝，属于轮次配置快照边界。无需先重写共享配置系统。

## 失败模式排序与区分特征

排序针对本次截图和找到的现场；后面的候选并非已经发生。

| 排序 | 模式及当前判断 | 可以区分的特征与代码位置 |
| --- | --- | --- |
| 1 | 展示层误分组，已复现 | task 非空、tasks 为空，后端一项、前端零行；成功和失败都能出现。见上述六步。 |
| 2 | 配置门禁拒绝，现场已证实一次 | 工具结果 isError=true，原文“子代理已被禁用”；没有新子会话。`index.ts:621`。 |
| 3 | 调用组合不支持，代码存在，现场无该错误 | action spawn 只支持一个归一化任务（`index.ts:1008`）；chain 不支持后台 spawn（`:843`）；fork 只支持单任务（`:823`）。应直接返回明确入参错误，不是进程启动失败。 |
| 4 | 名额或资源不足，现场未证实 | 每会话超额整批拒绝并给出当前/请求数量（`index.ts:753`）；全局顶层活跃默认 8，超过排队（`active-runs.ts:19`、`:35`）；worker 默认 2，超过排队（`worker-session.ts:39`、`:44`）。应区分“排队未开始”与失败。检查是否有旧驻留/未结算任务占名额；没有本次锁冲突、OOM、429、连接配额错误证据。 |
| 5 | 真正启动或初始化卡住，候选 | 默认后端为进程内，不是每项必起独立进程（`manager.ts:84`）。worker 路径才依赖 PI_WORKER_ENTRY（`runner.ts:63`），spawn 和 error/exit 在 `worker-session.ts:75`、`:110`。ready 等待（`:104`）没有自身期限；一次性运行的超时在 await open 之后才装（`embedded-runner.ts:546`、`:554`）。这是初始化挂起的潜在缺口，不能解释24ms策略拒绝，也没有现场证据证明发生过。 |
| 6 | 建会话后上游停流、超时、退出，候选 | 应已有 sessionPath 和对应 JSONL；结果区分 model error、idle timeout、startup timeout、hard timeout，逻辑在 `embedded-runner.ts:554`、`:585`、`:609`、`:615`。子代理内部工具长时间运行不等于启动失败。今天找到的该请求没有这些错误。 |
| 7 | 编排重复拉起或状态清理，现场未证实 | 对比同一 toolCallId、registry 的 agentId/parentId、创建/结算时间。并行 runOne 单项捕错并继续兄弟任务（`index.ts:1439`），结束释放预占（`:1448`、`:1515`）；detach 会让 run 返回而子代理继续，不应当作失败。没有日志证明今天发生重复启动。 |

上游鉴权、路径与版本错误也应落入第 5/6 类：要用实际错误和选中的 backend/provider 区分。现在成功调用证明了当前这一路模型和进程内后端可用，不能据此保证另一个供应商、worker 或另一组凭据可用。

今天已有未提交的授权修复，见 `.agents/notes/implemented/bug-fix/2026-10-28-subagent-authorization-before-launch.md`。它删除参数未写完就产生启动副作用的路径，修的是授权顺序。该笔记也明确没有原始现场入参，不能把那个漏洞当成此次截图的既定根因。当前代码等待完整参数生成及授权后才启动，会增加参数流阶段的等待；这也应与初始化失败区分。

## 修复优先级、影响面及副作用

| 优先级 | 建议与适用范围 | 影响面、收益与代价 |
| --- | --- | --- |
| P0 | 统一前端任务归一化和模式判定，空 tasks 不应覆盖有效顶层 task；保留流式真正未闭合任务的等待状态。覆盖新调用和历史回放。 | 直接影响 subagentUtils、messagePrecompute、ChatMessageItems；再影响任务序号、标题、模型信息、详情入口和 follow-up 归属。修复空卡也会改变旧消息的显示和序号，值得改，但须覆盖单任务、真并行、链式、流式、task+tasks 混合输入。不要只把 Array.isArray 改成 length>0 就认为混合输入也修好了。 |
| P0 | 组卡接收并显示调用级错误；即使没有任务行，也显示“未启动/被拒绝”及原文。 | 改 SubAgentGroupInline 的展示契约和 ChatMessageItems 传参；影响所有并行/链式组卡和现有测试/harness。需区分整批启动前拒绝与部分任务失败，避免把部分成功整批涂成失败。 |
| P1 | 配置侧给出有效禁用状态及来源；旧轮与新轮分开复核。 | SUBAGENT_MODE 是所有 run/spawn 的共同门禁，修改 getConfig/WorkspaceContext 将影响其他扩展与调用方。先补来源证据，只有证明传播错误才改共享配置。不能为了让任务跑通而绕过用户禁用策略；恢复启用会允许模型请求并产生费用。当前已是 custom，不需要本次调查再改设置。 |
| P1 临时绕行 | 单任务只传 task，省略未用的 tasks/chain；真正并行用 action run + 非空 tasks。需要后台并行时分别发单任务 action spawn，以各自 agentId 和结算通知跟踪。 | 只改变调用形状，通常不触及共享代码。若供应商适配强制填空字段，仍须前端兼容，不能仅靠提示词杜绝。多个后台单任务会产生独立通知，调用方要保存各自身份。 |
| P2 条件修复 | 只有捕获到“进程/会话初始化一直未就绪”后，再为 ready/open 加初始化期限与取消清理。 | 涉及 worker-session、共享会话 opener、RPC 与名额释放。默认期限过短会误杀冷启动、扩展加载慢的任务；必须保留阶段诊断并测释放。不适合拿来修本次空卡。 |
| P2 条件调参 | 只有名额/配额证据匹配时，才分批、降低并发或调整上限。 | MAX_ACTIVE 对同宿主所有会话共享，MAX_WORKERS 影响独立进程，MAX_PER_SESSION 影响会话任务接纳。提高上限会增加内存、连接与费用；当前没有理由先调大。 |

## 已执行验证与修复后的验收

已执行：

- `node node_modules/tsx/dist/cli.mjs --tsconfig electron-agent/tsconfig.json .agents/evidence/2026-10-28-parallel-subagent-investigation/reproduce.mts`，退出 0，五组实际生产函数输入均确认当前行为，输出见 [reproduce.txt](reproduce.txt)。前两例确认的是缺陷存在，不代表修复验收通过。
- `cd extensions; npx vitest run multi-agent/index.test.ts multi-agent/active-runs.test.ts multi-agent/worker-session.test.ts`：3 文件、106 项通过，见 [backend-tests.txt](backend-tests.txt)。使用 mock 的回归测试不能替代真实模型启动。
- `cd electron-agent; npx vitest run src/features/panels/subagentUtils.test.ts src/features/chat/messagePrecompute.test.ts`：2 文件、66 项通过，见 [frontend-tests.txt](frontend-tests.txt)。现有测试未覆盖本次触发形状，全部通过与空卡缺陷不矛盾。
- 上述真实双任务探针全部完成；两个调查子代理也同时建立了真实子会话。未做高并发压测；未运行 UI harness，因为本次只调查、没有修改 UI，也没有声称已完成 UI 修复。

修复后最小验收路径：

1. 相同单任务同时带 tasks:[]/chain:[]，成功时显示一个真实任务、正确身份/详情入口；历史回放也一致。
2. 用隔离测试配置 SUBAGENT_MODE=disabled，确认不创建子代理，而且界面显示拒绝原文。无需改正在使用的全局设置。
3. 真正 action run + 两项 tasks：两项都有 agentId/sessionPath，并分别显示运行和完成。再重复下一批，确认名额归还。单项失败时兄弟任务仍完成。
4. 覆盖 task+tasks 混合输入、纯 chain、未闭合参数流、取消和 run 转后台，保证数量及身份不丢。
5. UI 改动应在现有 subagent-history / subagent-detached 等直接相关场景中加入本次输入，经真实组件和事件链跑到 PASS；不扩展到全量无关场景。
6. 若另有高并发故障，再按 1/2/4/8/9 做受控分级验证。超过默认活跃 8 后应排队、结束后继续，不能直接按未全部开跑判失败；worker 专测需按上限 2 观察第 3 项。应先用 stub/deferred 验证名额行为，实模型仅做必要的小批次验证。

再次复现时，最小排查顺序是：同一 toolCallId 的原始 args + toolResult → 是否有 agentId/registry 行 → 是否有 sessionPath → 子会话首次事件和终态 → 对应时间的 host 诊断。这样能明确区分未获准、排队、初始化未完成、启动后出错和单纯显示遗漏。

## 尚需补充的最少信息

不需要重新提供今天所有现象。对于未被上面两条现场记录覆盖的任意一次，只需先给“所在会话/项目 + 大约失败时间”，以及“0 个是一直保留还是稍后恢复”。有这个定位点即可继续从本地记录提取错误原文、并发数量与调用形状。

只有该会话日志已丢失时，才需要补一份最小信息：现象属于立即报错/一直等待/很快退出中的哪种；错误原文；大约时间；请求任务数；是否刚改过子代理策略、模型、后端或更新应用。当前没有证据把其余多次都归为同一个原因，也没有证据把历史 disabled 的来源归咎于某一次设置修改。
