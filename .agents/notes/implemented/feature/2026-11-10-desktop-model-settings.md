# Agent Note: 桌面模型高级配置与按模型压缩预算

Status: implemented

## Problem

桌面模型编辑缺少 SDK 1.5.1 的采样、图片限制与缓存寿命入口。重建供应商配置会丢失未知字段和内置 modelOverrides；预算没有官方持久化 setter，空对象无法清除 applyOverrides 的深合并值。

历史审计：[SDK 1.5 接入](../../implemented/feature/2026-11-10-pi-sdk-1.5-feature-integration.md)、[OAuth 所有权](../../implemented/architecture/2026-11-08-pi-native-provider-oauth-ownership.md) 与 [压缩策略](../../implemented/architecture/2026-09-30-compaction-and-context-policy.md) 部分重叠，保留其决定。AgentData / 子代理检索的其余旧决定与本需求无关。

## Decision

### 原文档只更新明确编辑的字段

高级字段沿用 models.json；供应商原文档、未知字段及未编辑的模型兼容 / 价格内容保留。用户后续撤下内置目录高级覆盖入口，已有 modelOverrides 仍无损保留，同 ID 自定义条目保持替换语义，见[界面收敛](../simplification/2026-11-10-remove-chat-inspection-panels.md)。共享纯校验模块同时服务自定义模型编辑器与落盘边界，不执行凭据命令或网络。

高级请求参数与思考/消息/缓存等选项复用同一个 Collapse 分组，默认收起，不另设独立 h4 标题或外层面板。标题与正文沿用应用主题字号、字重和填充控件；JSON 与数值字段采用两列对齐，窄内容列降为单列。折叠仅影响展示，JSON 草稿和错误仍归模型状态持有，收起/重开或切模型后不能丢失，也不能让折叠绕过保存校验。

TTL 按真实 SDK 范围处理：省略继承，显式值为有限正数秒（允许小数）；无可继承寿命显示未知。SDK 不接受 null，非法手写 null 报错并保留原文件，不加 SDK 补丁或影子 TTL。

仅模型编辑保留旧 inline apiKey；用户明确修改 / 清空内置 Key 时才移除旧 inline 副本，由原专属 Key 命令写 canonical 凭据。自定义供应商的可选字段清除仍删除旧原文档值，不因原文档合并而复活。

真实 SDK fixture 另确认了既有认证语义：canonical OAuth 和 canonical API Key 优先，auth 删除后会回退 legacy inline Key。既有 logout 不清 inline 的语义不在本轮扩写，也不称为本轮引入或已经修复。

### 显式图片配额由公共调用边界执行

SDK 1.5.1 消费 resize，但只保留数量 / 请求字节的元数据。用户批准桌面补充预检。guard 只执行 models.json 明确声明的三个配额；目录原生未编辑元数据保留 SDK 原路径，不新增拒绝。公开 getRegisteredProviderConfig 仅包含扩展注册，因此来源从调用方已知 modelsPath / canonical JSONC 定点提取，不传出或执行凭据。

公共 ModelRuntime facade 放在观测 facade 外层，不修改模型 metadata。它保留原 onPayload 与原 fetch：先完成原 payload 回调，再在支持的 per-call fetch 边界解压实际最终 HTTP body，统计本次发出的图片及 UTF-8 未压缩 JSON 字节（不含 HTTP 头）。Anthropic server-thread 已省略的历史图片不计入，不删除附件、不重复缩图、不自动更换传输。

- OpenAI Completions / Responses、Azure Responses、Anthropic HTTP 支持数量与字节。
- Codex 仅调用方显式 SSE 支持；自动 / WebSocket 携带显式配额在网络前拒绝。
- Google 支持 onPayload 图数；最终 HTTP bytes 不可验证，显式字节覆盖在网络前拒绝。
- 未知协议及自定义 client 携带显式配额时明确拒绝，UI 禁用不支持项并保留清除覆盖入口。

### 预算的持久化和运行时回执分开

PI_MODEL_COMPACTION_OVERRIDES 只归 SettingsService 专属 patch / clear 所有。一般 replace 与预算 patch 共享同一设置文件串行边界，旧表单保留最新预算；不把模型配置与预算保存伪装成一个原子提交。

控制器只用公开 SettingsManager API 投射当前模型。clear 与 A / B 往返用同 cwd / agentDir / 信任状态的 fresh manager 解析最新可信基线，再定点还原，不 reload 活实例，不改 enabled 或其他偏好。压缩已捕获的 preparation.settings 保持原快照，下一次压缩使用新值；原百分比、续跑和取消策略不改写。

主会话、嵌入式子会话和冷恢复均安装同一个控制器。控制器按 active 生命周期登记，dispose 退订并卸载。保存回执同步全部本地控制器，再经独立 modelCompaction.sync RPC 汇聚所有已知 worker；未就绪、断开及空回执都明确失败。保存成功、部分同步失败仍保留磁盘偏好，可单独重试同步。

## Alternatives considered

- 复制目录模型为自定义模型：能复用同一张卡；不用，因为会冻结目录元数据并改变同 ID 替换含义。
- 直接编辑 SDK settings：只有一个来源；不用，因为 1.5.1 没有公开预算 setter，私有字段 / 未导出 storage 会产生版本耦合。
- reload 活 SettingsManager：容易消除深合并残留；不用，因为会清掉其他功能的内存覆盖。fresh manager 只读取可信预算，再定点应用。
- 只展示数量 / 字节元数据：代码最少且 SDK 将来可接管；不用，因为真实 AgentSession.prompt 已证明超限仍会发出请求，不满足实际约束。
- 在 onPayload 统一测最终字节：接缝更少；不用，因为 Anthropic 还会裁续传历史，Google 参数也不是最终 HTTP JSON，可能误计或伪报支持。
- 只用文件通知、不汇总子代理回执：通道最少，正常热更新可生效；不用，因为保存时无法说明未就绪 / 断开或读取失败的 worker，也无法单独重试同步。

## Verification

本轮折叠布局按 electron-ui-harness skill 完成，结果：通过。新证据目录：`.agents/evidence/2026-11-11-advanced-parameters-accordion/`。

- `cd electron-agent && npx vitest run src/features/settings/BuiltinModelEditor.test.tsx src/features/settings/ProvidersSettings.test.tsx src/features/settings/builtinModelOverrides.test.ts src/features/settings/providerConfigAdapter.test.ts`：4 文件 80/80 通过，accordion-green.log；accordion-red.log 先复现高级区没有默认收起，keyboard-red.log 复现 Space 不开合，keyboard-green.log 验证原生包装器处理后通过。Collapse 不转发 DOM 键盘捕获属性，所以监听放在原生包装器，仅高级标题响应 Space，不截取输入区空格。
- `cd electron-agent && npm run ui:check -- model-advanced-settings builtin-model-settings model-visibility`：首轮高级组键盘检查失败，任务随后取消；其中 builtin-model-settings 已记录 212/212、model-visibility 已记录 110/110 通过（ui-first-keyboard-red.log）。修正后仅定向复跑 `cd electron-agent && npm run ui:check -- model-advanced-settings`，最终 138/138 通过（advanced-ui-green.log）。本次共验证 3/54 个相关场景，其余 51 个未跑，不代表全量 UI 通过。
- 标题同级/同 Collapse、字号字重/内边距一致、默认收起、Enter/Space、非法与有效 JSON 收起重开、收起不能绕过保存、字段 14px/600 字重、帮助和代码 12px、filled 背景、宽两列/窄一列与无溢出均由真实 DOM/样式/输入事件断言。ui/ 保存默认折叠、高级组打开的完整模型卡和深浅窄屏截图；已检查浅色高级组实际布局。
- 样式探针首次误取 InputNumber 父节点导致页面脚本错误，另以[可见标签取样修正](../bug-fix/2026-11-11-advanced-accordion-probe-label-targets.md)记录；没有删除或放宽字体/布局断言。
- `cd electron-agent && npm run build`：通过（production-build.log）。定向 renderer 严格检查仍有原有 5 条 OAuth 类型诊断，本次组件和场景没有新增错误（renderer-typecheck.log），未宣称全仓类型检查通过。笔记校验与本次路径空白检查见 verify-notes.log、diff-check.log。
- 本轮只改渲染与验证，不改 SDK/config/网络契约，未读真实授权、未登录或请求付费模型。

证据目录：`.agents/evidence/2026-11-10-complete-desktop-model-settings/`，精确命令和范围见 [验收记录](../../../evidence/2026-11-10-complete-desktop-model-settings/README.md)。

- `npx vitest run <本 change 的13个定向文件>`：155/155 通过；原子代理 / 冷恢复状态机 83/83，百分比 / 续跑 / 取消回归 10/10。
- `npm run ui:check -- model-advanced-settings model-compaction-budgets`：35 + 26 项通过，只跑 2/52 场景；最终文案只追加 advanced 4 项检查，截图已查看。
- `node electron-agent/scripts/smoke-model-settings.mjs`：第三统一生产候选 19/19，通过真实 main IPC、host 全 owner 聚合（main / embedded / worker）、单项失败 / 其他成功、只重试同步、dispose 退订、worker 热更新 / 冷恢复和三个入口的 SDK 高级字段。
- CLI / Node noEmit 与开工基线对照分别为 82 → 82、169 → 169，新增诊断均为空。OpenSpec 20/20、all_done；最终整合的接续条件见同证据目录 HANDOFF.md。

## Consequences

模型文件与预算偏好有各自 dirty / 保存 / 生效状态；非法草稿保留，部分生效失败不重发回合或重写配置。预算记录不因模型改名 / 删除而自动丢弃，未匹配条目可显式清除。

模型配置、SDK 目录元数据和桌面执行能力是不同来源，界面明确区分。未来 SDK 真正执行这些配额后，应先按最终 payload fixture 核对，再删除本地 guard，不能在来源不明时对所有目录模型施加新拒绝。

真实供应商 / 登录 / 付费预热、正式安装包和正式应用重启不属于离线证据。调试曾因误用不存在的 agent.streamFn 而对 fixture.invalid 连接失败；已改用公开 streamFunction 和注入 fetch，最终请求 fixture 与生产入口均只用临时数据及本地受控传输。
