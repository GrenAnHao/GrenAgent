# AgentData 任务记录清理

**目标：** 支持单条删除及当前筛选结果内的批量清理，只处理 completed / failed / cancelled 任务，保留 pending / running、Wiki、代码索引及既有审计。

**方案：** JobsPanel 在确认时取得目标 ID 快照，IPC 转发到 `admin.jobs.remove` / `admin.jobs.clear`，JobStore 在事务内根据当前数据库状态检查并删除，返回实际删除结果。保留已有工作区改动，不自动提交或操作真实任务数据。

## 步骤

- [x] JobStore 先写回归：三类终态能删除、两类活动态不可删除、批量只处理指定 ID、保留审计、重复删除幂等。
- [x] 运行 `npm test -- electron/agentData/jobStore.test.ts` 观察失败，实现带终态条件的删除并事务记录审计，再运行通过。
- [x] 挂接 Runtime / IPC / typed API，真实 RPC 回归验证无参数不能变成全库清理；运行 `npm test -- electron/agentData/jobCleanup.test.ts electron/ipc/register.test.ts src/lib/agentData.test.ts`。
- [x] JobsPanel 增加单条删除和“清理已结束”按钮：确认、当前筛选范围、进行中禁用、错误提示、成功刷新；先红后绿运行 `npm test -- src/features/agentData/JobsPanel.test.tsx`。
- [x] 合并检查接口、执行相关测试与构建；Wiki 手动创建仅核对参考项目并回答，本轮不新增 Wiki 创建入口。

## 验证

- JobStore 7 个新增回归先失败后通过；删除与审计同事务，审计失败或批量中途失败均回滚。
- JobsPanel 25 个用例通过；覆盖终态按钮、确认取消、筛选范围、确认时 ID 快照、部分删除结果及刷新。
- 最终 8 个相关文件 71 个测试通过；Electron 构建和 JobStore 定向严格类型检查通过。
- 前端定向类型检查仍有 `agentData.ts` 既有 `AgentJobCreateInput` / `MemoryScope` 缺少索引签名两处错误，本次没有改动相关调用。
- 没有删除真实任务，也没有新增 Wiki 手动创建 UI。
