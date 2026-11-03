# 重试入口增量审查（Sol）

**结论：暂不批准以此候选宣称真实 `10f59f63-e763-4379-9970-f77428f63d6b` 的 UI 修复完成。** 新投影修正了“失败且正文 prepared=0”时把 repair 错判为 generate 的局部逻辑；但真实较新的已取消 `5206` 任务会先占据项目默认快照，旧失败任务仍无法从该入口选中。另有确认快照的服务端计划绑定缺口。以下均为静态审查；未访问真实 DB、启动应用、调用模型或重跑已有检查。

## P1：较新的已取消任务遮住待修复失败任务

`App.tsx:296` 刷新时只传 `project_id,target`，不传 task ID；`repoWikiService.ts:314` 原样请求 `admin.knowledge.snapshot`。`coordinator.ts:42` 在未指定 task ID 时取 `jobs.list()` 的第一个匹配项，而 `jobStore.ts:23` 按 `updated_at DESC` 排序。按已知真实顺序，`5206` 后创建且随后被取消，更新时间晚于 `10f59`；默认快照便是 cancelled 的 `5206`。`projectKnowledge.ts:97-99` 只在 **failed** 且有 repair capability 时展示修复，cancelled 会展示生成。因此本次零正文 failed 桩测和 190 条 harness 断言虽通过，却未覆盖真实“两任务并存”的入口，用户仍可能点到新 generate。

**修法：** 为明确选中的历史任务提供按 task ID 读取/展示及 action 入口，或定义可审计的默认任务选择规则，使该项目的待修复 failed 能被选中；不要把已取消 `5206` 偷换成原 `10f59`。加“较新 cancelled + 较旧 failed”的后端快照到 UI 点击闭环，并断言 action 的 `task_id=10f59…`、无 `generate` 请求。若产品只意图在任务详情修旧任务，应明确让该入口可达，并核对确认内容。

## P2：repair 确认的计划 token 未在服务端绑定

UI `App.tsx:1037,996` 固定了原 task ID、revision、modelIdentity、planToken；确认期间 run 变 null 时现在抛错而不回落 generate，这部分正确。服务端 `coordinator.act` 的 repair 分支（`coordinator.ts:124`）却忽略传入的 `expectedPlanToken`，重新读取当前 `p.planToken` 后传给 `start`；`store.createTask:77-80` 只核 retryOf 身份，不核原任务 planHash 或确认时 revision。确认后计划发生变化时，可建一个名为 repair、但无法复用原候选的新任务，并开始模型调度；这与“确认原快照、保存成果通过校验后复用”的承诺不符。`act` 在异步读取前的 revision 检查也不足以作创建时 CAS。

**修法：** repair 在创建任务前校验当前计划 token = 确认 token = 原任务 planHash，并在创建事务内对 retryOf 原任务 revision/状态再验一次；不匹配则拒绝且不创建任务/不调模型。加确认后改计划与旧任务 revision 变化的定向回归。

## 本差异已通过的部分

- `knowledgeProjection.ts:97` 改用后端 repair capability，不再以正文 prepared 数推断；`App.tsx:994-1008` 在确认 action 存在而 run 消失时拒绝，无 generate fallback。原 task ID、revision、模型身份和计划 token 均从打开确认时的快照传出；正常初次生成仍走原 `generate` 分支。
- 文案“已完成正文数／失败或受阻数，已保存成果通过校验后复用”符合现有计数含义，没有把 overview/catalogue 误称正文 prepared。
- 现有证据：关联 59 项、Repo Wiki 类型通过，唯一 `repo-wiki` Electron harness 190/190；它们验证了单个 failed 快照的前端分支，不覆盖以上两项跨任务/服务端边界。

当前没有再次付费授权。修复和验证应保持离线；旧 f2 恢复脚本不得执行。
