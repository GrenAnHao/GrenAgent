# 会话底层验证 checkpoint（UI 已撤回）

用户最新撤回本轮新增的会话面板／入口及请求／缓存预热详情入口。root 已移除 ChatView 的可见挂载；这里保留底层严格导入、历史保真、candidate 安全与既有 entry/port 兼容证据。上下文编辑和导入／导出为底层已验，当前不通过本轮抽屉交付 UI。旧候选截图不是当前产品界面；35 个生产断言通过不代表原 35 项桌面任务已交付。

本轮交付已按用户进一步授权收敛到 SDK 升级、模型配置及必要底层兼容；D 包更新留待后续。root 的 workbench-layout 246/246（含两入口缺席断言）通过，确认聊天界面不含这两块；C 不再修改产品源或新增替代入口。

## 最后有效底层证据

- `production-packaged-final.log`：第五真实字节码候选 35 项底层断言通过；包含 native omit／压缩窗外原文、只读路径预览、来源多级归一、伪造历史不入账和缺 registry 冷恢复。结果在 `packaged-final/production-ipc-results.json`。
- `packaged-final/cold-recovery-report.json`：新调用绑定 fixture-2 的新持久终态条目与随后 settled；本机累计保持 35 tokens／3 条，未放宽硬断言。初次旧完成等待命中已保留在第四候选失败日志中。
- `strict-history-source-green.log`：role 必需字段、合法旧版／system／retain-none、历史保真定向通过；`candidate-failure-matrix-green.log`：canonical staging／构造／发布／rebind／选中故障均保留源。
- `root-node-types-fifth.log`／`root-types-comparison-fifth.json`：Node 169，与原基线归一新增／移除 0；CLI 原 82 无相关新增前提。
- `packaged/html-offline.log`：实际 SDK 官方 dark HTML 离线 8 项通过，远程请求与浏览器错误均 0。资源／隔离实现未变，后续候选复用该证据。
- `review-harness-final.log`／`review-context-final.log`：撤回前候选的 tree 18、context 11；portability 原 10 有效，共 39 项历史 UI 证据。截图在 `screenshots/`，后续不打磨、不作为当前可见 UI 交付。

## 基线

前一稳定候选对照：`.agents/evidence/2026-11-10-pi-sdk-1.5-feature-integration/node-types.log`（169）、`cli-types.log`（82）及 `types-comparison.json`。其后到本轮授权只写 OpenSpec 规划。C 开工的 tracked dirty 清单和目标原改动保存在 `preexisting-status.txt`／`preexisting.diff`。首次 C Node 命令错误使用 `--incremental false` 被 composite 拒绝，未冒充类型检查通过；当前使用 `--noEmit --tsBuildInfoFile` 临时路径，新增模块诊断单独对照。

## 保留的底层接缝与已撤回的候选 UI

- 已撤回候选 UI：SessionWorkflowLauncher／SessionWorkflowPanel，不再通过 ChatView 暴露。agent store、历史标记、composer owner 接缝与底层兼容代码保留。
- 授权与 IPC：agent_session_workflow 原生命名文件对话框 → pi.sessionWorkflow → PiRuntimeService.sessionWorkflow → owner／portability／candidate；既有 fork-only ports 原契约保持，生产 WorkspaceHandle 通过可选 stageFork 回调受管增强。
- SDK／恢复：SessionWorkflowData、SessionWorkflowOwner、SessionCandidate、candidateRequests、createWorkspaceHandle／AgentHost；旧 compaction-policy pulse snapshot 和 session-memory 分支失效。
- 说明：`docs/session-workflows.md`。

## 定向证据

- `data-red.log`／`owner-red.log`／`candidate-red.log`／`portability-red.log`／`ui-red.log` 记录首次缺失行为；后续结构、迁移、有效工具配对红绿日志分别保留。
- `all-directed-current.log`：12 文件 238 条通过（当时候选）；后续新增分支摘要、取消、截断锚点及恢复项见 `sdk-summary-green.log`，最终候选另留最终日志。
- `legacy-contract-restored.log`：旧 PiRuntimeService 118 条、mainBindings 13 条原断言通过。曾误给旧 fork-only ports 新加强前提，已恢复原入口；升级测试迎合新前提的改动已定点撤回。
- `production-source-ipc.log`／`production-ipc-results.json`：真实源码 host 子进程、1.5.1 SDK、临时目录和 loopback 模型传输。历史 15 tokens／1 条，复制及重复导入后不增；用户主动新请求后 25 tokens／2 条，补录不增。保存后刷新与 SDK 导航后置失败采用测试边界注入，生产代码没有测试开关。
- `actual-sdk-session.html`、`html-offline.log`、`actual-sdk-html-offline-results.json`／PNG：实际 SDK 导出文件在独立无 Node／preload 的 Electron 离线 renderer 内检查，全树、旁支、工具、代码可读，远程请求 0、浏览器错误 0，历史 script／事件属性未执行。
- `harness.log`：初版 session-tree／session-context-edits／session-portability 三场景 18 条通过，仅 3/48，检查了深浅与窄屏截图。最终更完整场景另留日志；未运行其他全量 UI。

生产字节码最初以系统 Node 25 运行与 Electron V8 不兼容，已改同版 electron.exe RunAsNode。随后暴露的 SDK export-html／主题资源缺失及 jsc dynamic import 问题已修复并重验；早期失败日志保留，最终结果以上方底层证据为准。

## 运行

`node electron-agent/scripts/session-workflow-ipc-check.mjs` 跑源码链。生产链设置 SESSION_WORKFLOW_HOST_ENTRY、SESSION_WORKFLOW_EXEC_PATH（同版 Electron）、SESSION_WORKFLOW_EVIDENCE；只在源码链注入 SDK refresh／post-tree 故障，字节码链验证实际正常路由。

HTML 检查用同版 Electron 运行 `electron-agent/scripts/session-workflow-html-check.mjs <实际导出文件绝对路径>`，隐藏离屏窗口；脚本真实输入点击旁支并保存 PNG，不启动或重启正式应用。所有模型传输仅 loopback stub，未使用真实凭据、远程服务或付费模型。
