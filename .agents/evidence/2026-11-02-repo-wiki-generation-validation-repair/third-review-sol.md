# 第三次来源行号兼容：独立 Sol 审查

**结论：通过本次增量审查，可对新任务 `10f59f63-e763-4379-9970-f77428f63d6b` 发起获准的一次 repair。** 旧 f2 已取消，不得应用其恢复脚本。本次只审源码差异、冻结候选和已有离线证据；未启动应用、访问数据库、调用模型或重跑测试。

## 审查依据

- `third-source.diff` 只改 `validation.ts` 的生成规范化入口及对应测试。新匹配仅接受 `source:相对路径:正整数[-正整数]`，无原始额外冒号、query、hash；范围须安全整数且终点不小于起点。随后仍走 `resolveWikiLink`，manifest 命中及本轮 Read 范围覆盖，才补入 `sources` 并写成既有 `source:path#Lx-Ly`。绝对路径、越根及协议式目标不会被新匹配绕过；无证据显式来源沿旧合同去掉链接包装。阅读器和 Wiki slug 契约未改。
- `live-third-failure.json` 的 `generate:overview` 为 failed、attempt 1、`INVALID_PAGE_LINK`，保有 payload/evidence/output_hash；`third-preflight.ts` 对该 payload 先核原 hash，再由匹配冻结 manifest hash 的 157 条 Read 形成范围。`third-preflight.json` 对全部 11 个 generate pageId 规范化后统计 66 个 canonical source、10 个 Wiki、0 invalid、0 warning，且严格正文/来源校验通过。这个预检证明坏候选可离线复验，不等于新任务已发布。
- 真实 repair 路径 `coordinator.ts:47,89-90` 先比 candidate inputHash 与当前 node、依赖哈希，再从原 evidence 重建 Read 范围并调用本次 `normalizeStageSources` 和严格 `validateStageResult`；`store.ts:233,255-262` 再查原候选 output hash、任务身份/模型/计划、目标 fence/依赖后复制为 prepared，不改父记录、不新增模型调用。后续未生成页仍走原调度与预算。
- 现有 `third-red.log` 显示修前复现；`third-green.log` 为 9/9；`third-typecheck.log` 通过。未重复执行这些有效检查。

## 边界判断

新增测试对非法行号和 query 主要用根文件路径；含目录的畸形显式来源在旧 resolver 合同下可能降级纯文字，而非整页硬失败。这没有形成可点击的越权来源，也不是本差异新增的放宽；若产品后来要求所有畸形显式来源一律硬失败，应单独改合同和测试，不应阻止当前已证实的 66 条来源修复。

**根代理下一步：** 确认运行进程载入本次构建后，仅针对新任务执行用户授权的一次 repair；核实际候选被零模型复用、其余必需页完成、最终发布正文及来源。若新确定性失败，按约定停止。 
