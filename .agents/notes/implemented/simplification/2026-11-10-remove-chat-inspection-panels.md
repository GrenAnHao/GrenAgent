# Agent Note: 撤下会话树和请求观测面板

Status: implemented

## Problem

用户明确反馈会话树和请求/缓存预热展示没有必要、界面难看且耗时过长。它们在输入框上方增加两个独立入口，偏离简洁聊天主路径。

## Decision

从真实 ChatView 移除 SessionWorkflowLauncher 与 CurrentRequestDetails 的挂载及导入；供应商测活也移除 RequestObservationDetails 及仅用于它的请求状态。设置页移除模型压缩预算导航/页面及缓存预热三档字段。不重画面板、不迁入另一处可见入口。保留 SDK 1.5.1、必要底层兼容、严格历史读取/导入安全与可信记账，避免回滚已修的数据一致性问题。C 的新面板不再作为本轮交付，原请求观测笔记中的展示入口事实由本决定取代；供应商已有测活的正文、思考、指标和取消保持原样。

## Alternatives considered

- 重设计为更漂亮的面板可保留全部新操作；不用，用户明确认为没有必要，继续花时间打磨不符合当前目标。
- 连同底层全部回滚能减少代码；不用，会撤掉 SDK 兼容、历史保真及防重复计费等已验证修复，且可能破坏既有入口。

## Consequences

用量页的预热用量明细表也按用户要求移除；助手调用明细、费用汇总、来源分类及底层账本保留，不删除或重算已发生的用量。

设置页的「模型压缩预算」独立页面和「缓存预热」三档字段也按用户要求撤下，不设替代入口。原有自动压缩百分比及一般设置保存保持；不清空已保存的预算或 SDK 预热配置，UI 不再为已撤下的控件读取/写入专属配置。

用户进一步要求撤下供应商的「请求元数据」面板及「内置目录 · 覆盖高级参数」入口。测活保留原有指标与输出，自定义模型高级参数保留；删除仅为内置编辑器服务的目录状态与加载，不删除用户已保存的 modelOverrides，普通保存继续原样保留。

2026-11-11 用户重新批准内置模型复用自定义模型卡片；仅上述「内置编辑入口撤下」决定由[内置模型参数定点编辑](../feature/2026-11-11-builtin-model-parameter-editing.md)局部取代。请求元数据及其他面板仍保持撤下，本篇不整体归档。

聊天区不再显示这两个入口；新抽屉中的上下文编辑与导入导出也不作为本轮桌面入口交付，底层兼容接口保留。用户另批准包更新留后续，未启用检查点保持未完成。

## Verification

预热用量表撤下：UsagePanel 单测2项、usage-provenance 真实界面8项通过，深浅明细截图已检查；其他调用明细、费用总额与来源仍正确，未删除底层预热记录。证据 `.agents/evidence/2026-11-10-observe-desktop-model-requests/warming-table-removal-ui.log`、`warming-table-removal-unit.log`。

预算和预热设置撤下：两个真实 SettingsPanel 场景各8项通过，检查入口/字段不存在、原自动压缩仍可见、打开/保存不读写专属配置、已有预算/预热模式不变；深浅截图已检查。schema/form 两文件32项通过。证据 `.agents/evidence/2026-11-10-complete-desktop-model-settings/budget-warming-removal-green.log`。

后续两处设置页撤下验证：ProviderDiagnostics / ProvidersSettings 定向单测 26/26；provider-diagnostics 43/43、model-advanced-settings 33/33 通过，实际截图已检查，只跑这2个场景。验证已保存的内置覆盖在普通保存中原样保留、自定义模型仍可编辑；生产构建及 notes 通过。证据位于 `.agents/evidence/2026-11-10-complete-desktop-model-settings/settings-panels-removal-ui.log`。

真实工作台 workbench-layout 246/246 通过，包含两入口不存在、正文/草稿/窄屏与深浅主题；实际截图已检查。生产构建通过。证据：.agents/evidence/2026-11-10-complete-desktop-session-workflows/chat-panels-removal-green.log 与 chat-panels-removal-build.log。只跑1个场景，其余51个未跑。
