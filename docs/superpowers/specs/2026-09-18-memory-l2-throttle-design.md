# AgentData Memory L2 节流设计

日期：2026-09-18
状态：设计已确认，实现计划见 `docs/superpowers/plans/2026-09-18-memory-l2-throttle.md`

## 1. 背景与问题

L1 抽取提交后会立刻入队 `memory_scene`，场景任务完成后再可能入队 `memory_persona`。系统 worker 是串行短调用，一轮对话最多变成抽取、去重、场景、原则四次 LLM。全局 L2 场景会被每轮重写，费用和抖动都偏高。

TencentDB 用 `pipeline-manager` 做 L1 阈值 / warmup / 空闲 debounce / L2 延迟与最小间隔 / L3 互斥。Pi 的捕获路径已经按 source 合并进行中的 `memory_extract`，不需要整段移植。本规格只补 L2 的延迟与最小间隔，执行形态保持「worker 出 JSON、主进程落库」。

## 2. 目标

- L1 提交后不立刻跑 L2。到期公式：`fireAt = max(now + 10s, lastL2At + 900s)`。
- 等待窗口内又写入新 L1：合并进同一份待跑载荷，并从这次 L1 重新计算 `fireAt`（debounce）。
- 日程落盘。进程退出后，下次启动若已到期则立刻入队；未到期则重新挂定时器。
- 任务栏只显示真正入队的 `memory_scene` / `memory_persona`，不显示等待中的日程。
- 不改 `TaskQueue` 派发模型。

## 3. 非目标

- 不移植 L1 warmup、everyN、空闲 debounce、backlog drain。
- 不移植 L2 maxInterval、L3 全局互斥。L3 仍在 `completeScene` 之后按现有规则入队。
- 不改向量召回、真实消息 ID、存储对账 / generation-log。
- 不给 `service_tasks` 增加 `not_before` 或 `scheduled` 状态。

## 4. 架构

新增按用户一行的日程表，由 `MemoryService` 写入和唤醒；到期才 `enqueue({ kind: 'memory_scene' })`。

节流键是 `userId`。L2 是该用户一份全局场景池，不按 session / workspace 分定时器。

```
L1 提交 / completeDedup 写出新 L1
        │
        ▼
upsert memory_layer_schedules(user_id, 'memory_scene')
  payload.memories 合并
  fire_at = max(now + delay, last_fired_at + minInterval)
  重置进程内 timer
        │
        │ 到期（或启动时 fire_at <= now）
        ▼
若该用户已有 queued/running 的 memory_scene → 不入队，保留日程，完成后再算 fire_at
否则 enqueue memory_scene，清除 pending 日程（保留 last_fired_at）
        │
        ▼
completeScene → 现有 L2 落库 → 写 last_fired_at = now → 现有 L3 触发规则
```

## 5. 数据

表放在 `MemoryStore` 使用的同一 SQLite（`memories` / `memory_captures` 旁边），不新建数据库。

```sql
CREATE TABLE IF NOT EXISTS memory_layer_schedules (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  last_fired_at INTEGER NOT NULL DEFAULT 0,
  fire_at INTEGER,
  payload TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);
```

- `kind` 本规格只使用 `memory_scene`。
- `fire_at` / `payload` 为 NULL 表示当前没有等待中的 L2。
- `last_fired_at` 是上次 **成功** `completeScene` 的墙钟时间（毫秒）。不用 L2 行的 `updatedAt`，避免人工编辑场景把间隔清零或拉长。
- `payload` JSON：

```ts
{
  scope: { userId: string; workspace: string; projectId?: string; sessionId?: string };
  source: string;
  memories: L1Record[];
}
```

合并规则：把新 L1 追加到 `memories` 末尾；若 `content + type + scene_name` 与已有条目相同则跳过。上限 200 条，超出丢弃最旧的。`scope` / `source` 以最新一次 L1 提交为准（入队时的 project/session 元数据）。

## 6. 到期计算

常量（生产默认，可注入）：

- `delayMs = 10_000`（对齐 TencentDB `l2DelayAfterL1Seconds = 10`）
- `minIntervalMs = 900_000`（对齐 `l2MinIntervalSeconds = 900`）

```
fireAt = max(now + delayMs, lastFiredAt + minIntervalMs)
```

`lastFiredAt === 0`（从未成功跑过 L2）时，最小间隔不挡，只等 `delayMs`。

## 7. 与正在跑的 scene 任务

`scheduleScene` 发现该 `userId` 已有 `queued` 或 `running` 的 `memory_scene` 时：

- 仍然 upsert 日程（合并 memories、重算 `fire_at`）。
- 不入队第二份 `memory_scene`。
- `completeScene` 结束时：写入 `last_fired_at`，若日程仍有 payload，按当时 `now` 重算 `fire_at` 并重新挂 timer。

查找进行中任务：`queue.findPending?.('memory_scene', task => task.input.userId === userId)`。没有 `findPending` 的队列（测试里部分 mock）视为没有进行中任务。

## 8. 时钟与唤醒

`MemoryService` 构造注入：

```ts
layerSchedule?: {
  delayMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => { cancel: () => void };
}
```

缺省：`Date.now`、`delayMs=10_000`、`minIntervalMs=900_000`、`setTimeout`。

`delayMs === 0 && minIntervalMs === 0` 时：`scheduleScene` 在同一次调用里直接 `enqueue`（仍走合并与「已有 running 则不入第二队」），不写 `fire_at` 等待行。这是测试夹具专用快捷路径，生产不得这样配置。

进程内 `Map<userId, { cancel }>`，同一用户只保留一只 timer。upsert 时取消旧的，按 `fire_at - now` 重新挂；已到期则 `ms = 0`。

`recoverLayerSchedules()` 在 runtime / AgentDataService 启动且 MemoryService 建好后调用：扫描 `kind='memory_scene' AND fire_at IS NOT NULL` 的行，为每行挂 timer。

## 9. 失败策略

- L1 已经提交后再写日程。日程 upsert 失败只记日志，不回滚 L1，也不改走立刻入队（失败关闭：宁可不跑 L2，也不打回「每轮都跑」）。
- 到期 `enqueue` 失败：保留日程行，用 `delayMs` 再挂一次 timer。
- `completeScene` 非法输出：不更新 `last_fired_at`，L1 不回滚；若日程已在入队时清除，这次失败等于丢掉本批 L2，下一次新 L1 再排。入队成功即清除 pending payload，避免失败后用同一批反复打满重试。非法 L2 与今天行为一致：任务失败，不重放同一 output。
- 不在退出钩子里强制冲掉等待中的 L2。下次启动补跑。

## 10. 测试约定

现有立刻入队 `memory_scene` 的单测，经 `setup()` 注入 `delayMs: 0, minIntervalMs: 0`，行为与现在相同。

新测用假时钟覆盖默认 10s / 900s：

1. 首次 L1：不入队 scene；推进 10s 后入队，payload 含那批 L1。
2. t=0 一次 L1，t=5s 再一次：只在 t=15s 入队一次，payload 含两批。
3. 一次 L2 成功后立即又有 L1：在 `last_fired_at + 900s` 之前不入队。
4. 写入日程后新建 `MemoryService` 并 `recoverLayerSchedules`：`fire_at` 已过则立即入队；未过则等到点入队。
5. scene 任务 running 时到来的 L1 只更新日程，不入第二队。

集成测试（`extensionIntegration` / `AgentDataRuntime` 测试夹具）同样注入 `delayMs: 0, minIntervalMs: 0`，避免真等 10 秒。生产路径不注入，走默认值。

## 11. 代码落点

- 新建：`electron-agent/electron/app/memoryLayerSchedule.ts`（到期计算、payload 合并、表读写）
- 修改：`electron-agent/electron/agentData/memoryStore.ts`（建表；或由 schedule 模块用同一 `DatabaseSync` 建表）
- 修改：`electron-agent/electron/app/memoryService.ts`（`scheduleScene` 改为 upsert 日程；`completeScene` 写 `last_fired_at`；启动恢复）
- 修改：`electron-agent/electron/agentData/runtime.ts`、`electron-agent/electron/app/agentDataService.ts`（启动时 `recoverLayerSchedules`）
- 测试：`memoryLayerSchedule.test.ts`、扩展 `memoryService.test.ts`；夹具补零延迟

表读写可以放在 `MemoryStore` 上几条方法，或 schedule 模块直接 `db.exec`/`prepare`。优先小模块 + store 建表，避免 `memoryService.ts` 再膨胀。
