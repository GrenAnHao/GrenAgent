# v2 并发暂停排空

控制分支等待所有在途结果，逐项只接纳已规范化校验的 prepared；核对当前 graph 输入、task、phase、item、fence，再通过原 `advanceStageGraph` 和 `store.commitItem` 验证依赖、attempt 与 fence。非 prepared、无效或过期结果不 ACK，继续沿既有 running / replay 语义。排空后抛出中断，维持原暂停终态、模型 drain、租约释放顺序，不补槽或发布。

- `pause-drain-red.log`：两个 prepared、以及先 failed 后 prepared 两项均复现第二页被丢弃。
- `pause-drain-green.log`：11 项通过，含双并发控制场景、v1/v2 单项暂停、正常并行补槽与错误安全回归。
- `pause-drain-stale-green.log`：三项通过，分别为双 prepared、failed + prepared、过期 input + prepared；验证 failed 不计数，过期项不 ACK，模型 drain 时可见已接收项，暂停且无发布。
- `pause-drain-typecheck.log`：KnowledgeKernel 类型检查通过；限定文件 `git diff --check` 通过。
- `pause-drain.diff` 只包含本轮修复、测试及笔记，相对本轮开始时工作区；未触碰真实任务或调用付费模型。真实任务仍未完成；下一次授权验收由根代理在复核后处理。
