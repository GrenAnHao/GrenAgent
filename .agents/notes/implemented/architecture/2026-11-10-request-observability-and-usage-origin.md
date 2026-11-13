# Agent Note: 请求观测与可信用量来源

Status: implemented

## Problem

SDK 1.5.1 预热、HTTP 回调及费用来源尚未贯通桌面。复制历史在缺 responseId 时会以新 sessionId 重复计费，外部包自报标识还可能污染既有账本。原始事件包含正文、动态秘密键，不能默认跨 IPC。

## Decision

同一 owner 负责请求 scope、安全投影、host 通道、UI 状态与账本。每次公开模型调用冻结 sessionId、runtimeGeneration、requestId，并组合而非替换回调。元数据只准明确 header 白名单；结构收集默认关闭，仅收启用后的安全投影，200 条/1 MiB，终态冻结、关详情清空。预热 getter 只读、最多每秒查询，不调度。

来源 registry 位于 agentDir/usage/origins.db。只有生产请求持久化边界登记 local-origin；受管 prepare/commit/abort 提交 target→source 映射，递归归一；import 恒 external-history。renderer 和文件声明不授信。origin 绑定唯一 canonical 原账本键，继承字段不能覆盖金额或元数据。一次性冻结规范路径+sessionId 的 legacy roster；清单损坏报错，不重建。required 标记只有否定能力，新文件缺 registry 不降级 legacy。新原生请求独立登记，不依赖会话 UI。

calls 事务添加 response_model/cost_source，原 key/金额/rollup 保留；cache_warm 另表，u:cache_warm:provider:entryId:timestamp 幂等。新 SDK 缺省 boolean 来源为 catalog，旧证据缺失为 unknown。total 直接取 SDK，不重算。报表新增 warmingTotals/warmingCalls/recordedCost，assistant 统计不改义；compaction/branch/tool 缺归属不记。旧 reader 可读 assistant，但回退必须停用旧补录入口。

per-session facade 仅包装真实 ModelRuntime 的公开 stream / complete 方法，其他方法绑定同一原实例，SDK 继续拥有认证、请求、重试和预热。用户批准官方 CLI 单入口例外：官方 main 无 session observer，扩展在 session_start 冻结基线，通过 turn_end / agent_end / session_shutdown 延迟消费新持久 entry；不授信旧历史、不轮询。idle 到下个 hook 前有延迟，强杀 / 崩溃和 shutdown 快照到 dispose 的微任务窗口可能漏预热；桌面 / Gren / 嵌入 / worker 仍实时消费 entry_appended。

历史决策审计：[写入账本](./2026-10-21-usage-ledger.md)部分重叠，保留扩展覆盖所有运行时的决定；本篇补充可信来源和独立预热表。SDK 集成与升级笔记只提供已有控制/版本事实，不替代本次证据。

## Alternatives considered

- **页面自行监听扩展钩子**：改动少；钩子没有完整请求身份，前后台交叠会串写，因此不用。
- **全局 fetch 抓取与渲染端脱敏**：覆盖 HTTP 广；会碰认证，敏感正文已越过 IPC，且不覆盖 WebSocket，因此不用。
- **复制后按新 sessionId 记账或凭 responseId 合并**：最简单；会重复收费或给外部文件污染权限，因此不用。
- **预热塞入 calls**：复用旧汇总；改变 assistant 调用数，因此另表。

## Consequences

聊天区展示入口按用户后续决定撤下，见[撤下聊天检查面板](../simplification/2026-11-10-remove-chat-inspection-panels.md)；本篇的底层观测、隐私与可信记账决定仍有效，不再要求聊天区面板。

- 默认只保留安全模型、HTTP 与费用元数据。临时结构的数量 / 体积上限限制排查范围；正文、秘密和动态字典键无法从诊断恢复。导出只读取 host 冻结的 previewId，写入失败可重试；关闭、关闭收集或 worker / host 退出会清除采集端、转发端及渲染预览。
- legacy roster 以独立 JSON 和 ledger meta 迁移锚冻结；损坏或迁移后缺文件都拒绝重授信。registry 额外绑定真实原始 sessionPath，清单外文件伪造 header sessionId / entryId 不能补齐原行元数据。
- 受管未验证 sourceRef 持久保留；源日后由可信原记录补录后，resolver 内防环递归归一。副本仍只引用原键、原金额与最初会话归属，不以副本字段重建或覆盖原行。
- assistant 的 calls / rollup / 模型统计不改义；预热另表，已记录费用包含两者。不把工具、缺顶层模型的压缩 / 摘要或外部历史冒充本机费用。
- CLI 使用公开生命周期延迟捕获；idle 等待、强杀 / 崩溃、退出竞态可能漏记的范围在用户说明中明示。观测不改变官方预热模式、TTL、认证、重试或费用算法。

## Verification

结果：定向 SQLite、SDK、IPC、UI 与实际打包入口已通过。证据目录 `.agents/evidence/2026-11-10-observe-desktop-model-requests/`（[索引](../../../evidence/2026-11-10-observe-desktop-model-requests/README.md)），用户协议与回退步骤在 [请求观测说明](../../../../docs/request-observability.md)。

- SQLite 旧 schema 事务升级、并发两进程初始化、失败回滚、旧 reader 读取 assistant 原金额 / 次数通过；元数据补齐不触发原汇总，预热复制幂等通过。
- 真实 SDK 公共回调矩阵通过：普通 session、oneshot、重试、CacheWarmer、无回调和请求前失败。OpenAI / Anthropic 隐式失败响应不公开，返回 unavailable；Codex SSE 的 429 / 多响应可观测。不从错误文本猜 HTTP。
- 真实子进程 IPC、安全投影、200 条 / 1 MiB、冻结预览、真实文件写入失败重试与退出清除回归通过；网络 socket 和外部凭据读取由夹具明确禁止。
- 指定四个 harness 场景通过，深浅及窄屏 / 明细滚动截图已检查；其他场景未运行。
- 实际生产 agent-host.js / pi-worker.js 的 CJS/.jsc 经离线传输与真实 IPC 验证 A/B、后台 warm、安全 DTO、来源字段及临时账本；退出后无 raw 结构落盘。实际 CLI dist/main.js RPC 验证外部基线不授信、新 assistant 即时记账及运行中 warm 通过公开 hook 延迟入账。
- 会话 owner 的真实 SDK / host IPC 联测 28 项通过，包含首次 legacy 补录前的两级副本、随后原 t: 键归一、伪造外部 responseId 不污染原行及导入后真实调用。
