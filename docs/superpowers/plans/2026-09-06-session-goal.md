# Pi 会话 Goal 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将现有进程级、fail-open 的 Goal 扩展改造成按真实 `sessionId` 隔离、由 AgentData 权威持久化、带独立验收和可靠续跑的 Electron 会话 Goal。

**架构：** AgentData 保存 Goal 快照、revision、追加事件和墓碑；Goal 扩展只负责带 provenance 的创建/更新/完成申请工具，不再持有权威状态。Electron `GoalCoordinator` 监听已提交的 turn 结果，使用独立 system-worker judge 和按 session 的 Goal worker 继续推进、验收或停止。Turn 调度和事件信封补充 `sessionId`、`goalId`、`revision` 与幂等键，确保不同会话互不串线。渲染层只在当前 ChatView 的 `SessionGoalBar/GoalPill` 中投影状态，详情使用同页 drawer。

**技术栈：** TypeScript、Electron 38、`node:sqlite`、Pi Extension API、Zustand、React、Ant Design/`antd-style`、Vitest、pnpm/Bun sidecar 构建。

---

## 文件清单与职责

### 新建

- `electron-agent/electron/agentData/goalContracts.ts`：Electron 侧 Goal 快照、事件、停止原因和 RPC 输入输出类型。
- `electron-agent/electron/agentData/goalStore.ts`：Goal SQLite 快照、CAS 更新、历史事件、墓碑和 fork 副本。
- `electron-agent/electron/agentData/goalStore.test.ts`：存储层隔离、revision、事务和生命周期测试。
- `electron-agent/electron/app/sessionIdentity.ts`：从 Pi session 文件/状态解析稳定 `sessionId`，并校验 session 与 workspace 的归属。
- `electron-agent/electron/app/sessionIdentity.test.ts`：真实 header、文件名回退、无效路径和归属校验测试。
- `extensions/goal/contracts.ts`：sidecar 使用的 JSON 契约和状态转换辅助函数；字段与 Electron 契约保持一一对应。
- `electron-agent/electron/app/goalCoordinator.ts`：按 session 编排续跑、阻塞计数、独立裁判和 Goal worker。
- `electron-agent/electron/app/goalCoordinator.test.ts`：续跑幂等、裁判、上限、故障和 session 隔离测试。
- `electron-agent/electron/app/goalJudge.ts`：system-worker judge 的 prompt、严格输出解析和 fail-closed 结果。
- `electron-agent/electron/app/goalJudge.test.ts`：pass/fail/malformed/timeout/no-model 测试。
- `extensions/goal/tools.ts`：`get_goal`、`create_goal`、`update_goal`、`request_goal_completion` 工具注册和权限守卫。
- `electron-agent/src/features/chat/input/SessionGoalDrawer.tsx`：会话内 Goal 详情抽屉。
- `electron-agent/src/features/chat/input/SessionGoalDrawer.test.tsx`：详情、裁判、阻塞和清除墓碑视图测试。

### 修改

- `electron-agent/electron/agentData/storage.ts`：schema v2 → v3，加入 Goal 快照和事件表。
- `electron-agent/electron/agentData/runtime.ts`、`runtime.test.ts`：实例化 GoalStore、注册 project/admin RPC、事务后通知回调。
- `electron-agent/electron/app/agentDataService.ts`、`agentDataService.test.ts`：增加 typed Goal 服务入口。
- `electron-agent/electron/ipc/register.ts`、`electron-agent/electron/ipc/commandCoverage.test.ts`：增加渲染层 Goal IPC 命令及参数校验。
- `electron-agent/electron/app/piRuntimeService.ts`、`piRuntimeService.test.ts`：普通会话与独立 Goal worker 的 Turn 队列、活动回合和事件处理按 session 识别，并传递 Goal 幂等元数据。
- `electron-agent/electron/pi/manager.ts`、`manager.test.ts`：维护 workspace worker 与 per-session Goal worker 的 key/cwd/session 元数据和事件路由。
- `electron-agent/electron/app/appServer/types.ts`、`electron-agent/electron/agentData/threadStore.ts`：Turn/Thread 投影补充可选 `sessionId`，保持旧数据可读。
- `electron-agent/electron/main.ts`：把 session-aware Turn 调度、GoalCoordinator、`goal_judge` system task 和带 sessionId 的 Pi 事件信封接起来。
- `electron-agent/src/lib/pi.ts`：扩展 `PiEventEnvelope`、Goal IPC 类型和 session 状态读取类型。
- `electron-agent/src/stores/agent.ts`、`agent.test.ts`、`agentStoreRegistry.ts`：按 sessionId 过滤/标记 Pi 事件，避免后台 Goal worker 的流式事件灌入当前 UI 会话。
- `electron-agent/src/lib/agentData.ts`、`agentData.test.ts`：增加 typed Goal API。
- `electron-agent/src/store/session.ts`、`electron-agent/src/App.tsx`、`electron-agent/src/features/chat/ChatView.tsx`、`electron-agent/src/features/chat/ChatInput.tsx`：维护 `activeSessionId`，由 `openWorkspace/getState/switchSession/fork` 的真实响应更新。
- `electron-agent/src/stores/goalStore.ts`、新增 `goalStore.test.ts`：从单例改为按 sessionId 的快照缓存，拒绝旧 revision。
- `electron-agent/src/features/extensionUi/ExtensionUiHost.tsx`、对应测试：状态 payload 按 sessionId 路由，不再覆盖全局单个 Goal。
- `electron-agent/src/features/chat/input/GoalPill.tsx`、`GoalPill.test.tsx`：读取当前会话快照，使用 typed update，不再拼接 `/goal` 命令。
- `electron-agent/src/features/chat/input/editor/MessageEditor.tsx`、`MessageEditor.test.tsx`：保留 GoalPill 会话内位置，传递当前 session 上下文和详情入口。
- `electron-agent/electron/pi/systemWorkerManager.ts`、`systemWorkerManager.test.ts`、`electron-agent/electron/app/appServer/serviceTaskRegistry.ts`、对应测试：注册严格的 `goal_judge` system task。
- `electron-agent/electron/agentData/storage.ts`、`storage.test.ts`：为 turns 增加可选 `session_id`，与 Goal schema 同一迁移版本完成。
- `extensions/goal/index.ts`、`state.ts`、`judge.ts`、`index.test.ts`、`state.test.ts`、`judge.test.ts`：移除本地权威状态和 fail-open 重入逻辑，接入 RPC 工具；自动续跑和裁判由 Electron GoalCoordinator 承担。
- `docs/architecture.md`：补充 Goal 的 sessionId 归属、AgentData 权威和 fail-closed 验收边界。

---

## 任务 1：先锁定纯状态契约与裁判结果契约

**文件：**

- 修改：`extensions/goal/state.ts`、`extensions/goal/judge.ts`
- 创建：`extensions/goal/contracts.ts`
- 测试：`extensions/goal/state.test.ts`、`extensions/goal/judge.test.ts`

- [ ] **步骤 1：为状态转换写失败测试**

在 `state.test.ts` 覆盖以下具体转换：

```ts
const fixture = (status: GoalStatus): GoalSnapshot => ({
  goalId: 'g', sessionId: 's', workspace: '/repo', revision: 4,
  condition: '完成目标', status, roundsUsed: 1, maxRounds: 256,
  createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z',
});
expect(transition(fixture('active'), { type: 'pause', reason: 'user_pause' }).status).toBe('paused');
expect(transition(fixture('judging'), { type: 'judge_pass', revision: 4 }).status).toBe('complete');
expect(transition(fixture('judging'), { type: 'judge_fail', revision: 4 }).status).toBe('paused');
expect(() => transition(fixture('complete'), { type: 'resume', revision: 4 })).toThrow('INVALID_TRANSITION');
expect(() => assertRevision({ goalId: 'g', revision: 4 }, { goalId: 'g', revision: 3 })).toThrow('VERSION_CONFLICT');
```

同时锁定默认 `maxRounds=256`、`disarmed` 不自动执行、`cleared` 只读和同一障碍连续计数在恢复后归零。

- [ ] **步骤 2：运行扩展 Goal 测试确认先失败**

运行：

```bash
cd extensions
bunx vitest run goal/state.test.ts goal/judge.test.ts
```

预期：因新状态类型和转换函数尚未存在而失败；不得修改旧测试来掩盖失败。

- [ ] **步骤 3：实现最小纯契约**

在 `contracts.ts` 定义与 Electron JSON 对齐的结构：

```ts
export type GoalStatus = 'active' | 'paused' | 'disarmed' | 'judging' | 'blocked' | 'complete' | 'error' | 'cleared';
export interface GoalSnapshot {
  goalId: string; sessionId: string; workspace: string; revision: number;
  condition: string; status: GoalStatus; roundsUsed: number; maxRounds: number;
  createdAt: string; updatedAt: string;
  sourceGoalId?: string; sourceSessionId?: string; clearedAt?: string;
  stopReason?: GoalStopReason; judge?: GoalJudgeRecord; blockage?: GoalBlockageRecord;
}
export interface GoalStopReason { kind: string; summary: string; at: string; turnId?: string; }
export interface GoalJudgeRecord { model: string; verdict: 'pass' | 'fail' | 'error'; reason: string; missing: string[]; revision: number; turnId?: string; at: string; }
export interface GoalBlockageRecord { fingerprint: string; count: number; summary: string; lastTurnId?: string; at: string; }
export interface GoalEvent { id: string; goalId: string; sessionId: string; revision: number; kind: string; payload: Record<string, unknown>; idempotencyKey?: string; createdAt: string; publishedAt?: string; }
export interface GoalDispatch { idempotencyKey: string; goalId: string; revision: number; nextRound: number; status: 'claimed' | 'queued' | 'settled' | 'failed'; turnId?: string; }
export interface CreateGoalInput { sessionId: string; workspace: string; condition: string; maxRounds?: number; origin: 'human-ui' | 'human-agent'; }
export interface GoalCasUpdate { sessionId: string; goalId: string; revision: number; action: string; payload?: Record<string, unknown>; origin: string; }
export type GoalUpdateInput = GoalCasUpdate;
export interface RoundClaimInput { sessionId: string; goalId: string; revision: number; nextRound: number; idempotencyKey: string; }
export interface RoundSettlementInput { sessionId: string; goalId: string; revision: number; idempotencyKey: string; turnId: string; summary: string; }
export interface JudgeResultInput { sessionId: string; goalId: string; revision: number; verdict: 'pass' | 'fail' | 'error'; reason: string; missing?: string[]; fingerprint?: string; turnId?: string; }
```

`transition()` 只实现规格中列出的合法转换；`assertRevision()` 同时比较 `goalId` 和 `revision`。未知状态、旧 revision 和完成后写入均抛稳定错误码。

- [ ] **步骤 4：把 sidecar parser 改为 fail-closed 契约适配器**

将 `parseVerdict()` 的无法解析分支改为显式错误结果，不再返回 `ok:true`。`extensions/goal/judge.ts` 在本计划完成后只负责与 GoalJudge JSON 契约兼容的纯解析/测试，不在 `agent_end` 中调用模型；唯一权威裁判调用路径是 Electron `GoalCoordinator -> goal_judge system task`。解析结果必须区分“裁判未通过”和“裁判不可用”：

```ts
export type JudgeResult =
  | { kind: 'pass'; reason: string }
  | { kind: 'fail'; reason: string; missing: string[] }
  | { kind: 'error'; reason: string };
```

- [ ] **步骤 5：运行测试确认状态契约和裁判通过**

运行同一条 Vitest 命令，预期所有状态转换、旧 revision、malformed JSON、无模型和异常测试通过。旧的 fail-open 断言必须被替换为“不可进入 complete”的断言。

- [ ] **步骤 6：Commit**

```bash
git add extensions/goal/contracts.ts extensions/goal/state.ts extensions/goal/judge.ts extensions/goal/state.test.ts extensions/goal/judge.test.ts
git commit -m "refactor: define fail-closed goal state contract"
```

## 任务 2：建立 AgentData Goal 权威存储

**文件：**

- 创建：`electron-agent/electron/agentData/goalContracts.ts`、`electron-agent/electron/agentData/goalStore.ts`
- 修改：`electron-agent/electron/agentData/storage.ts`
- 测试：`electron-agent/electron/agentData/goalStore.test.ts`、`storage.test.ts`

- [ ] **步骤 1：先写 schema 和 CAS 测试**

在 `goalStore.test.ts` 使用 `:memory:` 数据库，覆盖：

- 两个 `sessionId` 创建相同目标文本时返回两条独立快照；
- `get(sessionA)` 永远不返回 sessionB；
- `update(expectedGoalId, expectedRevision)` 成功后 revision 加一；旧 revision 返回 `VERSION_CONFLICT`；
- `clear` 保留 tombstone 和事件，`getActive` 返回空；
- `fork` 生成新 `goalId`、保留 `sourceGoalId/sourceSessionId`、状态为 `disarmed`；
- 程序重启读取 `active` 快照后变为 `disarmed`，历史不丢失；
- 事务失败时不调用发布回调。

- [ ] **步骤 2：运行存储测试确认失败**

运行：

```bash
cd electron-agent
pnpm exec vitest run electron/agentData/goalStore.test.ts electron/agentData/storage.test.ts
```

预期：`goalStore` 文件不存在或表不存在导致失败。

- [ ] **步骤 3：增加 schema v3**

在 `AgentDataStorage.migrate()` 中把版本提升到 3，并创建以下最小表结构：

```sql
CREATE TABLE IF NOT EXISTS goal_snapshots (
  goal_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  condition TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_snapshots_workspace ON goal_snapshots(workspace);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_live_session
  ON goal_snapshots(session_id)
  WHERE status <> 'cleared';
CREATE TABLE IF NOT EXISTS goal_events (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT,
  published_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_events_session ON goal_events(session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_event_idempotency
  ON goal_events(goal_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS goal_turn_leases (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  origin TEXT NOT NULL,
  prompt_digest TEXT,
  continuous_intent INTEGER NOT NULL DEFAULT 0,
  goal_id TEXT,
  revision INTEGER,
  created_at INTEGER NOT NULL,
  released_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_goal_turn_leases_session ON goal_turn_leases(session_id, created_at);
```

快照 JSON 保存完整的 `stopReason/judge/blockage/source` 字段；可索引字段用于 session/revision 查询，不从 JSON 文本猜状态。`goal_snapshots` 保存每一代 Goal，`cleared` 行作为墓碑排除在 live 唯一索引之外；同一 session 清除后可以创建新的 `goalId`。`get(sessionId)` 返回该 session 最近一代，`getLive(sessionId)` 只返回非 `cleared` 行。事件的 `idempotency_key` 由 `goalId + revision + nextRound` 组成，数据库唯一索引与事务共同保证重启/并发不重复排队。

同一 v3 migration 通过 `ensureColumn('threads', 'session_id', 'TEXT')` 和 `ensureColumn('turns', 'session_id', 'TEXT')` 保留旧 thread/turn 行；新的 CreateThread/CreateTurn 必须写入真实 sessionId，旧行允许为空并只用于兼容历史读取。可信 `origin/prompt_digest/continuous_intent` 写入 `goal_turn_leases`，由主进程创建和释放，sidecar 只能读取当前已绑定 lease。

- [ ] **步骤 4：实现 GoalStore 的事务 API**

实现以下方法并让每个写入在同一 SQLite transaction 内完成快照更新与事件追加：

```ts
get(sessionId: string): GoalSnapshot | undefined;
create(input: CreateGoalInput): GoalSnapshot;
update(input: GoalCasUpdate): GoalSnapshot;
claimRound(input: RoundClaimInput): GoalDispatch;
settleRound(input: RoundSettlementInput): GoalSnapshot;
recordJudge(input: JudgeResultInput): GoalSnapshot;
history(sessionId: string, limit?: number): GoalEvent[];
fork(sourceSessionId: string, targetSessionId: string): GoalSnapshot | undefined;
clear(input: GoalCasUpdate): GoalSnapshot;
```

`claimRound/settleRound/recordJudge/clear` 必须检查 `goalId + revision`；`claimRound` 使用幂等键 `goalId + revision + nextRound`，重复调用返回已有 dispatch 状态而不重复排队；只有 `settleRound` 才递增已完成轮次。

`maxRounds` 只接受安全整数 `>0`；默认 256，直接 human UI 才能调整。GoalStore 强制 `roundsUsed <= maxRounds`；把上限调低到已用轮次以下返回 `MAX_ROUNDS_BELOW_USAGE`，不能截断历史或伪造完成。

同一 session 只要存在非 `cleared` 快照（包括 `paused/disarmed/judging/blocked/error`）就拒绝第二次 `create`，返回 `GOAL_ALREADY_EXISTS`；只有用户先 clear 后，才创建新的 goalId 代际。

- [ ] **步骤 5：运行 GoalStore 回归**

运行任务 2 的 Vitest 命令，预期所有 session 隔离、CAS、迁移、墓碑、fork 和幂等测试通过。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/agentData/storage.ts electron-agent/electron/agentData/goalContracts.ts electron-agent/electron/agentData/goalStore.ts electron-agent/electron/agentData/goalStore.test.ts electron-agent/electron/agentData/storage.test.ts
git commit -m "feat: persist session-scoped goals in agent data"
```

## 任务 3：暴露带权限边界的 Goal RPC 与 typed API

**文件：**

- 修改：`electron-agent/electron/agentData/runtime.ts`、`electron-agent/electron/app/agentDataService.ts`、`electron-agent/electron/ipc/register.ts`、`electron-agent/electron/ipc/commandCoverage.test.ts`
- 修改：`electron-agent/src/lib/agentData.ts`、`electron-agent/src/lib/agentData.test.ts`
- 测试：`electron-agent/electron/agentData/runtime.goal.test.ts`、`electron-agent/electron/app/agentDataService.test.ts`

- [ ] **步骤 1：写 RPC 权限和 revision 失败测试**

覆盖以下请求矩阵：

```ts
await expect(projectClient.request('goal.get', { sessionId: 's2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
await expect(projectClient.request('goal.update', { sessionId: 's1', goalId: 'g', revision: 1, action: 'pause' })).resolves.toMatchObject({ status: 'paused' });
await expect(projectClient.request('goal.update', { sessionId: 's1', goalId: 'g', revision: 1, action: 'resume' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
await expect(rootClient.request('admin.goal.update', { sessionId: 's1', goalId: 'g', revision: 2, action: 'clear', origin: 'automatic' })).rejects.toMatchObject({ code: 'HUMAN_AUTH_REQUIRED' });
```

project socket 的 `workspace` 只用于 endpoint 认证；`sessionId` 必须由 `AgentDataRuntimeOptions.resolveSession(workspace, sessionId)` 或已登记 capability 匹配，不能信任请求里任意 workspace 取代 session。任务 3 用 fake resolver 覆盖 A/B session，任务 7 接入真实 Pi worker bind/unbind 生命周期。

- [ ] **步骤 2：运行失败测试**

```bash
cd electron-agent
pnpm exec vitest run electron/agentData/runtime.goal.test.ts electron/app/agentDataService.test.ts electron/ipc/commandCoverage.test.ts
```

- [ ] **步骤 3：注册 project/admin 方法**

在 `AgentDataRuntime` 注册：

```text
goal.get
goal.create
goal.update
goal.recordProgress
goal.requestCompletion
goal.judgeResult
goal.history
admin.goal.get
admin.goal.update
admin.goal.history
```

project 方法强制使用 endpoint 所属 workspace 和 `sessionId`；admin 方法只接受明确 sessionId，不提供“当前 workspace 推断”快捷路径。每个成功写入在返回快照前执行发布回调，发布回调失败不回滚已提交事务。

- [ ] **步骤 4：增加主进程 typed service 和 renderer IPC**

在 `AgentDataService` 暴露（内部统一调用 `admin.goal.*`，不让 renderer 直接使用 project socket）：

```ts
goalGet(sessionId: string, workspace: string): Promise<GoalSnapshot | undefined>;
goalUpdate(input: GoalUpdateInput): Promise<GoalSnapshot>;
goalHistory(sessionId: string): Promise<GoalEvent[]>;
```

在 `register.ts` 增加 `agentData_goal_get/update/history`，只从 IPC 参数读取显式 `sessionId`、`goalId`、`revision` 和 action。`agentData.ts` 提供同名 typed API，不让 UI 拼接 slash 命令。

- [ ] **步骤 5：运行 RPC/IPC/typed API 测试**

预期新增测试全部通过，且现有 `runtime.test.ts`、`agentDataService.test.ts`、`commandCoverage.test.ts` 无回归。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/agentData/runtime.ts electron-agent/electron/agentData/runtime.goal.test.ts electron-agent/electron/app/agentDataService.ts electron-agent/electron/app/agentDataService.test.ts electron-agent/electron/ipc/register.ts electron-agent/electron/ipc/commandCoverage.test.ts electron-agent/src/lib/agentData.ts electron-agent/src/lib/agentData.test.ts
git commit -m "feat: expose session-scoped goal RPC"
```

## 任务 4：补充真实 sessionId 和 session-aware Turn 事件

**文件：**

- 创建：`electron-agent/electron/app/sessionIdentity.ts`、`sessionIdentity.test.ts`（抽取/复用 `WorkspaceService` 的 session header/文件名 helper，避免第二套 Windows 路径解码）
- 修改：`electron-agent/electron/pi/manager.ts`、`manager.test.ts`、`electron-agent/electron/app/piRuntimeService.ts`、`piRuntimeService.test.ts`、`electron-agent/electron/app/appServer/types.ts`、`electron-agent/electron/agentData/threadStore.ts`
- 修改：`electron-agent/electron/agentData/storage.ts`、`storage.test.ts`、`electron-agent/electron/main.ts`、`electron-agent/src/lib/pi.ts`

- [ ] **步骤 1：锁定 session identity 测试**

使用临时 JSONL 文件测试：

```ts
await writeFile(file, JSON.stringify({ type: 'session', id: 'session-a', cwd: 'C:/repo' }) + '\n');
await expect(readSessionIdentity(file)).resolves.toEqual({ sessionId: 'session-a', sessionPath: file, workspace: 'C:/repo' });
```

无 session header 时从 `<timestamp>_<uuid>.jsonl` 提取 id；路径归属不匹配时返回 `SESSION_WORKSPACE_MISMATCH`，不接受调用方提供的替代 workspace。

- [ ] **步骤 2：为 Turn/事件写 session 隔离失败测试**

在 `piRuntimeService.test.ts` 增加同一 workspace 的 session A/B：启动 A 的 turn 后切到 B，B 的事件不得完成 A；重复 `goalId + revision + nextRound` 只排队一次；旧 session 事件只更新旧 turn。

- [ ] **步骤 3：为 Goal 选择独立 per-session worker**

普通交互仍使用现有 workspace worker；自动 Goal turn 使用稳定 key `__goal__:${sessionId}` 创建独立 Pi worker，并在 spawn args 直接传 `--session <sessionPath>`，不先恢复 workspace 的 last session。该 worker 拥有自己的 SessionManager，不会因为用户在同一 workspace 切换到 B 而把 A 的下一轮写入 B。每个 session 同时只允许一个 worker turn；普通交互和 Goal worker 通过 session lease 互斥，冲突时 Goal turn 保持 queued 而不抢占用户回合。

在 `PiManager`/`PiRuntimeService` 增加显式 `openGoalWorker(sessionId, workspace, sessionPath)` 和 `closeGoalWorker(sessionId)`；底层 manager API 接受 `{ key, cwd, logicalWorkspace, sessionId }`，事件 handler 使用 logicalWorkspace/sessionId，绝不把 `__goal__:*` key 交给 `WorkspaceService.ensureWorkspace`。worker 关闭不影响当前 UI worker。权限 profile、AgentData endpoint、MCP 配置和 sandbox workspace 继续沿用目标 workspace。

worker key 只用于进程路由；ThreadStore/AgentData 的 `projectId`、`workspace` 和审计字段始终写真实 workspace，不得把 `__goal__:${sessionId}` 当作项目路径。

- [ ] **步骤 4：扩展活动回合元数据和 queue key**

把 `PiRuntimeService` 的活动项从：

```ts
Map<string, { threadId: string; turnId: string }>
```

改为：

```ts
Map<string, { workspace: string; sessionId: string; sessionPath: string; threadId: string; turnId: string; goal?: GoalTurnMeta }>
```

`queuedTurns`、`assistantItems`、`workspaceThreads` 的 Goal worker 键使用 `sessionId`；workspace 仍只用于资源和权限 profile。`turn.start` 接受 `sessionId/sessionPath/goalId/revision/idempotencyKey`，发送前校验 sessionPath 对应的 sessionId。普通 workspace worker 的旧命令路径保持兼容，但不能执行带 Goal 元数据的自动 turn。

维护 `currentSessionByWorkspace`：每次 `openWorkspace/get_state/new_session/switch_session/fork` 成功后刷新；普通 `agent_prompt` 在 `prepareTurn` 前读取该 sessionId 并申请同一 session lease。这样普通 B turn 与 A 的 Goal worker 能被明确区分，不能只用 workspace 判断并发。

- [ ] **步骤 5：扩展事件信封和持久化投影**

`PiEventEnvelope` 增加 `sessionId` 和 `source: 'interactive' | 'goal'`；main 发送 `pi://event` 前从活动回合元数据取值，不能从 renderer 当前标签页推断。任务 2 的 schema v3 已给 `threads` 和 `turns` 增加可选 `session_id`；本任务只实现 `ThreadStore` 的 create/read/row mapping 透传，旧行允许 `NULL`，新 Goal/普通 turn 都写真实 sessionId。迟到事件不覆盖不同 session 的 turn。Goal worker 的原始流式事件标记 `source='goal'`，renderer `agent.ts` 在入队前按 source/sessionId 过滤，不触发当前可见 store 的 reducer；切回该 session 时通过历史读取显示已提交结果，Goal status 仍单独广播。测试覆盖 A worker 事件不会改变 B 的消息/streaming 状态。

- [ ] **步骤 6：运行 session-aware Turn 测试**

```bash
cd electron-agent
pnpm exec vitest run electron/app/sessionIdentity.test.ts electron/app/piRuntimeService.test.ts electron/agentData/threadStore.test.ts
```

预期：同 workspace 双 session、切换、fork、重复幂等键和旧事件测试通过。

- [ ] **步骤 7：Commit**

```bash
git add electron-agent/electron/app/sessionIdentity.ts electron-agent/electron/app/sessionIdentity.test.ts electron-agent/electron/pi/manager.ts electron-agent/electron/pi/manager.test.ts electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/app/piRuntimeService.test.ts electron-agent/electron/app/appServer/types.ts electron-agent/electron/agentData/threadStore.ts electron-agent/electron/agentData/storage.ts electron-agent/electron/agentData/storage.test.ts electron-agent/electron/main.ts electron-agent/src/lib/pi.ts
git commit -m "feat: carry session identity through Pi turns"
```

## 任务 5：重写 Goal 扩展为 AgentData-backed 工具

**文件：**

- 修改：`extensions/goal/contracts.ts`、`extensions/goal/index.ts`、`extensions/goal/state.ts`、`extensions/goal/index.test.ts`、`extensions/goal/state.test.ts`、`extensions/index.ts`
- 创建：`extensions/goal/tools.ts`、`extensions/goal/tools.test.ts`
- 测试：`extensions/goal/judge.test.ts`

- [ ] **步骤 1：写工具权限测试**

覆盖：

- `get_goal` 只使用 `ctx.sessionManager.getSessionId()`；模型传入的 workspace/sessionId 被忽略；
- `create_goal` 在 `PI_IS_SUBAGENT=1`、`PI_SYSTEM_WORKER=1`、`PI_GOAL_WORKER=1`、自动 turn provenance 或没有可信 `origin=human` 时返回 `GOAL_CREATE_FORBIDDEN`；
- `update_goal`、`request_goal_completion` 必须带当前 `goalId + revision`；
- 自动 turn 只能报告进展、报告阻塞或申请完成，不能修改 condition、maxRounds、暂停、恢复或清除；
- fork/reload 后读取到 `disarmed`，不会由扩展自行调用 `turn.start`。
- `pluginManifest.capabilities` 包含 `tool`，`extensions/index` 的 manifest allowlist 能发现四个 Goal 工具。

- [ ] **步骤 2：运行扩展测试确认先失败**

```bash
cd extensions
bunx vitest run goal/index.test.ts goal/state.test.ts goal/judge.test.ts goal/tools.test.ts
```

- [ ] **步骤 3：实现 MemoryClient-backed Goal port**

使用现有 `extensions/memory/client.ts` 的 loopback RPC，不新增 socket 协议。所有 RPC 参数由扩展上下文注入：

```ts
const sessionId = ctx.sessionManager.getSessionId();
const workspace = ctx.cwd;
await client.request('goal.get', { sessionId, workspace });
```

工具返回的 snapshot 先校验 `sessionId`、`goalId` 和 `revision`，再更新 sidecar 短期缓存；缓存不是权威源。

工具参数只允许有限摘要：`condition <= 4000` 字符，`evidence <= 4000`，每个 turn reference 只含稳定 turnId，`reportBlocked` 只含摘要和证据，不接受 sessionId/goalId 作为归属字段。服务端从 `ctx.sessionManager.getSessionId()` 和当前快照注入真实归属，并对超长输入返回 `INVALID_PARAMS`。

- [ ] **步骤 4：实现可信 turn provenance**

Electron `turn.start` 和普通 `agent_prompt` 在进入 sidecar 前由主进程维护可信 turn lease；Goal worker 使用受控环境 `PI_GOAL_WORKER=1`，system judge 使用 `PI_SYSTEM_WORKER=1`。扩展只读取 lease/环境和 `PI_IS_SUBAGENT`，不接受模型参数中的 origin；`create_goal` 仅接受主进程标记的 `origin='human'` 且该 turn 含直接用户输入。服务端同时保存本轮原始 human prompt 的摘要，并要求工具提交 `continuousIntentEvidence`；只把明确包含“持续推进/直到完成/完成后再停止”等持续意图的 prompt 判为可创建，否则返回 `GOAL_CREATE_INTENT_REQUIRED`。SDK 的 RPC `InputEvent.source` 不作为权限依据。

- [ ] **步骤 5：移除扩展内自动裁判/重入**

`agent_end` 只把真实 turn 结束和完成申请/阻塞报告交给 AgentData；不得在扩展进程内直接调用 judge、清除 Goal 或递归 `sendMessage`。这保证续跑、幂等和独立裁判只有一个 owner：Electron `GoalCoordinator`。

- [ ] **步骤 6：迁移 `/goal` 命令为兼容薄层**

保留 `/goal pause|resume|clear|<condition>`，命令只构造当前 session 的 typed Goal RPC；Electron 对来自用户输入框的 slash command 预先标记 `origin='human-ui'`，自动 turn 的同名文本不能获得该标记。不再直接修改局部 `state` 或 `pi.appendEntry`。旧 custom entry 只用于首次迁移为 `disarmed` 快照，并追加 `legacy_goal_restored` 事件，不改写原始日志。

- [ ] **步骤 7：运行扩展测试确认通过**

预期工具权限、可信 provenance、CAS、legacy migration、命令兼容和“agent_end 不自行续跑/裁判”的测试通过。

- [ ] **步骤 8：Commit**

```bash
git add extensions/goal/contracts.ts extensions/goal/tools.ts extensions/goal/tools.test.ts extensions/goal/index.ts extensions/goal/state.ts extensions/goal/judge.ts extensions/goal/index.test.ts extensions/goal/state.test.ts extensions/goal/judge.test.ts
git commit -m "feat: make goal extension agent-data backed"
```

## 任务 6：实现独立 GoalCoordinator、system judge 和 per-session worker

**文件：**

- 创建：`electron-agent/electron/app/goalCoordinator.ts`、`goalCoordinator.test.ts`、`goalJudge.ts`、`goalJudge.test.ts`
- 修改：`electron-agent/electron/pi/systemWorkerManager.ts`、`systemWorkerManager.test.ts`、`electron-agent/electron/app/appServer/serviceTaskRegistry.ts`、对应测试、`electron-agent/electron/main.ts`
- 修改：`electron-agent/electron/app/piRuntimeService.ts`、`piRuntimeService.test.ts`、`electron-agent/electron/agentData/runtime.ts`、`runtime.goal.test.ts`
- 修改：`electron-agent/electron/app/workspaceService.ts`、对应测试：删除会话/项目时通知 GoalCoordinator 清理 per-session worker。

- [ ] **步骤 1：写 coordinator 状态机测试**

使用假的 AgentData、Goal worker 和 service-task runner，先锁定：

- turn 完成只计一次 `roundsUsed`；
- `goalId + revision + nextRound` 重复通知只排一次；
- 达到快照 `maxRounds` 后变为 `paused + max_rounds`；
- completion request 原子进入 `judging` 后只启动一个 judge；
- judge pass → `complete`，fail → `paused`，malformed/timeout/no-model → `error` 或故障暂停；
- 旧 revision 结果只写过期事件；
- A/B 两个 session 同一 workspace 的 worker、事件和队列互不影响。
- `onTurnSettled` 只在 ThreadStore turn 状态提交成功后调用；持久化失败不递增轮次、不启动下一轮。
- 在 Goal turn 在途时用户 pause/update/clear，旧 turn settle、completion 或 judge 结果只写 stale event，不递增新 revision 的 rounds、不再排下一轮。

- [ ] **步骤 2：注册 `goal_judge` system task**

在 `ServiceTaskRegistry` 的内置任务表注册 `goal_judge` 的输入/输出 schema、超时和 capability；在 `SystemWorkerManager` 增加严格 prompt 和解析：

```ts
type GoalJudgeOutput = {
  verdict: 'pass' | 'fail'; reason: string; missing: string[];
  blockageFingerprint?: string;
};
```

输出缺字段、JSON 不可解析、模型超时或 worker 崩溃都抛出可识别错误，不能转换成 pass。Coordinator 用稳定 task id `goal-judge-${goalId}-${revision}` 调用现有 `AgentDataService.runServiceTask` → `TaskQueue` → `SystemWorkerManager` 链路，保留 service_tasks 的重启、失败和审计语义。输入明确标注 `mode: 'completion' | 'blockage'`；阻塞模式必须返回稳定、脱敏的 `blockageFingerprint`，completion 模式忽略该字段。传入 judge 的 transcript 只保留截断后的必要 turn 摘要/结构化证据，不写入完整隐私原文；`GoalSnapshot` 只保存 reason、missing、fingerprint、turn 引用和脱敏摘要。system worker 使用独立模型配置，不继承当前会话的 judge 关闭开关。

- [ ] **步骤 3：实现 GoalCoordinator**

定义唯一调度入口：

```ts
interface GoalCoordinator {
  onTurnCompleted(input: GoalTurnCompleted): Promise<void>;
  onCompletionRequested(input: GoalCompletionRequest): Promise<void>;
  resume(input: GoalMutation): Promise<GoalSnapshot>;
  stop(): Promise<void>;
}
```

其中 `GoalTurnCompleted` 至少包含 `{ workspace, sessionId, sessionPath, turnId, status, goal?: GoalTurnMeta, summary }`；`GoalCompletionRequest` 包含 `{ sessionId, goalId, revision, turnId, evidence }`；`GoalMutation` 是已由 IPC 固定为 `human-ui` 的 `GoalCasUpdate`；`GoalTurnMeta` 包含 `{ goalId, revision, idempotencyKey, nextRound }`。`summary/evidence` 在进入 AgentData 或 system task 前按长度上限截断。

协调器先读取最新快照，再在 AgentData transaction 中 `claimRound`（只写幂等 dispatch，不递增已完成轮次）或 claim judging；turn 成功 settle 后再 `settleRound` 递增 `roundsUsed`，当 `roundsUsed === maxRounds` 时在同一事务原子写入 `paused + max_rounds`，事务成功后才启动下一轮或 `goal_judge`。`reportBlocked` 只提交摘要和证据，Coordinator/独立 judge 生成 canonical blockage fingerprint，再由程序累计连续次数并保存最近 turn 引用；模型不能直接指定 fingerprint。失败、取消、关闭和 session mismatch 都写结构化 stopReason 并停止续跑。

AgentData 写入失败时不继续执行下一轮；Coordinator 在内存故障表和主进程诊断日志记录 `persistence_error`，若能写入则把 Goal 置为 `error`，UI 显示“状态保存失败”，不得静默吞错或显示完成。

- [ ] **步骤 4：实现 per-session Goal worker**

普通 UI worker 继续使用 workspace key；Goal worker 使用 `__goal__:${sessionId}` key 和目标 `sessionPath`，main 先 bind session capability，再 spawn，spawn 参数包含 `--session <sessionPath>`，每个 session 独立维护 Pi client、Thread、assistant item 和队列。worker 启动时校验 `get_state.sessionId`，不匹配即失败，不尝试把目标消息送入当前活动会话；manager 测试锁定不会先收到错误 session 的 migration/status，初始 `session_start` 失败可在 bind 完成后只重试一次。

Goal worker 与普通 worker 共享每 session 的 Turn lease；当前 session 有用户 turn 时排队，不能抢占或中止用户输入。用户切换标签页不会释放 Goal lease 或关闭 Goal worker。

Goal worker 使用非交互 automation permission profile；任何需要用户确认的 permission/UI request 直接返回拒绝并写入 `runtime_error`，不把确认卡投递到当前可见会话，避免后台 worker 永久挂起。普通 UI worker 继续使用现有 interactive 路由。

- [ ] **步骤 5：接入 AgentData callback 和状态发布**

在 `AgentDataRuntimeOptions` 增加 `onGoalChanged(snapshot)` 和 `onGoalCompletionRequested(request)` 回调；后者只把带 turnId/revision 的 completion request 写成 pending 事件，绝不在 tool RPC 返回时启动 judge。GoalStore commit 成功后才触发。PiRuntimeOptions 增加 `onTurnSettled(result)`，在 `threadStore.updateTurn` 成功后调用 coordinator；result 只携带 `sessionId/turnId/goal meta`、截断后的 assistant/tool 摘要和 stopReason，不携带完整隐私 transcript。Coordinator 只在对应 turn settled 后 claim judging 并派发 `goal_judge`。main 广播包含完整快照 DTO 的 versioned `goal` status payload，renderer 可直接更新详情；广播失败不回滚数据库，renderer 仍可通过 `goal.get` 重新读取。

main wiring 使用两阶段 setter：先创建 AgentData/系统 worker，再创建 PiRuntime，最后调用 `agentData.setGoalCoordinator(coordinator)`。`goal_events.published_at IS NULL` 的事件在 setter 后按 event id 重放；Coordinator 用 event id/幂等键去重，成功通知后写 `published_at`，不会因 `piRuntime` 尚未赋值而丢首个 completion/progress 事件。

- [ ] **步骤 6：覆盖恢复、fork、关闭和 worker 清理**

仅在真实 runtime restart、历史 resume 或 fork 时把活动快照改为 `disarmed`；同一进程的 `switch_session`/切标签不改变 Goal 状态，也不停止后台 worker。fork 创建新 goalId。Goal worker 在首个 active dispatch 时惰性创建，暂停、blocked、judging、complete、cleared 后不再接收新 turn；空闲 15 分钟关闭，恢复时重新创建并校验 sessionId。删除 session 或应用关闭先拒绝新 dispatch、停止 Goal worker，再等待已提交 turn/system judge/AgentData 事务结束；关闭过程中保留最新快照和 stopReason。Goal worker 不能复用 `__system__` worker，避免共享 session。

应用 shutdown 顺序固定为：`GoalCoordinator.stop()`（拒绝新 dispatch，等待/标记在途任务）→ 关闭 Goal workers → 等待 system judge → 停止 AgentData → 关闭普通 Pi workers；测试必须断言没有遗留 queued `goal_judge` 或 Goal turn。

`WorkspaceService.deleteConversation/removeProject` 触发 `GoalCoordinator.onWorkspaceDeleted(workspace)`，停止该 workspace 下所有 session Goal worker、拒绝新 dispatch，但只写墓碑/保留历史，不删除 Goal events。

- [ ] **步骤 7：运行后端 Goal 测试**

```bash
cd electron-agent
pnpm test -- electron/app/goalCoordinator.test.ts electron/app/goalJudge.test.ts electron/pi/systemWorkerManager.test.ts electron/agentData/runtime.goal.test.ts electron/app/piRuntimeService.test.ts
```

- [ ] **步骤 8：Commit**

```bash
git add electron-agent/electron/app/goalCoordinator.ts electron-agent/electron/app/goalCoordinator.test.ts electron-agent/electron/app/goalJudge.ts electron-agent/electron/app/goalJudge.test.ts electron-agent/electron/pi/systemWorkerManager.ts electron-agent/electron/pi/systemWorkerManager.test.ts electron-agent/electron/app/appServer/serviceTaskRegistry.ts electron-agent/electron/app/appServer/serviceTaskRegistry.test.ts electron-agent/electron/main.ts electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/app/piRuntimeService.test.ts electron-agent/electron/app/workspaceService.ts electron-agent/electron/app/workspaceService.test.ts electron-agent/electron/agentData/runtime.ts electron-agent/electron/agentData/runtime.goal.test.ts
git commit -m "feat: coordinate independent session goal workers"
```

## 任务 7：接入 Electron IPC、恢复和状态发布

**文件：**

- 修改：`electron-agent/electron/main.ts`、`electron-agent/electron/ipc/register.ts`、`electron-agent/electron/ipc/commandCoverage.test.ts`、`electron-agent/electron/app/agentDataService.ts`
- 测试：`electron-agent/electron/app/agentDataService.test.ts`、`electron-agent/electron/agentData/runtime.goal.test.ts`

- [ ] **步骤 1：拆分可信来源路由**

`agentData_goal_update` 的 IPC handler 固定写入 `origin='human-ui'`，忽略 renderer 传入的 origin 字段；sidecar project RPC 只能由已绑定 worker 写入 `origin='agent'` 或 `origin='goal_automatic'`。admin/root token 不自动等价于人类授权，自动来源不能执行 pause/resume/clear/condition update。

- [ ] **步骤 2：注册 session capability**

在 `AgentDataRuntime` 增加由 main trusted `requestAdmin` 调用的 `goal.session.bind/unbind`：main 在 spawn Goal worker 前先登记 `{sessionId, workspace, token}`，Pi worker 打开、switch、fork、close 时更新/撤销；禁止把 token 放在 RPC params 让 sidecar 自报。project Goal RPC 只能访问该 token 已绑定的 sessionId。绑定失效时返回 `SESSION_NOT_BOUND`，不能仅凭 workspace 通过。测试覆盖 spawn 前 bind、初始 `session_start`、bind 失败重试和 close unbind。

- [ ] **步骤 3：验证 open/switch/new/fork 生命周期**

扩展 `PiRuntimeService.openWorkspace` 返回 `sessionId + sessionFile`；App/ChatView 在 `newSession`、`switchSession`、`fork` 后更新 capability。迟到的旧 worker 事件在 coordinator 和 renderer 两层都按 sessionId/revision 丢弃。

- [ ] **步骤 4：运行 IPC/runtime 回归**

```bash
cd electron-agent
pnpm test -- electron/app/agentDataService.test.ts electron/agentData/runtime.goal.test.ts electron/ipc/commandCoverage.test.ts electron/app/piRuntimeService.test.ts
```

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/main.ts electron-agent/electron/ipc/register.ts electron-agent/electron/ipc/commandCoverage.test.ts electron-agent/electron/app/agentDataService.ts electron-agent/electron/app/agentDataService.test.ts electron-agent/electron/agentData/runtime.ts electron-agent/electron/agentData/runtime.goal.test.ts electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/app/piRuntimeService.test.ts
git commit -m "feat: bind goal RPCs to trusted session capabilities"
```

## 任务 8：改造 Renderer Goal 投影和会话内 UI

**文件：**

- 修改：`electron-agent/src/stores/goalStore.ts`、`electron-agent/src/features/extensionUi/ExtensionUiHost.tsx`、对应测试
- 修改：`electron-agent/src/features/chat/input/GoalPill.tsx`、`GoalPill.test.tsx`、`MessageEditor.tsx`、`MessageEditor.test.tsx`
- 修改：`electron-agent/src/store/session.ts`、`electron-agent/src/App.tsx`、`electron-agent/src/features/chat/ChatView.tsx`、`electron-agent/src/features/chat/ChatInput.tsx`
- 修改：`electron-agent/src/stores/agent.ts`、`electron-agent/src/stores/agent.test.ts`、`electron-agent/src/stores/agentStoreRegistry.ts`
- 创建：`electron-agent/src/features/chat/input/SessionGoalDrawer.tsx`、`SessionGoalDrawer.test.tsx`

- [ ] **步骤 1：先写 session map 和旧 revision 测试**

`goalStore` API 固定为：

```ts
setSnapshot(sessionId: string, snapshot?: GoalSnapshot): void;
getSnapshot(sessionId: string): GoalSnapshot | undefined;
clearSnapshot(sessionId: string, revision: number): void;
dropSession(sessionId: string): void; // 只清实时投影，不删除 AgentData 历史
```

测试两个 session 同时存在、旧 revision 事件不覆盖新快照、切换 session 后读取为空不复用上一个 Goal。

- [ ] **步骤 2：实现 `bySession` store 和事件路由**

`ExtensionUiHost` 只接受 `schemaVersion=1` 的 Goal payload，并按 payload.sessionId 写入 map；缺少 sessionId 的旧状态只记录兼容诊断，不更新当前 store。保留其它扩展 status 的行为。

`ChatView/ChatInput` 在 `activeSessionId` 变化时显式调用 `agentDataApi.goal.get(sessionId, workspace)`，使用 request epoch 丢弃旧 session 的迟到响应；事件只用于刷新提示，不能替代首次读取。应用重启、切换、new/fork 后都清空旧 session 的本地投影再拉取新快照；删除会话调用 `dropSession`，只清实时缓存，不删除历史。

- [ ] **步骤 3：改造 GoalPill 的数据和操作**

从 `useSessionStore.activeSessionId` 读取真实 Pi `get_state.sessionId`（禁止从 sessionPath 文件名猜测），再读取 `useGoalStore.getSnapshot(sessionId)`；按钮调用 `agentDataApi.goal.update` 并传 `goalId + revision`。状态矩阵：`judging/complete` 禁止暂停/修改/清除；`blocked` 显示连续次数和解除阻塞；无 Goal 返回 `null`。

- [ ] **步骤 4：实现详情 drawer**

`SessionGoalDrawer` 只接受当前 session snapshot，展示 condition、sessionId、goalId、revision、rounds/maxRounds、stopReason、judge evidence、blockage 和最近事件；清除使用确认对话框，清除后显示墓碑而不是删除历史。

- [ ] **步骤 5：运行前端 Goal 测试**

```bash
cd electron-agent
pnpm exec vitest run src/stores/goalStore.test.ts src/features/extensionUi/ExtensionUiHost.test.tsx src/features/chat/input/GoalPill.test.tsx src/features/chat/input/SessionGoalDrawer.test.tsx src/features/chat/input/editor/MessageEditor.test.tsx
```

预期覆盖无 Goal 不占位、切会话隔离、旧事件丢弃、六种主要状态、详情和 typed mutation。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/src/stores/goalStore.ts electron-agent/src/stores/goalStore.test.ts electron-agent/src/features/extensionUi/ExtensionUiHost.tsx electron-agent/src/features/extensionUi/ExtensionUiHost.test.tsx electron-agent/src/features/chat/input/GoalPill.tsx electron-agent/src/features/chat/input/GoalPill.test.tsx electron-agent/src/features/chat/input/SessionGoalDrawer.tsx electron-agent/src/features/chat/input/SessionGoalDrawer.test.tsx electron-agent/src/features/chat/input/editor/MessageEditor.tsx electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx electron-agent/src/store/session.ts electron-agent/src/App.tsx electron-agent/src/features/chat/ChatView.tsx electron-agent/src/features/chat/ChatInput.tsx electron-agent/src/stores/agent.ts electron-agent/src/stores/agent.test.ts electron-agent/src/stores/agentStoreRegistry.ts
git commit -m "feat: render goals inside the active session"
```

## 任务 9：迁移、fork、历史和审计验收

**文件：**

- 修改：`extensions/goal/state.ts`、`extensions/goal/index.ts`、`electron-agent/electron/agentData/goalStore.ts`、`electron-agent/electron/app/piRuntimeService.ts`
- 测试：`extensions/goal/state.test.ts`、`electron-agent/electron/agentData/runtime.goal.test.ts`、`electron-agent/electron/app/piRuntimeService.test.ts`
- 文档：`docs/architecture.md`

- [ ] **步骤 1：锁定旧日志迁移**

给只有旧 `{condition, react, paused}` custom entry 的 session 创建 `disarmed` snapshot，`revision=1`，`source='legacy'`；扩展 `CustomEntryLike` 增加可选 `timestamp`，历史事件 payload 保存 `legacyEntryTimestamp`、原始 condition 和 react。原始 JSONL 不变。

- [ ] **步骤 2：锁定 fork 行为**

fork 测试断言新 session 只有独立 Goal 副本、`sourceGoalId/sourceSessionId` 正确、状态 `disarmed`，新 session 的 pause/resume/update 不改变源 session。

- [ ] **步骤 3：锁定审计内容**

每次 create/update/pause/resume/judging/judge_result/blocked/clear/fork 都追加结构化事件；详情 drawer 使用同一事件列表，不从 UI 文案反推历史。

- [ ] **步骤 4：更新架构文档**

在 `docs/architecture.md` 写明 Goal 的唯一归属键、AgentData 权威、Turn 幂等键、裁判 fail-closed 和会话页内 UI 入口；不描述未实现的 Token 预算或全局 Goal 页面。

- [ ] **步骤 5：运行迁移与审计测试**

运行：

```bash
cd extensions
bunx vitest run goal/state.test.ts goal/index.test.ts
cd ../electron-agent
pnpm test -- electron/agentData/goalStore.test.ts electron/agentData/runtime.goal.test.ts electron/app/piRuntimeService.test.ts
```

预期旧日志、重启、fork、clear、审计和历史读取全部通过。

- [ ] **步骤 6：Commit**

```bash
git add extensions/goal/state.ts extensions/goal/index.ts electron-agent/electron/agentData/goalStore.ts electron-agent/electron/agentData/runtime.goal.test.ts electron-agent/electron/app/piRuntimeService.test.ts docs/architecture.md
git commit -m "feat: preserve goal history across recovery and fork"
```

## 任务 10：构建 sidecar、全量验证和交付检查

**文件：**

- 读取/验证：`electron-agent/scripts/build-sidecar.mjs`、`electron-agent/package.json`
- 测试：任务 1–9 的全部新增/修改测试

- [ ] **步骤 1：构建 sidecar**

运行：

```bash
cd electron-agent
bun run build:sidecar
```

预期：sidecar 产物包含新的 Goal extension 和工具；构建日志无缺少 `goal` 模块的错误。

- [ ] **步骤 2：运行扩展全量相关测试**

```bash
cd extensions
bunx vitest run goal _shared
```

- [ ] **步骤 3：运行 Electron 相关全量回归**

```bash
cd electron-agent
pnpm test -- electron/agentData electron/app/piRuntimeService.test.ts electron/app/agentDataService.test.ts electron/ipc/commandCoverage.test.ts src/stores/goalStore.test.ts src/features/extensionUi/ExtensionUiHost.test.tsx src/features/chat/input/GoalPill.test.tsx src/features/chat/input/SessionGoalDrawer.test.tsx
```

预期：新增 Goal 测试、AgentData、PiRuntime、IPC 和会话 UI 测试全部通过；既有失败必须区分为本分支已有问题，不得改写为通过。

- [ ] **步骤 4：构建 Electron**

```bash
cd electron-agent
pnpm build
```

预期：TypeScript 与 electron-vite 构建退出码为 0，sidecar 和 renderer 均包含 Goal 新契约。

- [ ] **步骤 5：做真实临时会话冒烟**

使用临时 works/session 目录，不读取用户已有数据库：

1. 创建 session A 和 session B；分别创建相同 condition 的 Goal；
2. 在 A 暂停、在 B 修改，确认彼此 revision/condition 不变化；
3. 让 A 进入 judging，检查 UI 不显示 complete；
4. 注入裁判 malformed/timeout，确认 Goal 保留且续跑停止；
5. 恢复 A，确认只启动 A 的下一轮；
6. fork A，确认新副本 disarmed；
7. clear B，确认会话页显示墓碑且历史仍可读。

- [ ] **步骤 6：执行真实窗口视觉验收**

运行 `cd electron-agent; pnpm dev`，在 1440×900、1200×800 和 760×800 窗口分别打开两个 session，检查 GoalPill 位于输入框上方、详情 drawer 不跳路由、长 condition/stopReason 不溢出、键盘可以聚焦编辑/暂停/详情/清除按钮。用现有浏览器/CUA 截图记录执行中、正在验收、业务阻塞和已完成四个状态；确认后台 Goal worker 的流式事件不会出现在当前可见会话消息流。

- [ ] **步骤 7：执行差异和规格核对**

```bash
git diff --check
git status --short
```

核对结果必须满足：Goal 没有独立实时页面；所有写入含 `goalId + revision`；默认轮次 256 且可授权调整；首版无 Token/费用预算；裁判失败不进入 complete；未暂存无关用户改动。

- [ ] **步骤 8：Commit**

```bash
git add electron-agent/electron/app/goalCoordinator.ts electron-agent/electron/app/goalCoordinator.test.ts electron-agent/electron/app/goalJudge.ts electron-agent/electron/app/goalJudge.test.ts electron-agent/electron/app/sessionIdentity.ts electron-agent/electron/app/sessionIdentity.test.ts electron-agent/electron/app/workspaceService.ts electron-agent/electron/app/workspaceService.test.ts electron-agent/electron/pi/manager.ts electron-agent/electron/pi/manager.test.ts electron-agent/electron/pi/systemWorkerManager.ts electron-agent/electron/pi/systemWorkerManager.test.ts electron-agent/electron/app/appServer/types.ts electron-agent/electron/app/appServer/serviceTaskRegistry.ts electron-agent/electron/app/appServer/serviceTaskRegistry.test.ts electron-agent/electron/agentData/storage.ts electron-agent/electron/agentData/storage.test.ts electron-agent/electron/agentData/goalStore.ts electron-agent/electron/agentData/goalStore.test.ts electron-agent/electron/agentData/threadStore.ts electron-agent/electron/agentData/runtime.ts electron-agent/electron/agentData/runtime.goal.test.ts electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/app/piRuntimeService.test.ts electron-agent/electron/main.ts electron-agent/electron/ipc/register.ts electron-agent/electron/ipc/commandCoverage.test.ts electron-agent/electron/app/agentDataService.ts electron-agent/electron/app/agentDataService.test.ts electron-agent/src/lib/agentData.ts electron-agent/src/lib/agentData.test.ts electron-agent/src/lib/pi.ts electron-agent/src/store/session.ts electron-agent/src/App.tsx electron-agent/src/features/chat/ChatView.tsx electron-agent/src/features/chat/ChatInput.tsx electron-agent/src/stores/agent.ts electron-agent/src/stores/agent.test.ts electron-agent/src/stores/agentStoreRegistry.ts electron-agent/src/stores/goalStore.ts electron-agent/src/stores/goalStore.test.ts electron-agent/src/features/extensionUi/ExtensionUiHost.tsx electron-agent/src/features/extensionUi/ExtensionUiHost.test.tsx electron-agent/src/features/chat/input/GoalPill.tsx electron-agent/src/features/chat/input/GoalPill.test.tsx electron-agent/src/features/chat/input/SessionGoalDrawer.tsx electron-agent/src/features/chat/input/SessionGoalDrawer.test.tsx electron-agent/src/features/chat/input/editor/MessageEditor.tsx electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx extensions/goal/contracts.ts extensions/goal/index.ts extensions/goal/state.ts extensions/goal/judge.ts extensions/goal/tools.ts extensions/goal/*.test.ts extensions/index.ts docs/architecture.md
git commit -m "test: verify session goal end to end"
```

---

## 实施顺序与检查点

1. 完成任务 1–3 后检查：纯状态、SQLite CAS、RPC 权限和 session capability 已通过；此时不应出现任何 UI 改动。
2. 完成任务 4–6 后检查：同 workspace 双 session 的 Turn/事件不串线，自动轮次幂等，裁判和阻塞状态可持久化；此时可用 API/日志验证，不依赖浏览器。
3. 完成任务 7–8 后检查：当前会话 GoalBar 与详情 drawer 可交互，切换标签页不改变后台状态，历史/fork/墓碑可读。
4. 完成任务 9 后检查：旧日志迁移、fork、墓碑和审计事件可重复读取。
5. 任务 10 只在前四个检查点通过后执行；真实冒烟使用临时目录，不触碰用户已有索引、数据库或会话。

## 计划自检

- **规格覆盖度：** 会话归属、revision/CAS、创建权限、续跑上限、独立裁判、业务阻塞、运行故障、AgentData 事务、重启/fork/clear、会话内 UI、测试和非目标分别由任务 1–10 覆盖。
- **占位符扫描：** 计划没有未完成占位项、模糊的“适当处理”或未定义的函数名；每个代码步骤给出了文件、接口、SQL、命令和预期结果。
- **类型一致性：** Electron 与 extension 均使用 `GoalStatus/GoalSnapshot` 的同名 JSON 字段；所有 mutation 使用 `goalId + revision`；Turn 调度使用 `sessionId/sessionPath/idempotencyKey`；renderer 使用 `bySession`。
- **安全边界：** workspace 只作为 endpoint/资源权限上下文，不能替代 sessionId；旧 revision、迟到事件、裁判结果和重复幂等键均不会覆盖新状态。
- **范围边界：** 不加入独立 Goal 控制台、Token/费用预算、Cordis、Tauri 或无关 AgentData 重构。
