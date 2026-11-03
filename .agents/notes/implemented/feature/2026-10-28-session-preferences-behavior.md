# Agent Note: Fast 与同项目会话独立记忆的行为说明

Status: implemented

模式枚举与旧 Brainstorm 的兼容恢复以[移除 Brainstorm 产品模式](../simplification/2026-10-30-remove-brainstorm-mode.md)为准；本篇会话归属和其他偏好约束继续有效。

## Problem

同一项目内存在多份会话时，项目默认、工作区缓存、按模型记忆与会话选择曾混在一起：手动改模式/审查会反写项目默认，思考档位按模型跨会话记忆，首次继承值只钉在内存，模型/思考 setter 不带会话身份。A → B → A 的回显正确也不能证明实际请求和冷恢复使用同一组值。

本次把模型选项、思考档位、审查档位、工作模式作为四项独立的会话偏好落实。范围为同一项目、本机应用内的会话切换、草稿与恢复；未增加跨项目/跨设备同步或新的分屏布局。“审查档位”指输入栏 ApprovalPolicy（仅查看、请求批准、替我审批、工作区编辑、完全权限），不是代码审查模型的推理强度。

## Decision

### 一、原 Fast 共享规则（本节已被取代）

用户在后续交互中明确要求 Fast 也按会话独立。当前开关归属与发送路径以 [Fast 第五项会话偏好](./2026-10-28-session-fast-mode.md)为准；下表保留本篇当时的共享决定，能力声明和 provider wire 格式继续有效。本篇其余四项会话隔离规则继续执行。

| 状态名称 | 归属层级 | 初始值 | 切换后的表现 |
| --- | --- | --- | --- |
| Fast 能力声明 | 供应商模型配置 | 默认未勾选 | compat.supportsFastMode 严格为 true 且协议已接入才可用，不按模型名猜测。 |
| Fast 开启偏好 | agentDir，供应商＋模型共享 | 关闭 | 保存在 fast-mode.json，键不含 sessionId/sessionPath。同一供应商同一模型的会话共用，换模型读取目标模型自己的偏好。 |
| 实际 Fast 请求 | 每次经过会话请求钩子的供应商调用 | 能力与开启偏好同时满足才注入 | Anthropic 增加 speed=fast 和 fast-mode-2026-02-01 beta；OpenAI 系列增加 service_tier=priority。 |
| 外侧“快速”标记 | 当前模型能力＋共享偏好投影 | 读取保存值后显示 | 不依赖先打开弹层；读取失败可重试，保存失败保留原值。 |

Fast 与模型选择、思考档位、审查档位、Agent/Ask/Debug/Plan/Ultra 工作模式正交。它不降低思考档、不改写其它三项、不解除 Ask/Plan 限制，不清空草稿、上下文或已有正文，不主动取消/重发正在进行的请求。非推理模型仍可单独使用 Fast；其有效思考为 off 属于模型能力约束。

开启/关闭成功保存后，下一次执行请求钩子读取新值；同一轮工具循环的下一次模型调用也可生效。已经发出的 HTTP 请求和流不被改写。当前 SDK 的普通 HTTP 重试复用同一次构建的载荷，不重读开关；Anthropic strict-tool 400 降级重建载荷是另一路径。关闭只停止本扩展注入，不负责清除其它配置已经加入的服务等级字段。

撤销 Fast 能力后隐藏开关并停止注入，保留偏好供重新启用能力后恢复。标题、记忆等经 ModelRuntimeHost 的独立短调用不自动继承 UI Fast；缓存预热可能复用会话请求选项，不能笼统说所有内部短调用都不继承。

旧说法“Fast 强制低思考/关闭思考”“Fast 按对话保存”“一定等下一条用户消息才生效”“关闭必定标准服务等级”均不作为规则。真实账号的加速、计费和 prompt cache 命中未验证；Azure 在接入清单内，但本次 wire 测试未覆盖 Azure。

### 二、状态清单与实际归属

| 状态名称 | 归属及存储/读取依据 | 初始值 | 同项目切换后的表现 |
| --- | --- | --- | --- |
| 项目、工作区根 | workspace/cwd 项目级身份 | 当前项目 | A/B 共享项目身份与文件系统；不拿会话运行中 cd 的目录代替项目根。 |
| 模型目录、能力、档位映射 | 共享供应商配置，provider＋id 标识 | 当前可用目录 | A/B 共享能力更新，选择与请求偏好仍各自保留。模型消失不再自动选列表第一项。 |
| 项目默认 | runtime-settings 中规范化 workspace 键；SESSION_DEFAULTS 保存模型/思考，AGENT_MODE、APPROVAL_POLICY 保存其余两项 | 未配置时回退应用/SDK 默认，模式 Agent、审查 auto | 仅显式“设为项目默认”修改；不追改已初始化会话/草稿。 |
| 当前模型 | 会话 JSONL 的 session-preferences 及兼容原生记录；请求与回执带原 sessionPath/sessionId | 新草稿优先项目默认 → 应用 defaultSessionModel → 目录首项 | A → B → A 恢复 A 自己的选择；失效选择保留并提示重选，不静默替换。 |
| 当前思考偏好 | 同一会话记录中的 thinkingLevel；不再用全应用 byModel 覆盖 | 项目默认；缺省取初始模型默认 | 保存值原样恢复；模型能力只派生有效档。切非推理模型用 off，切回支持的模型恢复保存档位。 |
| 当前审查偏好 | 会话记录 approval；前后端会话投影均按身份索引 | 项目默认，缺省 auto | 原样恢复。Ask 禁用编辑且实际只读，保存的审查值不被覆盖；退出 Ask 后按原偏好生效。 |
| 工作模式 | 会话记录 mode；兼容 agent-mode/session-controls 自动状态变化 | 项目默认，缺省 Agent | 五种模式互斥；切换恢复自己的值。未确认 Plan 拒绝执行模式切换，不落错误的新值。 |
| 草稿四项偏好 | 独立 draft:<uuid>，localStorage 逐 owner 键 pi-session-preferences:<owner> | 创建时项目默认的一次性快照 | 草稿选择只写本地；两份新草稿不共享 workspace 桶；首发过户给新会话。 |
| 正文、胶囊、文件标签 | JSONL 路径或 draftId；localStorage pi-chat-draft:<encodedOwner> | 自己的快照或空 | 切换先存旧 owner 再读新 owner；旧 pi-chat-drafts 整表只读兼容。逐键写避免不同窗口抹掉其它对话。 |
| 图片、粘贴块 | 同一 owner，IndexedDB 独立桶 | 自己的存档或空 | 逐 owner 差量写；旧整表记录在读取时原子补成独立桶；图片 URL 由 data 重建。 |
| 上下文、工具卡、思考展开状态 | 会话/draftId＋稳定内容 ID，localStorage pi-session-view-state:<owner> | 无记录时使用原自动展开/收起规则 | A/B 相同 toolCallId 不串；重挂载/重载恢复；用户明确收起后流式追加不再打开。无稳定身份/ID时只用本地状态。 |
| 右栏标签、展开/占满 | ownerSessionPath/ownerDraftId 与每视图记录 | 未访问视图默认收起 | 会话与独立草稿各自恢复。首发只过户源草稿，后台完成不抢 B 的面板。dock 持久化仍是既有整表机制。 |
| 消息、运行回合 | 会话路径/ID、消息缓存与运行 handle | 本会话历史与运行状态 | 切走不等于取消 A。所有新发送/回执继续指向原会话；未绑定的新草稿不再用 workspace 上次路径猜归属。 |

### 三、持久化、读取与同步时点

后端 JSONL 是已建会话的权威来源，renderer 的 byOwner 只作缓存/乐观投影。`preferences` 保存请求值，顶层 model/thinkingLevel 表示当前 SDK 能力允许的有效值；两者可以不同，弹层明确显示“已保存 X；当前模型仅生效 Y”。

普通 setter 只改一个字段。模型改变后重新计算保存思考偏好的有效值，但不永久改掉该偏好。Fast 独立共享。模型/思考 setter 增加 targetSessionPath；模式/审查有 target 时不再反写项目默认。目标尚未加载但文件有效时用非前景 openAdditional 恢复它，不改其它窗口的选中会话；不存在或正在删除时明确拒绝。

写入按会话串行并捕获会话身份，session/manager 在实际写开始时固定。生命周期替换/删除等待在途偏好写。流程为 auth 预校验 → canonical 落盘 → live 应用；失败恢复原 live/canonical，并清除 SDK 先修改内存后 I/O 抛错留下的失败条目。回执包含 sessionPath、revision、applied、unavailable，不能把未持久化值广播为成功。

模型被移出目录时保留选择，请求入口 prompt/steer/follow_up 都拦截；模型回到目录后，出站前对齐保存的模型与思考偏好。原生显式模型变更也参与恢复；SDK 派生的 thinking echo/能力钳制不会抹掉保存档。无法从原生事件判明思考选择意图时保守保留请求值；输入栏显式 setter 不依赖这种推断。

| 同步路径 | 时点 | 是否写存储 |
| --- | --- | --- |
| 会话界面恢复 | 路径/scope 变化、进入或重挂时 | 只读原路径 getState；同 owner 多控件并发读取合并。不会通过 setter“恢复”。 |
| 快照与 setter 回执 | 后端读回/提交完成时 | 前端只更新该 owner；旧 revision 整包丢弃，在途点击字段受 seq 保护。 |
| session-preferences 广播 | 成功提交后 | 前端只投影到命名会话，不再次落会话日志；其它窗口可接收 model/thinking 更新。 |
| agent-mode/approval-policy 状态 | 启动、恢复、Plan 确认等 | 前端单字段投影；*-default 只改默认投影，不改会话。 |
| 历史缺字段兼容 | 首次恢复缺字段时 | 能恢复的旧字段保留，缺失初值补齐固化，之后不随新默认漂移。 |
| mode/approval 扩展工具同步 | 会话启动、下一轮开始前 | 正常恢复可只同步运行态/工具集；明确自动模式变化仍写自身状态，不等同于切会话写默认。 |

### 四、边界的处理结论

| 场景 | 已落实行为 |
| --- | --- |
| 新建对话 | 生成独立 draftId，从显式项目默认初始化；不继承最近会话；显式再点新建生成另一份身份。 |
| 重新打开已有草稿的项目 | 恢复当前草稿身份，不因为 openProject 重复调用而清空正在输入的内容；从其他项目返回时同步切回该草稿的 activeWorkspace，不保留错误的旧项目。 |
| 页面重载 | 已建会话从日志与后端快照恢复，草稿从本 owner 存档及 lastOpen.draftId 恢复；已被另一窗口使用的 works scratch 不再冒充未使用草稿。 |
| 复制/派生 | 新身份读取复制到该分支的记录；锚点之后的值不假装继承。缺失字段按会话恢复元数据/当前默认补齐，之后各自修改。 |
| 删除当前会话 | 有同项目其它可见会话时优先最新时间戳；复用手动打开的 token 流程，迟到结果不抢用户随后选择的 B。没有其它会话则走正常新建草稿流程，使用项目/应用默认。 |
| 多视图/多窗口 | 显式 Provider scope 优先于全局选择；宿主按原路径路由，成功提交推完整快照，进入会话刷新；旧回执不覆盖新版本或本地在途字段。未新增分屏布局。 |
| 切换期间的新值 | 修改和回执属于操作开始时的 owner。草稿首发使用 await 前快照和新建回执身份；不在完成后 getState(workspace) 猜目标。 |
| 首发模型不可用 | 不过户到未就绪会话；保留原草稿与四项偏好，提示先选有效模型。 |
| 首发期间切走 | 原消息仍走原会话 lane 与后台队列，侧栏同步也带原路径；失败只回填源存档，不写 B 的编辑器/错误态。 |
| 未绑定草稿切走 | 不把乐观消息/awaitingResponse 停靠在项目“上一次会话”名下，防止旧会话长挂准备中。 |
| 删除后的迟到回写 | 后端拒绝已失效目标；前端偏好、正文、附件、展开状态的删除墓碑阻止复活。 |
| 历史兼容 | 逐字段读取旧 model/thinking/agent-mode/session-controls；不因某一字段缺失清空整组；旧全局 approval 条目不当作本会话的显式选择。 |

## Alternatives considered

保留“最近一次选择同时成为项目默认”，能少点几次，也兼容旧操作习惯；但会隐式改变新对话与缺字段历史对话的初值，因此分离显式默认入口。

只加前端 sessionPath Map，改动少、回显快；但重载会丢、跨窗口无权威来源，workspace setter 仍可能写错目标，因此采用会话日志＋带身份路由，缓存不作真值。

继续按模型共享思考档，换模型可以沿用熟悉档位；但 A high/B low 使用同模型时相互污染，因此当前会话的思考偏好不再被全应用 byModel 覆盖。

把 Fast 顺带收回会话，输入栏状态归属会更统一；但最新明确决定是供应商＋模型共享，本轮四项独立记忆不翻转它，见[Fast 按模型偏好](2026-10-28-model-fast.md)。

对正文/附件保留整表快照写入，改动最少；多实例 RED 证明旧窗口会删掉其它窗口新桶，因此逐 owner 持久化。旧格式保留读兼容和删除遮罩，附件用原子 add 补迁，避免覆盖升级期间的新值。

## Consequences

同项目切换不再是“把工作区最近选择同步给目标”，而是读目标会话自己的快照。代价是新增会话字段、默认 API、owner 缓存、草稿 ID、修订/字段序号与兼容存储键。

正常会话、草稿、项目默认和 Fast 的归属分开。与[草稿整份恢复](2026-10-19-composer-draft-full-restore.md)、[右栏跟会话走](../bug-fix/2026-10-16-right-dock-session-binding.md)部分重叠：继续使用其编辑器 JSON、IndexedDB 和常驻右栏方案，仅替代 workspace 草稿共享与整表覆盖的边界，不归档旧记录。

保存值与有效值分开后，能力变化不再无声抹掉偏好。原生事件的思考意图存在信息不足的边界，显式 UI 设置仍是精确记录。回滚当前绑定 Pi SDK 1.3.0 的 manager 内部形状；升级 SDK 必须重跑真实 SessionManager 故障注入合约测试。该依赖不是任意 SDK 版本的保证。

未实跑两个原生 BrowserWindow 的端到端同步；已覆盖双 Provider 真实 UI、宿主路由/状态推送与多 store 共享存储测试。同一个尚未落盘 draftId 同时被两个窗口编辑仍采用后写覆盖，未实现字段冲突合并。dock 的既有整表持久化也未升级为跨窗口合并；这些不等同于四项已建会话偏好的宿主级字段合并。

## 验证

结果：本需求定向单测、真实 SDK 与相关 UI 通过；工程全量/依赖的已有诊断另列，不能据此宣称全工程干净。证据统一在 `.agents/evidence/2026-10-28-session-preferences-behavior/`，入口见[验证说明](../../../evidence/2026-10-28-session-preferences-behavior/README.md)。

- 主线程最终：ChatView、ChatInput、正文/附件、pendingSession、lastOpen、真实 agent store，7 文件、155 条通过，见 main-review-fixes-green.log；含创建期切换、失败回填、命令回执、未绑定草稿 shadow、旧附件迁移、多窗口存档。
- Renderer：19 文件、157 条通过；另有输入相关 61 文件、509 条回归，见 frontend-green.log 与 frontend-renderer-report.md。
- 后端：合并定向 207 条通过，含 runtime 106、真实 ModelRuntime/SessionManager/AgentSession 集成 9、IPC 与 host/settings；扩展 94、gren-runtime 最终 8 条通过；父代理另跑后端/真实 SDK/Fast 4 文件、124 条通过，见 backend-parent-final-green.log、factory-native-restore-green.log、backend-README.md。受控假 key、无付费外网请求。
- 展开状态：最终兼容复核 6 文件、96 条通过，见 view-final-compat-green.log。接入时发现的函数式 setter 回归单独记录于[展开 setter 兼容](../bug-fix/2026-10-28-session-view-updater-compat.md)。
- UI：session-preferences 98、model-fast 63、ultra-mode 74、plan-panel 59、codemode-card 55、invalid-arguments-card 27、composer-chips 30 条通过。只点名本次控件/状态实际涉及的 7/39 个场景，未跑其它全量 UI。附件场景旧复位错误另记[不改写权威存档的复位](../bug-fix/2026-10-28-composer-chips-reset-owner-storage.md)。
- 实际 include 渲染代码的 tsc 已消除本次新增诊断；依赖仍有 wikiContracts 缺失、旧组件类型等错误，见 renderer-types-final.log。不用 files:[] 的根 tsc 冒充渲染层验证。
- 项目未发现可用 verify-* skill，采用现有定向 vitest、真实 SDK 故障注入与 electron-ui-harness。根 verify-notes 的最终输出保存在 verify-notes.log。

### 主要实现入口

[共享偏好协议](../../../../extensions/_shared/session-preferences.ts)、[后端路由/默认/提交](../../../../electron-agent/electron/app/piRuntimeService.ts)、[冷恢复](../../../../cli/src/gren-runtime.ts)、[前端缓存与回执](../../../../electron-agent/src/stores/sessionPreferencesStore.ts)、[控件读写](../../../../electron-agent/src/features/chat/input/actions/composerPreferences.ts)、[模型控件](../../../../electron-agent/src/features/chat/input/actions/ModelThinkingAction.tsx)、[发送归属](../../../../electron-agent/src/features/chat/ChatView.tsx)、[输入草稿](../../../../electron-agent/src/features/chat/ChatInput.tsx)、[展开状态](../../../../electron-agent/src/stores/sessionViewStateStore.ts)、[UI 场景](../../../../electron-agent/ui-harness/scenarios/session-preferences.tsx)。
