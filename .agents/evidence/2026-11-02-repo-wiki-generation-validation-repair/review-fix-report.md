# 独立审查修复与验证

## 修复

- `markdownLinks.ts` 按 destination offset 去重替换；共享引用定义的每处引用保留，同一 URL 只替换一次，整链接降级删除仍独立执行。
- `wikiLinks.ts` 的 page 结果新增 `resolvedPath`，按当前页面目录归一化并保留原始大小写及后缀；原 `path`、`pageId`、`hash` 不变。校验优先使用此路径，原始根路径兼容只在规范路径不在 manifest 且链接不含 `..` 时使用。真实 Wiki 页面优先，越根拒绝；显式 source 未核实仍降为纯文字。
- `runStage` 将 executeStage 返回的 failed / blocked 错误走 `stageFailure`，合法代码、状态和 retriable 保留；原始错误文字不落账。对预算耗尽保留固定安全提示 `Budget exhausted`。

## 证据

- RED：`review-fix-red.log` 中 6 项按预期失败：重复 definition 损坏、合法 `../README.md` 未转换、两代的 failed / blocked 返回均泄漏路径和 query。
- 定向 GREEN：`review-fix-green.log` 7 项通过，覆盖重复引用、合法相对路径、越根、Wiki 同名优先、规范路径存在但未 Read 不误引根文件、两代 failed / blocked 及非法错误码净化。
- 核心回归首次 `review-fix-core.log` 102 通过、1 失败：既有预算耗尽提示被通用消息替换。修正为固定安全提示后，`review-fix-budget-green.log` 中原失败用例及四个返回错误用例 5 项通过；其余 102 项的实现未受这次固定提示调整影响。
- `review-fix-typecheck.log`：`npm run typecheck:knowledge-kernel` 通过。
- `review-fix-integration.log`：四项 v1/v2 双 OS child、Pi SDK / Read 和 loopback 假模型用例通过。四份对应 `review-fix-*.json` 包含 ledger 和调用。测试检查失败候选不发布、prepared 不重发、模型修复仅 library、历史候选复验 HTTP 0、正式页面和真实来源。
- `git diff --check` 对本次限定代码与笔记通过；`review-fix.diff` 相对本轮审查修复前工作区，不含其他既有 dirty。

未调用付费模型、操作真实任务、重启应用或提交推送。唯一真实验收由根代理在定向独立复核完成后执行。
