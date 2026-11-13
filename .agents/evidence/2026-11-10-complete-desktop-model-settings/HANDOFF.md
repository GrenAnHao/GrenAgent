# A 最终接续

## 当前状态

A 生产源码冻结，OpenSpec 已逐项复核为 20/20（all_done）。第三统一候选已实际消费，`production-aggregate-final.log` 为 19/19；13 个定向测试文件 155/155，邻接状态机 83/83，CLI / Node 类型新增诊断均为空。

root 接管最终整合与任务关闭；A 不再并行修改本状态机。若后续 B / C / D 改动使模块消费路径变化，可直接重用以下命令验证最终候选，不必重跑未变化的 UI 或全套用例。

## 精确命令与必须观察的结果

```powershell
# 从仓库根目录，默认读取 electron-agent/out-pkg/main
node electron-agent/scripts/smoke-model-settings.mjs

npm run verify-notes
openspec validate complete-desktop-model-settings --strict
openspec instructions apply --change complete-desktop-model-settings --json
```

生产探针负责隔离目录 / 环境 / 真实 Electron RunAsNode / worker entry。必须退出 0，`facts` 19 项；其中真实 host 的 `pi.syncModelCompactionBudgets` 必须含 main + embedded + worker 3 份实际 SDK 回执，embedded 单项失败时其余两份成功，恢复后无需重启，dispose 后只剩 main。其他数值 / metadata / 冷恢复字段详见 README.md。

代码新增配额只执行 models.json 显式字段；Google / WS 等不支持状态必须拒绝显式覆盖，目录原生 metadata 不增加前提。当前 guard 源、预算 owner 与 worker transport 已全部接通。

## 任务已全部关闭

4.4 已用第三候选的真实 3-owner 聚合、部分失败 / 其他成功、重试与卸载证明完成；6.2 已用第三 CLI / Electron build、155 定向测试、类型零增量、AGENTS 场景说明及 notes / strict validate 门禁完成。每项勾选后均重取 apply instructions，最终 `progress.json` 为 20/20、all_done。

最终 root 整合若改变 A 的实际消费路径，可重跑上面的生产命令；不变 A 的 B / C / D 改动复用已有有效证据。没有归档 / 同步主 specs / 提交 / 发布。

## 证据位置

本目录 README.md 为索引，关键文件：`production-aggregate-final.log`、`production-results.json`、`targeted-tests-final.log`、`subagent-budget-adjacent-tests.log`、`ui-check-final.log`、`ui-copy-calibration.log`、`cli-types-comparison.json`、`node-types-comparison.json`。

Agent Note：`.agents/notes/implemented/feature/2026-11-10-desktop-model-settings.md`。退出后 legacy inline 回退属于原有认证现状，本轮不扩 logout；不要把它写成 A 引入或已经修复。
