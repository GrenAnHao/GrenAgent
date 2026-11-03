# Sol 定向复核：安全死导航与同任务恢复

审查 `navigation-policy.diff`、`navigation-policy-report.md`、更新的决策 note、当前校验/存储/出版调用链及现有验证记录；未改产品代码、未重跑测试或调用模型。**结论：未发现本轮新契约的发布阻断；可按用户授权恢复同一 f2 任务。** 本轮规则是用户明确接受的调整：安全且无目标的 Wiki 相对链接转为正文并记 warning，不再当整页硬失败。

## 新规则与安全边界

- `normalizeWikiNavigation` 只处理 AST 中实际的 `page` 链接且目标不在冻结 `pageIds`；`source`、外链、锚点、代码与未使用 definition 不进入删除集。按原始子节点源码切片保留粗体、行内代码等 Markdown 标记，warning 记录当前页和无 query/hash 的相对目标。同一页目标去重；越根/绝对/未知协议被 `resolveWikiLink` 判为 invalid，仍由严格 validator 拒绝。
- 目标位于 manifest 的源码路径不会被当作死 Wiki 链接删掉；只有 Read 范围证明后 `normalizeStageSources` 才能转成 `source:`，未读到仍会由严格 validator 报错。显式 `source:` 的原有不可核实→纯文字合同未变。未经规范化的安全未知 Wiki 链接直接送 `validateStageResult` 仍硬失败，说明宽容只在规范化入口发生。

## 续跑与出版完整性

- v1/v2 在恢复路径、建立新 attempt 前，先对同任务 failed 候选核对 node inputHash、完整依赖 outputHash、当前 Read evidence 文件 hash 与 fence，再本地 normalize/validate/advance。`promoteFailedCandidate` 在事务内检查 failed/原 payload hash、inputHash、依赖和 fence，原 attempt 不变、failed 计数转 prepared；不调用模型或重置预算。无效候选回到原调度/预算路径。
- 出版先校验 checkpoint 的原 payload/outputHash、manifest 输入/输出 hash、evidence、依赖以及原正文/来源一致；v2 另重放 graph 和 completion manifest。然后以冻结页集合和原 Read evidence 确定性规范化正式正文并严格校验，原 `inputManifest.outputHash` 不改；`normalizedBodyHash` 标识规范化正文，最终 publication intent 包含正文。页集合、正文非空和来源校验仍是硬门槛，原子提交路径未改。
- 增量复用把既有 `inputManifest.navigationWarnings` 随 baseline 带入新的受证实 payload；本轮增量测试核对无关源码变化不重发 generate 且 warning 保留。旧无 manifest 的直接出版入口仍可用，未将新来源前提强加给它。

## 决定性证据与执行边界

- 双 OS child/Pi SDK/Read/loopback 集成 9/9，覆盖安全 unknown 正向出版、v1/v2 越根硬失败、父候选 repair、本任务候选 resume HTTP 0 且 attempt 不变、旧 prepared 原 hash 保留并规范化出版 HTTP 0。额外增量与 projectPort 9/9、KnowledgeKernel 类型检查通过。
- 真实任务只读预检 11/11：10 份父 prepared 和 f2 的 1 份 failed 候选在各自冻结 snapshot 下原 payload hash 与 Read 证据有效，按当前规范化和严格校验通过，产生 8 个安全 warning。该预检没有修改真实任务；运行时仍须核对当前 graph/fence，并在 completed 后用只读正式文件入口检查 16 页、正文、来源与 warning。
- 根代理可载入新构建恢复**同一 f2**；不另建任务、不重置 attempt/预算。若恢复再次出现确定性失败，按本轮授权停止并保留任务证据。
