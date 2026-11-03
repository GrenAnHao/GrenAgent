# Agent Note: Repo Wiki 生成校验与失败候选修复

Status: proposed

## Problem

2026-11-02 的 v1 repair 任务因 INVALID_PAGE_LINK 失败，3 个构建项仍是 running，payload/error 为空，不能定位具体链接，也不能复验模型已生成的正文。校验正则把代码示例中的 .md 链接当成真实链接，忽略引用式链接与 URL 编码；源码 Markdown 和 Wiki 页引用没有统一判别。实际渲染使用 react-markdown + remark-gfm。

## Proposal

- 复用已有 unified/remark-parse/remark-gfm 解析真实链接；代码块、行内代码、未使用的引用定义不进入链接校验。Wiki 链接按当前页面目录和冻结 catalogue 判断；来源必须是 manifest 文件且由本轮 Read 范围证明，已读取的源码 Markdown 链接规范化为 source: 引用。普通相对 .md 链接仅在 manifest+Read 证明后转为 source:；安全未知 Wiki 链接规范化为正文并记 warning；非法路径明确失败。显式 source: 链接若无法核实，保持旧 normalizeStageSources 合同降级为纯文字，不能伪造来源，也不把兼容性降级扩大成整页失败。
- 校验失败结果作为 failed 构建项落账，保留候选 payload、实际 evidence 和依赖；错误码独立于安全的页面/相对目标详情。候选不进入 checkpoint、草稿列表或正式发布，不覆盖已有正式稿。
- repair 复用有效 prepared 项；对身份、输入、依赖都匹配的校验失败候选，先重新规范化和校验，通过后无需模型调用。仍不合法才走原 stage 执行、attempt 和 run 预算。v1/v2、fence 和原子发布不变。

## Historical note audit

- [真实模型实跑](../../implemented/bug-fix/2026-11-01-repo-wiki-real-model-shakedown.md)：部分重叠，保留补全 manifest hash 和实际读取范围的依据；本次只收紧普通相对 .md 链接的证明要求；显式 source: 的旧安全降级保持不变。
- [Qoder 对齐](../../implemented/architecture/2026-11-02-repo-wiki-qoder-alignment.md)：部分重叠，保留 v1 兼容、v2 并发/用途预算/完整发布清单。
- 活跃 proposed/rejected 中无同主题提案；不归档旧决定。

## Alternatives considered

1. 关掉链接校验或删除所有无效链接：最快让任务完成；不选，会发布不可导航页面并掩盖未知来源。
2. 继续扩充正则：改动局部且无需新解析逻辑；不选，引用式链接、代码块和嵌套语法已有成熟 Markdown AST 支持，项目已经依赖同一解析器。
3. 每次失败都重新调用模型：实现最少；不选，解析器误判造成的旧候选可以在本地严格复验，重复请求浪费额度且丢失诊断证据。

## Acceptance criteria

- RED/GREEN 覆盖代码块、行内代码、引用链接、URL 编码、源码 Markdown、未知/越权来源。
- v1/v2 失败后无遗留 running，安全错误详情和候选已持久化，已有正式成果不变。
- repair 的合法候选不调用模型，真实无效候选仍失败或按既有预算重试；最终仍要求全部页面与来源通过。
- 定向核心测试、严格 KnowledgeKernel 类型和根代理的双 child 闭环验收通过。真实模型验收仅由根代理按授权执行。

## Risks

历史失败项没有保存正文，不能恢复不存在的候选；只能复用其已 prepared 项。解析/导航要保持一致，详情不包含 query 凭据、绝对路径或完整 prompt。测试证据保存于 `.agents/evidence/2026-11-02-repo-wiki-generation-validation-repair/`。

## 审查修复边界

引用式链接共用 definition 时只改写该目标一次。相对来源先按当前 Wiki 页目录安全归一化，越根拒绝，匹配真实 Wiki 页优先；原有不含 `..` 的仓库根路径引用仍可按 manifest 与 Read 证据识别。模型执行返回的 failed / blocked 诊断与异常走同一安全边界，保留合法错误码、原 disposition 和 retriable，不落原始异常文字。

## content 目录链接与虚拟页面根

2026-11-03 只读定位到旧 v2 任务 `2323a612-8c9f-4c1d-b20e-55a814a5a2a2`：11 月 2 日 23:27:12 的 `generate:architecture` 保存了失败候选，链接指向越根的 `../content/modules/pocock/categories.md`（示例路径，不指向仓库文件）。该路径不在源码 manifest 或 Read 证据中，但冻结目录存在页面 `modules/pocock/categories`。当前解析以 `architecture` 为虚拟根页，遇到首个 `..` 即拒绝，尚未判别此链接的 Wiki 页面身份。

只对 `../content/<页面 ID>.md` 且页面 ID 精确属于本轮冻结目录的普通导航，确定性转成当前页到目标页的 canonical 相对链接；实际正常相对 Wiki 页优先，源码 `source:`、带源码行号的引用、绝对路径和其他越根路径不适用该适配。转换不访问文件、不添加来源证据、不改变必需页面集合。引用式定义只改一次，保留安全章节锚点。未命中的目标完整沿原流程：合法相对源码仍须 manifest + Read 证明，普通未知导航保持既有纯文字降级，顶层越根仍拒绝；不模糊重定向，也不因出现 content 前缀就跳过来源验证。

选择目录身份绑定而非去掉全部 `../`：后者最容易避开错误，但会把来源越权或同名文件误判为合法页面。也不让模型重写已保存正文来修路径，避免为确定性链接转换再次付费。后续 repair 可沿既有候选复验路径使用本修复；本轮只改代码和未执行 fixture，不修改真实任务、构建、重启或调用模型。

## 真实验收后的诊断与暂停边界

首轮真实 repair 在收到模型错误后按约定暂停；第二轮在旧 prepared 的坏导航会阻断出版后暂停，原父任务的 prepared 成果仍保留，当前未完成验收。原错误已净化为 STAGE_FAILED，无法倒推当时的 HTTP 状态。后续从模型响应入口只生成稳定的模型错误码，只有能明确辨认 HTTP 状态时才记录状态，绝不落响应全文或凭据；既有重试判定和次数不变。暂停中止后返回的非 prepared 结果不应落成业务失败，已完成且通过校验的 prepared 结果仍可 ACK，未完成项沿用现有续跑路径。

v2 暂停排空并发 stage 时，逐个接纳当前 fence、输入与依赖仍有效且已通过本地校验的 prepared；failed / blocked 和无效结果留给既有续跑路径。排空在暂停终态和租约释放前完成，不在停止期间调度或发布。

## 导航策略裁定

旧 validator 只检查带 `.md` 的 Wiki 链接，导致旧 prepared 中存在真实坏导航；新规则把附属导航错误扩大为整批失败，阻断有效正文与来源。安全相对 Wiki 路径若不在冻结页集合，规范化时去掉点击包装并记录安全页面与目标 warning，不猜测重定向；直接校验未规范化文本仍拒绝未知目标。路径越权、来源无证据及必需页缺失仍硬失败。出版时验证原始成果完整性，另外确定性规范化正式正文；保留来源成果哈希，发布意图覆盖最终正文。当前任务同输入的校验失败候选可在原 fence 与 attempt 下本地复验，不消耗模型预算。

用户已确认采用安全降级，并授权复核后继续当前 `f2cca0ce-1ed0-4687-9f2f-c4b6b71a0f93` 任务；不新开整轮、不重置预算。复核与部署由根代理负责，测试阶段不操作用户任务。

## 中断续跑与预算

暂停已排空、取得新 fence 后，未完成 running 项若输入一致，续用其原 attempt；未执行的 BLOCKED_BY_DEPENDENCY 占位项也复用编号并按新依赖重算输入。同一 fence 不能重复复用，真正 failed 继续受原 retry 上限。已计入的未知用量不退款，模型、工具、token、时间预算均不重置；模型预算错误要作为 BUDGET_EXHAUSTED blocked 传播。已覆盖的候选与错误占位恢复必须有原始证据、现有账本和受控事务，真实数据操作由根代理审查后执行。

用户对当前 f2 单独授权将 `budgets.unit.maxTotalTokens` 从 300000 一次性调至 350000；模型/工具/时间/attempt 上限和全部已用、unknown 账本不变。恢复前校验原值并审计授权，重复执行不叠加；不影响其他任务或默认配置。

### 2026-11-03 预算受阻的收尾与保留成果

只读实锤的新 repair 任务 `53ae9dc1-a65c-4c82-a09f-400c2a8279e1`（父任务 `2323a612-8c9f-4c1d-b20e-55a814a5a2a2`）仍用旧 v2：09:26:33 创建、09:37:11 blocked，14 项中 9 prepared、2 failed、3 blocked、0 published。`modules/pocock/categories` 达到工具 60/60、模型 15/20、预算 Token 160229/300000；`modules/notes/references` 为模型 18/20、工具 32/60、预算 Token 196906/300000，具体被拒申请额未保存，不能只凭余额断言维度。所有 1179 条请求已 settled，无 unknown/在途；本任务总模型 182 次、预算 Token 2023418，未触及运行级 1000 次/5000000 Token。两项 MODEL_ERROR 与预算受阻分别处理，不把所有失败说成预算问题。

本次曾考虑在旧 stageRuntime 修工具批次越额的收尾，并为 blocked 任务增加 cancel→repair 的前端组合，以保留九份 prepared。它的最强理由是可沿旧账本与检查点低成本续修；用户随后明确要求停止反复补旧流程、统一按 Qoder 实现。因此该方案不实施：补写的三项 stage fixture 已按任务开始 preimage 撤回，stageRuntime 源码未改；前端组合方案未产生源码改动，真实任务和预算均未操作。

当前方向是[完整复刻笔记的正常入口统一](../architecture/2026-11-02-qoder-repowiki-native-replica.md)：默认 Repo Wiki 使用 native Qoder 本地合同，旧任务与九份草稿保留为可读历史，不自动迁移或付费续跑。“重新分析用新预算继续”的旧提示不应再代表新流程，不能把正常入口仍落旧 v2 当成用户选错按钮。

## 来源行号兼容

真实生成使用 source:路径:行号或 source:路径:起-止，不是阅读器支持的 #L 格式。仅规范化严格行号语法，仍以冻结 manifest 与本轮 Read 范围证明后转 canonical 链接；未验证来源沿显式 source 的纯文字降级，危险路径继续拒绝。不能通过宽松解析任意协议或猜测行号恢复来源。

## 失败后的重试入口

可修复与否以服务端 repair capability 为准，正文 prepared 数不包含目录、概览和可复验候选，不能用它判断是否启动整轮。确认固定原任务及身份令牌；后续快照失去 run 时拒绝确认，不回落到新生成，其余过期状态由服务端裁决。确认文案只陈述已完成与失败/受阻计数，复用取决于校验，不承诺失败项必定重做。

## 目录祖先不是生成前置页面

生成叶页依赖其结构祖先时，祖先只是分组而非页面：替换为祖先的外部前置依赖，而不是祖先的全部后代；跨分组依赖仍展开为目标全部叶页，展开后真正的环仍拒绝。v1 与 v2 共用此规则。DEPENDENCY_CYCLE 是确定性规划错误，提示调整依赖后重新分析，不让用户无条件重试。

任务详情可按指定任务 ID 重试历史任务；默认项目快照仍显示最新任务，不能将较新的 cancelled 静默替换成较旧 failed。显式携带 plan token 的 repair 要绑定确认时计划和原任务版本，并在创建事务再检查原任务版本和终态；无 token 的旧内部调用保留原合同。

Qoder 原始流程核验目前只见目录转页面后并发执行，未见页面间 DAG；本仓库页面依赖是现有自定义合同。本次只修该合同内的伪环，不据此宣称与 Qoder 1:1 等价，也不自行删除 DAG；是否替换内核属于另行讨论。
