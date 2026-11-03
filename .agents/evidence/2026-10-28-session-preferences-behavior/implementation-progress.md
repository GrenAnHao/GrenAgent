# 会话偏好实施进度

状态：已完成。最终说明在 `.agents/notes/implemented/feature/2026-10-28-session-preferences-behavior.md`，验证入口为本目录 README.md。主线程 155、后端最终父复核 124（含真实 SDK 9）、工厂 8、renderer 157；7 个相关 UI 场景 406 条断言通过；verify-notes 与 diff check 通过。所有本线程相关后台任务已收集，临时 config 已移入证据并从工程删除。以下保留为实施过程记录，不再作为待办。

规格：`.agents/notes/proposed/feature/2026-10-28-session-preferences-behavior.md`；用户已说“开始落实”。在当前共享工作区修改，保留所有其他未提交改动，不创建 worktree、不提交/推送。

## 分工（仍在运行的可继续子代理）

- `sa-fd91a59d` 后端（主要实现已落地）：`extensions/_shared/session-preferences.ts`、agent-mode/approval、gren-runtime、electron/app/piRuntimeService、settingsService/IPC；真实 SDK 集成测试 `electron/app/sessionPreferences.integration.test.ts` 6 pass、shared 20 pass、runtime unit84 pass、gren-runtime7 pass。正在 main project 回归与默认缺省补测。共享 `SessionPreferences` 请求值与顶层有效值分离；模型/思考 canonical 字段不能被后续 SDK 原生日志的能力钳制覆盖；模式/审查须继续读 Plan 等自动变化。生产对现存但 unloaded 的目标用 `openAdditional + switchSession` 非前景加载，不能一概拒绝，否则多窗口 A/B 不能同时编辑。删除/不存在仍拒绝。
- `sa-0af7b173` renderer 控件：ModelThinkingAction、ModeAction、ApprovalAction、mode/approval/fullAccess stores、lib/pi、sessionPreferencesStore、lib/sessionPreferences、input/composerOwner、actions/composerPreferences、相关单测。默认入口 selector 要求 `save-project-defaults`。AgentStoreContext 加 optional sessionPath/draftId。不得改主线程文件。
- `sa-5721dad5` view：sessionViewStateStore（已落地）、useSessionViewExpanded（已落地）、ContextToolGroup/ToolExecution/CodemodeCard/ReasoningInline、ThinkingSegment timestamp，另已追加 dockStore / useDockSessionSwitch 的 draftId 隔离。adoptDraftView(workspace,path,draftId?)：后台源只过户不抢当前面板，pendingDraftAdoption 仅当前视图源相符时设置。store/hook 先实现后测试的偏差须如实报告；其余先 RED 再 GREEN。
- 主线程：session.ts、pendingSession、lastOpen、ChatInput、ChatView、App、chatDraftStore、composerFiles，新的 session-preferences UI scene/probe，AGENTS 场景记录、集成、审查与证据。

## 已落实的主线程改动

- session.ts 新增 `draftConversationId`，`setDraftConversation(cwd,id?)` 生成 `draft:<uuid>`；`clearDraftConversation(cwd?,id?)` 防旧首发清掉新草稿。
- pendingSession 不再 import ModelThinkingAction 清共享缓存，进入新草稿先分配 ID 再清 active path。
- lastOpen 持久可选 draftId，启动 App 恢复 ID，works 内有明确 draftId 也恢复。
- chatDraftStore / composerFiles 新增 adopt、remove、resolveKey + runtime adoptions / removed；迟到旧草稿保存归创建会话，删除墓碑阻止复活；附件 hydration 过滤删除/映射 alias。
- ChatInput 使用 `useComposerOwnerKey`；失败回执只写发起 key，编辑器仅当原 owner 仍显示时回填；取消 overlay 后切走不清 B 编辑器；首次挂载迁移旧 workspace 草稿至新 draft ID。旧 draft alias 让当前编辑器内容在首发后的 effect 被存至创建会话。
- ChatView 已移除 workspace peek/commit。handleSend 在 await 前从 owner key 捕获四项；无 model 则保留草稿拒绝发。`pi.newSession(workspace, initialPreferences)` 必须从回执取 sessionPath/sessionFile，不再 getState(workspace) 猜目标；创建期间切 B 时只过户源草稿并向新路径发首发，不激活它/不覆盖 B。get/new setter 不再分别设模型/思考。已接 preferences/text/files/view adopt 与 dock adopt 第三参。
- App 删除成功后 remove 四类存档；lastOpen 恢复 draftId。
- 新 UI fixture/probe：`ui-harness/scenarios/session-preferences.tsx` 与 probes 同名。两个显式 scope 的真实四控件，同模型 A/B 不同档；普通修改不改默认、Ask、非推理保留请求档、Plan blocked、显式默认、两份草稿、上下文展开、remount/真实 reload、浅色。桥模拟宿主记录但要求 targetSessionPath，模型支持 reason/plain。scene host 假磁盘存在 localStorage 以供页面 reload 保留。待全部 worker 接入后运行并调试。
- AGENTS.md 已登记该场景，后续补 context/Plan 描述。

## 已运行证据

- `draft-red.log`：lastOpen/pendingSession 3 fail，缺 ID 与恢复。
- `draft-green.log`：2 文件 18 pass。
- `composer-adopt-red.log`：4 fail，缺 adopt/remove。
- `composer-adopt-green.log`：4 文件 35 pass（含 draft identity）。
- `chat-input-red.log`：20 中 1 fail，A 迟到失败回填 B 编辑器。
- `chat-view-red.log`：34 中 1 fail，首发期间切 B 后实际 prompt 发 B。
- 补充多窗口存储：正文改逐owner localStorage `pi-chat-draft:<encodedOwner>`，legacy整表只读，null遮罩；附件新adapter `input/composerFilesStorage.ts` 对 persist整表做本窗口差量，独立IDB owner key为权威、旧整表镜像兼容，idbStorage增加getKeys。两类真实多实例存储RED已复现丢失，最新19tests全绿，见draft-attachments-cross-window-green.log。
- `sa-7a3e8111` 正在只读审查主线程生命周期+存储，审查包main-review.diff（初版）+实际最新源码，报告目标main-review.md。请等结果，勿盲修。
- `chat-integration-interim.log`：ChatInput 20 pass，ChatView 当时因 viewStore 尚未落地 import 失败，不是产品回归。viewStore 现在已落地，下一轮复跑中。

## 当前主线程后台任务

- `bash-1984`：第二轮真实 UI `npm run ui:check -- session-preferences`，日志 `C:/Users/rxstudio/AppData/Local/Temp/pi-bash-514c3bc1bb58defa.log`，必须收集。第一轮63 pass/28 fail，多数因probe用了radio.value（恒on）和英文文案，现改data-level；context Text非span，改深层实际文字节点；选择标记每次清理，避免点旧项。仍需确认修正后是否有真实产品失败。
- `bash-1761` 已收集：ChatView 33 pass，`chat-view-green.log`。
- 先前 jobs bash-1197/1301/1396/1410/1425/1680 均已收集，结果已保存。

## 接口

共享类型 `SessionPreferences { model?:{provider,id};thinkingLevel?:string;mode?:AgentMode;approval?:ApprovalPolicy;revision:number }`。
后端 setter 回执 `{ok:true,sessionPath,sessionFile,sessionId,preferences,applied:fields[],unavailable:['model'|'thinkingLevel']}`；getState 同样附 preferences/unavailable，顶层 model/thinkingLevel 为有效值。新建回 `{cancelled:false,sessionPath,sessionFile,preferences}`。
get/set defaults 命令 `agent_get_session_defaults / agent_set_session_defaults`，args.preferences，直接返回 SessionPreferences revision0。
renderer store.getState(): `peek(owner): SessionPreferences|undefined`、`adopt(draftOwner,newPath,receiptPreferences?)`、`remove(owner)`；per-field seq/revision 防迟到回执。
owner hook：`features/chat/input/composerOwner.ts` 导出 useComposerOwnerKey / readComposerOwnerKey；scope 优先；draftId 是完整 `draft:<uuid>`。main 导入 lib/sessionPreferences 的 canonicalOwnerKey/sessionPathFromOwnerKey。
view store：`stores/sessionViewStateStore.ts` 导出 useSessionViewStateStore，getState().adopt(from,path)/remove(path)/isExpanded(owner,id)。上下文 key = `context:<first toolCallId>`，新 scene 为 `context:same-call`。

## 待办与已知风险

- 收集 bash-1761 并修 main 测试。ChatView.test 已 mock owner + prefs store，首发旧测试改成 atomic initialPreferences 契约；piNewSession mock 默认回 `${state.workspace}/created.jsonl`。
- 审查 ChatView 创建失败且已切走时返回值：目前旧 guard 返回 undefined，可能应返回 failed 以便 ChatInput 按原 key 回填（不会污染当前编辑器）。
- 删除当前会话期间用户改选 B，App 旧 wasActive 分支可能仍自动跳其它候选；应在成功回调确认当前仍空才自动选择，防抢回画面。
- 新 UI scene 尚未运行；控件 worker 完成后跑 `npm run ui:check -- session-preferences`，必要时修新 probe 选择器。Fast 行为被同一控件波及，点名 model-fast，必要时更新它的桥到 preferences/new defaults 契约；不要跑无关全量。
- worker 后端须报告真实 SDK/临时 JSONL 验证；检查模式/审查首次默认固化、失效模型阻止 prompt、mode/approval defaults 无 target 仍可显式编辑、fork/clone。
- 新增共享 tool 不在范围内，无需 prompt metadata（若后端新增工具则必须）。
- 验证后独立 reviewer 审查本次文件（不能误纳全工作区现有 diff），修真实问题；更新笔记 implemented，保留基线事实为历史标签，更新相关旧笔记部分重叠说明，verify-notes，提交用户可打开的最终笔记与证据说明。
- Goal `a432068e-13c4-4fe7-b5bc-bb47a53351d7` revision1 active，完成后必须 complete。
