# Agent Note: 子代理通信与后台结算使用可折叠的语义卡片

Status: implemented

## Problem

send_message 的参数里有完整消息，但通用工具卡只显示投递回执。agent-message、subagent-settled 和 job-done 复用通用提示条，参与方、结果和诊断缺少语义区分。唤醒型通信还会作为普通 user 消息进入接收方会话，实时路径没有完整呈现。

## Decision

仅修改桌面展示及其消息投影，不改运行、消息生产者、协议和调度。通信卡显示发送方、接收方、完整 Markdown 正文、投递状态与已有时间，默认展开并支持收起；唤醒策略与回执确认的事实分开，失败不冒充送达。子代理详情提供自己的身份，不能借用父会话 store 冒充发送方。

后台 bash 与子代理结算沿用紧凑的可折叠行，默认收起；标题显示任务身份、成败及已有退出码，展开后显示真实结果与诊断。`aborted` 明确写成“会话已中止”，其正文标为“已保留的回复”，不把会话释放状态等同于任务结果。移除类型标签、重复结论和写给模型的工具操作指令。长正文沿用限高滚动，保持全文，不以一行省略代替正文。子代理启动卡保持既有默认展示，不把任务、中间输出和最终结果额外铺到卡片外面；完整子代理对话保持原入口与时间线。

原 custom 消息的 details 与 timestamp 保留到 notice 展示投影，历史和实时共用。后台 bash 通知没有输出及开始时间，通过同一展示会话中的原 bash 结果查得 jobStartedAt，再复用只读 job_snapshot 获取留存输出与耗时。MessageTimelineContext 提供实际展示的会话，子代理不会误查父会话启动记录。字段取不到时在展开体简洁说明，不猜输出和耗时。现有前台等待转后台、任务执行及取消逻辑不变。

## Existing notes audit

- [不唤醒通信](../../implemented/feature/2026-10-12-send-message-without-waking.md)：部分取代其默认收起展示决定，投递语义和原验证记录保持有效。
- [子代理重新设计](../../implemented/architecture/2026-10-11-subagent-redesign.md)：保留运行协议、启动卡原样和完整对话入口。
- [每次 bash 都是 job](../../implemented/architecture/2026-09-12-own-bash-every-call-is-job.md)：复用既有快照入口，不改任务生命周期。
- [快照重叠吞同文消息](../bug-fix/2026-10-28-agent-notice-snapshot-overlap.md)：验证中单独复现并记录的边界修复，不用正文存在性吞掉独立发送。
- [子代理空数组展示](../../implemented/bug-fix/2026-10-28-subagent-empty-array-display.md)：保留本轮开始前已有的兼容逻辑及未提交改动。

## Alternatives considered

- 所有卡片常驻展开，并把启动任务与中间输出外铺。最强理由是无需额外点击即可通读；不采用，因为用户进一步明确要求可折叠、启动卡沿用默认展示，而且后台终态外铺长命令与重复说明破坏了现有时间线密度。
- 只把通用提示条默认展开。最强理由是改动小且继承视觉约定；不采用，因为 send_message 正文仍遗漏在参数里，也无法区分参与方、终态和结果来源。
- 修改生产者协议补充统一事件。最强理由是所有信息可结构化获取；不采用，因为本次只处理展示，旧历史也无法由协议变更补回。

## Consequences

通信正文默认可读且能收起/展开，折叠头保留双方与投递状态。后台结算默认紧凑且可展开完整结果，成功、非零退出、失败、取消、超时和未知可区分。启动卡不新增外铺内容。空值、超长正文、同文独立发送、重复帧和乱序消息保持可读；终态不会被迟到开始帧覆盖。普通消息与注入沿用原展示。

常驻的通信正文会增加消息高度，使用既有限高滚动并允许收起；后台输出读取是只读快照，不消耗模型侧输出游标。

## Data limits

旧历史未必保留耗时、精确当前代理 ID 和完整参数。codemode 历史只保存最多 200 字参数预览，无法恢复全文；必须标明预览可能不完整及回执未保存。完全同文同毫秒的独立 custom 消息没有实时稳定 ID，无法可靠区分。超时没有独立协议字段，只匹配终止原因中的明确超时措辞；诊断引用 `timeout.test.ts` 不归为任务超时，保留原原因供核对。

## 验证

实跑结果：通过。使用 electron-ui-harness 验证 `agent-message`（36 项）、`task-notices`（37 项）、`subagent-conversation`（41 项），共 114 项；只跑这三个相关场景，没有跑全量。`final-ui.txt` 保留首次终态场景两条测量断言失败，修正 probe 字段与耗时格式后单独复跑通过，见 `ui-task-notices.txt`。

专项 vitest 的 11 个文件 208 项通过，另对超时文件名误分类补充负例，4 个终态模块共 60 项复验通过；具体命令见证据 README 和 `final-lifecycle-tests.txt`。覆盖解析、折叠、缺字段、历史/实时投影、重复与乱序。另按用户给出的 `sa-1d7293f9` 对照真实 JSONL：助手先正常 stop，随后会话 tornDown 并按 aborted 结算；证据 `status-origin.md`。澄清会话与任务的展示文案后，2 文件 37 项单测、task-notices 的 37 项 UI 检查通过（`completion-status-tests.txt`、`ui-task-notices.txt`）。

证据在 `.agents/evidence/2026-10-28-subagent-message-rendering/`，含截图、日志和可复现的定向 tsc 配置。定向 tsc 仍报 `messageActions/types.ts` 的既有相对导入与 `StreamingCodeView.tsx` 的既有 Shiki 主题类型错误，不能据此宣称全项目类型检查通过。本仓库没有适配本需求的 verify-* skill，以真实 Electron 组件检查与 vitest 作为实跑证据。
