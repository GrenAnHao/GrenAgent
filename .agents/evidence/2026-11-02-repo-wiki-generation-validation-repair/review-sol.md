# Sol 独立审查：校验、失败候选、repair 与阅读导航

审查对象：`core-limited.diff`、`ui-links-final.diff`、`review-fix.diff`、当前对应源码、规格 note 和定向测试报告。**最终结论：三项审查缺陷均已修复，未发现本轮修复新增的发布阻断；根代理可按授权执行唯一一次真实验收。** 未修改产品代码，也未重跑已有有效测试。

## 三项缺陷的修复复核

1. **P1 已修：重复引用目标只改写一次。** `markdownLinks.ts:30-32` 按 destination offset 去重，独立的整链接删除仍保留。新增测试在同一 `[readme]: README.md#purpose` 被两处引用且必须改写时精确比对整段 Markdown，确认两个链接和单个 definition 均完整。
2. **P2 已修：嵌套相对源码按当前页解析。** `wikiLinks.ts` 新增 `resolvedPath`，保留原有供 UI 使用的 `path/pageId/hash`；`validation.ts:37` 优先用规范路径查 manifest，旧根路径兼容仅在规范路径不存在且没有 `..` 时使用。新增测试涵盖 `chapters/start` 的 `../README.md` 在 Read 后转 source、同名真实 Wiki 页优先、规范路径存在却未 Read 时不错误退回根文件、越根仍拒绝。
3. **P2 已修：返回的失败结果也过滤诊断。** `coordinator.ts:103` 对非 prepared 的 `result.error` 调用 `stageFailure`；其仅保留格式合法的 code 和 retriable，错误原文不入持久项或任务元数据，disposition 不变。`BUDGET_EXHAUSTED` 使用固定安全提示，维持旧预算提示合同。v1/v2 各自的 failed、blocked 返回用例均核对持久错误和任务错误不含绝对路径/query。

## 已核对、可沿用的证据

- AST 只遍历实际 `link` 与有定义的 `linkReference`；代码/图片/未使用 definition 不进入链接集。`resolveWikiLink` 的 Wiki 页 ID 对相对目录、百分号编码、query、hash 的解析在 UI 与校验共用；`guide%2Dname` → `guide-name` 仍符合旧 slug 合同。
- 显式 `source:` 无法由 manifest 与 Read 证实时转纯文字；未知 Wiki 页保持严格失败。校验失败保留原始 payload/evidence/dependencies，failed 项不进入 checkpoint、draft 或正式发布。repair 对同输入哈希、身份、依赖和 fence 复验后才以 attempt 0 复制；历史父项保持 failed。
- 修复后的 `review-fix-green.log` 7 项、`review-fix-budget-green.log` 5 项通过；核心回归首轮 102 项通过，唯一预算提示用例在固定安全提示修正后定向通过；KnowledgeKernel 类型检查通过。四条双 OS child + 真实 Pi SDK/Read 的 loopback 集成用例修复后再通过，合法历史候选复验新增 HTTP 0，正式 api/library Markdown 与来源在执行时经磁盘检查。UI `repo-wiki` Electron 场景 184 项、Markdown 单测 16 项、RepoWiki 类型检查通过；本次共享 helper 新字段未改变 UI 读取字段或调用合同。真实模型验收仍由根代理按唯一授权执行。
