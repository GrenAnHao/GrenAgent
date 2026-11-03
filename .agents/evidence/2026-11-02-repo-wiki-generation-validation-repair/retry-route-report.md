# 重试入口错路由修复

## 根因与修复

`run.counts.prepared` 是正文完成数，不包含已准备的概览、目录和失败候选。旧投影把“可 repair 且正文为 0”的失败任务展示为 generate，走 `repoWiki_generate`；其主进程路径再 prepare/start 新 generate，丢失原 task ID 与 retryOf。本轮根据服务端 repair capability 决定重试动作，确认绑定原 task/revision/model/plan；run 在确认前消失时在确认框报错并拒绝，不回落 generate。其它快照过期由服务端校验。确认文案显示已完成、失败或受阻数，注明保存成果通过校验后复用，未承诺失败项必然重做。

## 验证

- `retry-route-red.log` 复现原始零正文失败错误路由；`retry-vanished-red.log` 复现确认期间 run 消失的错误处理缺陷；`retry-copy-red.log` 复现确认目标误称增量。
- `retry-route-green.log`：3 个相关测试文件 59 项通过；零正文失败实际点击确认后向桩桥发送 action=repair、原 10f59 task ID 和原 revision，并不调用 generate；run 消失时拒绝、不调用 action 或 generate；原不同任务快照确认绑定测试保留。
- `retry-route-typecheck.log`：Repo Wiki 类型检查通过。`retry-route.diff` 为第三次 source 修复之后的精确增量；已有 source/manifest/Read、正文校验与账本/attempt/发布合同未改。
- `retry-route-harness-green.log`：仅 repo-wiki Electron 场景 190 项通过；真实 DOM + 鼠标操作，主进程 I/O 为确定性桩，不是付费/真实模型验收。`retry-zero-prepared` 截图已目视检查，确认文本、外发警示及按钮完整可读。此前 harness 因旧期望仍把重试算作 generate 失败，调整为新路由真实计数后复跑。

真实 5206 被根代理取消并保留费用账本，10f59 成果仍保留；本轮未操作真实任务、应用或模型。根代理负责审查与加载、确认原任务详情可用性；当前无再次付费授权，正式完成仍待后续用户决定。
