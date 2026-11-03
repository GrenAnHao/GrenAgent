# Sol 定向复核：真实验收后的诊断与暂停边界

审查 `live-repair.diff`、`pause-drain.diff`、对应报告、当前 `stageRuntime.ts` / `coordinator.ts` 与所附定向日志；未调用模型或重跑检查。**最终结论：安全模型错误码与 v1/v2 暂停合同通过定向复核；v2 多在途 prepared ACK 缺口已修，未见本次排空逻辑新增阻断。** 根代理可按用户新增授权执行第二次、失败即停的真实验收。

## v2 并发暂停缺口已修

`coordinator.ts` 的 v2 中断分支现在等待全部 active 结果，逐项只处理 prepared：核对当前 graph 的 inputHash、task/phase/item 和 fence；再经原 `advanceStageGraph` 与 `store.commitItem` 检查依赖、attempt 与有效租约。无效、过期及非 prepared 结果不 ACK，也不增加 failed；全部排空后才抛 `INTERRUPTED`，保留暂停终态、模型 drain 与租约释放顺序。active Promise 已在分派处把成功和异常都转换为 `{node,result|error}`，故 `Promise.all` 不会因单个 stage 抛错而中断排空。

新增双 active 用例覆盖两份 prepared、failed 加 prepared、过期 input 加 prepared；检查已接纳项在模型 drain 前可见、没有误记失败或发布。没有补槽或绕过原校验路径。`pause-drain-green.log` 11 项、`pause-drain-stale-green.log` 3 项及 KnowledgeKernel 类型检查通过。

## 已核对通过

- `modelErrorCode` 只从错误字符串起始的 4xx/5xx 状态构造 `MODEL_HTTP_###`，其余 assistant 错误用 `MODEL_ERROR`；响应全文、URL、query 不进入 stage 错误。coordinator 的 `stageFailure` 保留安全码。初次响应的 429/5xx retriable 规则、JSON 修复回合失败不自动重试的边界未改变。未知原始真实错误既已净化，不能据此推断当时 HTTP 状态。
- v1 暂停后的非 prepared 返回走 `INTERRUPTED`，不落业务失败；prepared 仍可经原有 validate/commit 路径 ACK。v2 单在途场景同样成立。失败候选/正式发布流程未在本 diff 改动。
- 已读日志：`live-repair-red.log` 3 项复现，`live-repair-green.log` 12 项、`live-repair-provider-green.log` 2 项、stage runtime 定向文件 13 项和 KnowledgeKernel 类型检查通过。`pause-drain-red.log` 对双 active 缺口复现，修复后的 11 项与另 3 项覆盖该边界。
