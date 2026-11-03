# 第三次真实失败：来源行号兼容

## 根因

`live-third-failure.json` 的 `generate:overview` 有 76 个 AST 渲染链接；66 个采用 `source:path:line[-line]`。原 resolver 对根目录文件将冒号解释为协议式非法路径（38 条）；含目录的其余 28 条会被误当成包含冒号行号的文件路径。原有实现只接受 `source:path#Lx-Ly`；这不是冻结页面缺失。

## 修复

只在生成规范化中识别无 query/hash、无第二个原始冒号、正整数且顺序有效的行号后缀，经现有 resolver 检查路径，再按同一 manifest 和实际 Read 范围转换为 canonical 链接并补入来源；无法证明的显式来源按原合同去掉点击包装，越根/绝对路径/无效格式仍由严格校验拒绝。共享阅读器接口、预算、attempt 与发布契约均未改变；无任务特判。

## 证据

- `third-red.log`：新测试在修复前失败；`third-green.log`：9 测试通过，包括单行、行范围、编码路径、未读/越范围、越根/绝对路径/协议/非法行号/查询。
- `third-preflight.json`：原 payload 与存储 output_hash 一致，157 条实际 Read 匹配当前任务冻结 manifest；以快照全部 11 个 generate 页面为 pageIds，完整 AST 76 链接规范化后 66 个 canonical 来源、10 个 Wiki、0 invalid、0 warning；严格校验正文与来源通过。未调用模型或写用户数据库。
- `third-typecheck.log`：KnowledgeKernel 类型检查通过；`third-source.diff` 是本次修改的精准源码和测试差异；决策追加于现有 proposed note。

用户已授权由根代理在离线通过后对当前失败任务做一次修复重试，复用已有成果，新确定性失败即停。此离线证据不代表真实任务完成；运行版本、付费调用、恢复及正式页面验收由根代理负责。旧 f2 已取消，不执行旧恢复脚本。
