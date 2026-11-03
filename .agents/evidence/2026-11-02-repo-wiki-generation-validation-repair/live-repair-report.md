# 真实验收后的模型诊断和暂停修复

## 实际验收状态

唯一一次真实 repair 任务 `4c12a6f4-e458-4d73-960c-d8ca7bbd78bd` 出现模型错误后按约定暂停，现为 paused/manual。`generate:modules/examples` 未取得有效模型正文；原错误已被净化为 `STAGE_FAILED`，无法确定当时的 HTTP 状态或根因。父任务的 9 份 prepared 内容保持；本轮没有修改真实任务或数据库，没有再次调用付费模型。原任务仍未完成正式验收。

## 根因和修复

模型 assistant 的 `stopReason=error` 把整个 `errorMessage` 用作代码和消息，coordinator 的安全过滤无法识别该自由文本，落为 `STAGE_FAILED`。仅在字符串开头明确给出 HTTP 状态时生成 `MODEL_HTTP_状态码`，其余生成 `MODEL_ERROR`；不会保存原始响应、URL 或 query。既有首次响应的 429/5xx 重试判定保持不变，JSON 修复回合失败仍不增加自动重试。

v1/v2 在途 stage 即使暂停信号已触发，仍可能以 failed 返回并被落账。现在收到控制中断后的非 prepared 返回时沿既有中断路径退出，不增加业务失败数；已经返回的 prepared 仍执行校验和 ACK。被中断项保留既有 running/replay 语义，恢复继续受原有 attempt 与预算约束；不改历史状态、不新增重试。

## 检查

- `live-repair-red.log`：模型错误全文泄漏和 v1/v2 暂停产生 failed count 共 3 项复现。
- `live-repair-green.log`：12 项通过，包括 v1/v2 暂停返回 failed 不增计数、暂停时 prepared ACK 保留、既有抛错与返回错误行为。
- `live-repair-provider-green.log`：2 项通过；明确 429/503/401、未知错误、URL 中数字不被误判为 HTTP 状态，JSON 修复回合失败不扩张重试。未知文本触发的原有 retriable 判定没有改变。
- `live-repair-validation-green.log`：安全模型错误码通过 coordinator 的 `stageFailure` 不丢失，retriable 保持。
- `live-repair-stage-suite.log`：stage runtime 定向文件 13 项全部通过。
- `live-repair-typecheck.log`：KnowledgeKernel 类型检查通过；本轮限定 diff 检查无空白错误。`live-repair.diff` 相对本轮开始时的工作区生成。

以上均为离线定向验证，不代表真实 provider 已恢复，也不代表真实 repair 已发布。
