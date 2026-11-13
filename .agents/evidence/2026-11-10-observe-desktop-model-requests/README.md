# 请求观测与可信用量验收

当前交付范围已收敛：用户撤回聊天区「请求与缓存预热详情」，该挂载已移除；保留 SDK 兼容与底层观测/记账。此前面板截图/验证仅是历史候选，不表示该入口仍在聊天区。撤下后的真实工作台 246/246 与构建证据在 sibling `2026-11-10-complete-desktop-session-workflows/chat-panels-removal-*`。

## 可直接运行的入口

- `cd electron-agent; npx vitest run electron/app/requestObservation.integration.test.ts electron/app/requestObservationService.test.ts electron/agentProcess/observation.test.ts electron/app/usageService.test.ts electron/ipc/register.test.ts`
- `cd extensions; npx vitest run usage-ledger/ledger.test.ts usage-ledger/ledger.migration.test.ts usage-ledger/originRegistry.test.ts usage-ledger/lifecycleUsage.test.ts usage-ledger/usage-ledger-live.real.test.ts _shared/requestObservation.test.ts`
- `cd electron-agent; npm run ui:check -- request-observability usage-provenance provider-diagnostics cache-warming`（统一调度，不与其他场景构建并行）
- `node electron-agent/scripts/request-observation-ipc-check.mjs`：源码 host；设置 `OBSERVATION_HOST_ENTRY` 为候选 main/agent-host.js、`OBSERVATION_EXECUTABLE` 为匹配 Electron 后运行实际 CJS/.jsc host + pi-worker。
- `node electron-agent/scripts/cli-warm-lifecycle-check.mjs`：实际 cli/dist/main.js RPC，公开生命周期延迟 warm 记账。

## 已有决定性证据

| 需求 | 证据 |
| --- | --- |
| 每调用新 scope、A/B / generation / late-event 隔离 | observed-model-runtime.test、requestObservation.test、requestObservations.test、真实 observation 子进程 IPC |
| SDK 公开回调覆盖矩阵 | requestObservation.integration 5 项；真实 SDK 200、OpenAI 隐式 429 不公开、Codex SSE 429 顺序、无回调与请求前失败 |
| 采集端隐私、未知动态键、有界缓存 | requestObservation.test 4 项；真实 IPC 与 export-request 测试不含夹具敏感标记 |
| 冻结预览、写入失败重试、退出清除 | requestObservationService、RequestDetails、register.test 的真实文件写失败 / 成功，worker disconnect 回归 |
| 预热只读、单位 / 未知 / 0、最终 override | requestObservationService / RequestDetails，cache-warming 场景 28 项 |
| 原费用 / 次数 / 旧键不改、加列 / 预热另表 | ledger.test 8 项、ledger.migration 3 项（真实旧库、并发两进程、回滚及旧 reader） |
| legacy 冻结、外部不授信、原始路径、防伪元数据 | usageService 9 项，originRegistry 5 项 |
| 多级来源联测 | sibling `2026-11-10-complete-desktop-session-workflows/production-source-ipc-final.log` 28 项，results 中包含原 t: 键与两级副本归一 |
| 模型 / total / 来源保真 | eventAdapter 18、agentReducer 93、UsagePanel 2；0.12 不按分项 0.10 重算 |
| 真实 UI / 键盘 / 关闭 / A-B / 导出 / 截断 | ui-harness.log、ui-request-recheck.log、ui-details-screenshots.log；指定四场景最终 13 / 6 / 42 / 28 全通过，截图见同目录 |
| 生产字节码而非 grep | production-observation.log / production-observation-results.json，9 项实际 host + pi-worker，真实临时 SQLite、两个进程独立 generation，退出后无 raw 落盘 |
| 官方 CLI 公开延迟捕获 | cli-lifecycle.log / cli-lifecycle-results.json：外部基线 999 不入账，新两条助手各 0.12 provider，成功 warm 独立记账 |

## 支持与费用边界

完整协议、白名单、临时保留、导出和回退见 `docs/request-observability.md`。

OpenAI completions / Anthropic 不公开失败及隐式重试中间 HTTP 回调；Codex SSE 可观察 429，多响应只称「已观察响应」。所有适配器均不保证 raw 回调。SDK 无证据时 unavailable，不猜 HTTP 200。

原 assistant 汇总保持原义；warmingTotals / warmingCalls 单列，recordedCost 为两者合计。外部历史仅展示，未验证来源不入账；无可靠顶层模型的 compaction / branch_summary 与 tool usage 未计入。CLI idle 成功 warm 到下个 hook 前有延迟；强杀 / 崩溃 / 退出竞态可能漏记，不承诺全量账单。

生产 CLI stderr 还记录既有 `cli/dist/ultra-rules.md` 缺失警告；该规则未加载，本次非 Ultra 的 CLI 离线验收完成。此独立打包问题不计为请求观测或第三方包更新的已修复内容。

## 最终候选消费

最近一次 extensions 合并验证中 A 新预算包装暴露的两份状态机 mock 22 断言失败已修复；A 的 `subagent-budget-adjacent-tests.log` 两文件 83/83 通过，与本目录 vitest-extensions-final.log 中其余七文件 39/39 的有效结果合计九文件 122/122，通过后未重跑无关矩阵。Electron 最终定向十五文件249/249、CLI九测试通过，日志见 vitest-electron-final.log / cli-unit-final.log。损坏registry初始化回归及迁移 / 来源九测试通过，见 corrupt-registry-regression.log。

root 已消费第四统一生产候选：`production-observation-final-candidate.log` 实际 host / worker 9 项通过，`cli-lifecycle-final-candidate.log` 实际 CLI 延迟预热通过。该候选包含来源延迟归一、退出清除和损坏 registry 不阻断会话的最后修补；同版本 Electron 执行字节码，未覆盖正式应用产物。

共享类型检查归一与既有基线一致：Node 169、CLI 82，无新增或移除；日志及比较在 sibling `2026-11-10-complete-desktop-package-updates/integrated-types-comparison.json`。根 notes 与 strict 验证通过，证据 `verify-notes-final-candidate.log`；独立审查及 C 最终冷恢复的新增证据由 root 汇总。
