# 三份规格逐场景验收

用户后续撤回独立聊天面板；本表保留底层及历史组件证据，不再声称该聊天入口交付。当前真实 ChatView 两入口已撤下并通过工作台验证。

“通过”指下列源码 / SDK / UI / 已消费生产候选的对应断言已通过。root 已消费第四统一生产候选的 host / worker 9 项与实际 CLI 延迟预热入口，根 notes / strict 和类型增量对照通过。独立审查的 A/B 抽查无须修复项；任务 24/24，未提交或归档。C 的严格导入与历史显示修补由 C 独立验收，不以 B 完成代替 C 完成。

## cache-warming-observability

| 场景 | 证据 |
| --- | --- |
| 已排期的预热 | request-observability probe「官方排期不称发送」；RequestObservationService getter 白名单测试 |
| 切换会话 | request-observability probe「会话B隔离 / B不沿用A模型」；requestObservations reducer A/B 测试 |
| 官方停止预热 | cache-warming probe「只读状态区明确扩展停止」；WarmingDetails inactive / reason 单测 |
| 存在经济性判断 | request-observability 真实视图 USD / 15% 截图，RequestDetails zero / unknown 单测 |
| 经济性不可用或被扩展覆盖 | RequestDetails「final extension override」测试；cache-warming 未知 / 0 / 15% probe |
| 一次预热成功入账 | ledger「records warm outside assistant rollup」幂等；production-observation actual host / worker 临时库 |
| 尚无实际用量 | UsageService 只提取 persisted usage/cache_warm；WarmingDetails 估算说明，决策不写库 |
| 只查看状态 | RequestDetails 1 Hz / unmount 停止测试；cache-warming「查看状态不修改canonical模式」 |
| 官方 CLI 延迟补录的覆盖边界 | cli-lifecycle-results.json；lifecycleUsage baseline / 后续新 entry 测试。强杀、崩溃、退出竞态覆盖限制见 docs/request-observability.md |

## model-request-diagnostics

| 场景 | 证据 |
| --- | --- |
| 限流响应 | requestObservation.integration 实际 Codex SSE 两个 429；request-observability 429 / retry-after 渲染 |
| 供应商缺少元数据 | 真实 SDK silent adapter、请求前失败；OpenAI 内部 429→200 只回调成功响应测试 |
| 多会话并发与迟到结果 | requestObservation hub / requestObservations reducer；production-observation A/B 真 IPC |
| 取消后重试 | RequestObservations 终态拒迟到 + reducer terminal / generation 测试，ProviderDiagnostics 原取消九测及42项UI断言 |
| 重试有多个 HTTP 响应 | Codex SSE 429/429 顺序；仅标“已观察响应”，OpenAI未公开的内部尝试不推断 |
| 默认无原始内容 | requestObservation 默认关闭测试、production-observation 未启用前无 raw / 退出扫描 |
| 显式启用并结束 | request-observability 键盘启用 / 关闭清除 / 重开默认关闭；RequestDetails scope cleanup |
| 嵌套秘密与正文 | requestObservation nested secrets / frozen input 测试、真实安全 IPC 回环 |
| 动态键携带敏感内容 | requestObservation dynamic-key 投影测试；生产注入 raw 标记不越 IPC / 不落盘 |
| 用户导出 | register.test 实际写入失败→同 host previewId 重试，预览不含后续帧；UI export / preview probe |
| 大量事件或脱敏失败 | requestObservation 200 条和 1 MiB 两个上限、throwing getter 丢弃测试；UI 截断状态 |

## model-usage-provenance

| 场景 | 证据 |
| --- | --- |
| 请求别名与实际模型不同 | ledger / eventAdapter / agentReducer / UsagePanel；生产 physical-offline 与请求offline |
| 未报告响应模型 | UsagePanel old report 单测、usage-provenance 明细截图“未报告” |
| 供应商报告总价 | ledger 0.12 vs 分项0.10，Provider boolean 独立；生产 CLI 两次0.12 |
| 目录估算或零费用 | ledger false / 缺省 / 0 测试；usage-provenance $0.0000 截图 |
| 旧账本没有来源信息 | ledger.migration 旧 DB unknown、旧金额0.12保留；UsageService legacy 缺字段 |
| 实时记录后再次补录 | 真实 SDK usage-ledger + UsageService 去重，source workflow 28项新请求后reconcile零增量 |
| 旧账本迁移与元数据补齐 | ledger.migration 真实旧 schema、原r键 / rollup / 金额不变；只补缺字段 |
| 无响应标识的受管复制 | C production-source-ipc-final 28项：未补录legacy→clone→clone→首次report→同原t键 |
| 重复导入或伪造已有响应标识 | 同28项：两次external、原header及未来responseId、999费用不污染原行；UsageService伪造原路径回归 |
| 导入后继续真实请求 | 同28项：仅真实新调用增加1条 / 10 tokens，历史不一并入账 |
| 本机来源登记缺失 | originRegistry uncommitted / abort / missing source 测试；缺证据保持unverified，实际新entry独立登记 |
| 混合历史冷恢复 | UsageService frozen legacy / unmanaged / duplicate external / later actual request / repeat zero increment |
| 必须查来源的标记不授信 | legacyRoster 排除 required、registry缺失不fallback；C external marker / 消费者联测 |
| 预热记录只含归属模型 | UsageService cache_warm 精确提取、UsagePanel attributedModel 明细 / “请求模型未报告” |
| 工具与未归属辅助用量 | UsageService9项中的 compaction / branch_summary / tool usage 不入账；报表覆盖说明 |
| 混合来源合计 | UsagePanel 混合源、assistant+warm分项，usage-provenance 0.25总额截图；原助手调用3不含warm1 |

## 最终候选检查范围

- `request-observation-ipc-check.mjs` 实际 agent-host / pi-worker CJS/.jsc：相同脚本的环境变量指向最终候选，不运行真实网络模型。
- `cli-warm-lifecycle-check.mjs` 实际 cli/dist：公开生命周期延迟补录和基线拒授信。
- 来源多级归一、退出预览清除、损坏registry不阻断会话的新增回归已通过，第四候选实际 host / worker IPC 与 CLI 入口通过；见 final-candidate 日志及 README。
- 已过四场景截图 / UI 与无关单测未重跑；root 已确认根目录 verify-notes、strict OpenSpec 与 Node169/CLI82 无新增诊断。
