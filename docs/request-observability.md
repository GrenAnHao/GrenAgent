# 请求观测协议与隐私

按用户收敛要求，聊天输入区的「请求与缓存预热详情」及供应商测活中的「请求元数据」面板均已移除。测活保留正文、思考、TTFT、tokens、速率和取消；底层安全元数据及可信用量接入继续保留。下文仅描述底层协议，不表示仍有独立展示或临时收集入口。

## 安全 DTO

`extensions/_shared/requestObservation.ts` 是唯一请求 DTO：

- identity 在真实调用时冻结 `sessionId`、可用的 `sessionPath`、`runtimeGeneration`、应用 `requestId`；无路径仍有稳定 SDK sessionId。供应商 request-id 仅为 metadata，不能作应用 identity。
- `sequence` 是生成进程的单调序号，`observedAt` 为采集时刻；`attempt` 只数已收到回调的响应，不表示 SDK 全部网络尝试。
- phase 为 started / response / completed / failed / cancelled。终态拒收迟到片段；新调用重新生成 id。host 重建更换 generation，旧 generation 的事件不会并入新请求。
- metadata 只含 httpStatus、providerRequestId、rateLimit。header 白名单为 request-id / x-request-id / openai-request-id / retry-after、OpenAI x-ratelimit-{limit,remaining,reset}-{requests,tokens}、Anthropic anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}，键小写、值去控制字符并限 256 字符。
- outcome 仅取最终 SDK message 的 responseModel、usage.cost.total 和来源 boolean。0 不是未知，totalFromProvider 不是金额；true 为供应商报告，false / 新 SDK 缺省为目录估算，旧证据不足为未知。
- 独立 pi://request-observation 通道承载以上 DTO，不写 turns/items、JSONL、SQLite、localStorage 或通用诊断日志。模型正文仍走原来的消息链，不复制到观测缓存。

## 回调支持矩阵

实测 SDK 1.5.1，见 `electron/app/requestObservation.integration.test.ts`。该 fixture 禁止真实 fetch、socket 连接和非临时路径凭据读取。

| 入口 / 适配器 | 可观察范围 |
| --- | --- |
| Gren 普通 AgentSession / oneshot completeSimple | 每次实际公开调用重新绑定 scope；安全元数据、最终费用来源 |
| 官方 CacheWarmer 复制 options | 重新进入 facade 创建独立 scope，不复用原请求闭包 |
| openai-completions / Anthropic | 成功回调可用；失败及隐式重试中间响应未公开，显示不可用，不能猜 HTTP 状态 |
| Codex SSE | 回调提供限流 429 和多个响应，按已观察顺序保留 |
| 缺回调适配器 / 请求前失败 / Codex WebSocket 无回调 | unavailable，保留模型原结果、错误和耗时 |

安装源码：`pi-ai/dist/api/openai-completions.js:198–203` 在 retryProviderRequest 成功后才调用 onResponse；`api/anthropic-messages.js:668` 同样在成功响应后；`api/openai-codex-responses.js:290` 在检查 response.ok 之前调用。公开限制另见 [官方 issue 5623](https://github.com/earendil-works/pi/issues/5623)。不修改 SDK 重试、认证或 fetch。

## 用量覆盖

已记录费用 = 原 assistant 费用 + 独立 cache_warm 费用；助手调用数不含预热。总额可混合供应商报告、目录估算与未知来源，不是全量账单。外部历史只展示；未验证的继承历史不入账；工具自报及无法归属模型的 compaction / branch_summary 不计。

桌面 / Gren / 嵌入与子进程子代理在成功 entry_appended 时实时记预热。官方 CLI main 没有公开 AgentSession observer，仅按用户批准在 session_start 冻结基线，在 turn_end / agent_end / session_shutdown 延迟消费本次运行后新增的已持久 entry。不轮询、不授信基线前历史。idle 到下一 hook 前有延迟；强杀、崩溃和退出快照至 dispose 的竞态可能漏记，来源无法验证时不猜账。

## 迁移与回退

账本事务加 nullable response_model / cost_source，旧 key、金额、calls rollup 不改；预热另表 aux_usage，键为 u:cache_warm:provider:entryId:timestamp。legacy-roster-v1.json 一次冻结规范路径+header sessionId，不能随补录扩充；origins.db 由请求边界和受管 prepare/commit/abort 写入，文件/renderer 无授信权。roster 损坏报错，不能重建授信。

回退保留账本、新表、来源 registry 与 roster，可用旧 reader 只读原 assistant 表；必须停用不认识 required 标记及来源 registry 的历史自动补录器，避免副本重复记费。不要删库、删列或重算旧金额。
