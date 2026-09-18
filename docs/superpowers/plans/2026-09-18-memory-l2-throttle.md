# Memory L2 节流 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** L1 提交后按 `max(now+10s, lastL2+900s)` 才入队 `memory_scene`；等待中合并新 L1 并重新计时；日程落盘，重启可补跑。

**架构：** 不改 `TaskQueue`。`MemoryStore` 旁新增 `memory_layer_schedules` 一行一用户。`MemoryService.scheduleScene` 只 upsert 日程并挂 timer；到期再 `enqueue('memory_scene')`。L3 仍在 `completeScene` 之后按现有规则入队。

**技术栈：** TypeScript、node:sqlite、vitest

**规格：** `docs/superpowers/specs/2026-09-18-memory-l2-throttle-design.md`

**硬约束：** TDD；工作区已是隔离分支，不要切到脏 `master`；不要改计划文件勾选之外的正文；系统 worker 仍零工具。用户未要求提交则跳过各任务的 Commit 步骤。

---

## 文件结构

**新建**

| 文件 | 职责 |
| --- | --- |
| `electron-agent/electron/app/memoryLayerSchedule.ts` | 到期计算、L1 合并、日程表读写 |
| `electron-agent/electron/app/memoryLayerSchedule.test.ts` | 纯函数 + 表 CRUD |

**修改**

| 文件 | 改动 |
| --- | --- |
| `electron-agent/electron/agentData/memoryStore.ts` | 构造时建表，并挂 `schedules: LayerScheduleStore` |
| `electron-agent/electron/app/memoryService.ts` | `layerSchedule` 注入；`scheduleScene` 改日程；`completeScene` 写 `last_fired_at`；`recoverLayerSchedules` / `dispose` |
| `electron-agent/electron/app/memoryService.test.ts` | `setup()` 默认 `delayMs:0,minIntervalMs:0`；新增假时钟测例 |
| `electron-agent/electron/agentData/runtime.ts` | 选项透传；启动 `recoverLayerSchedules`；`close` 调 `dispose` |
| `electron-agent/electron/agentData/extensionIntegration.test.ts` | 夹具注入零延迟，否则 L2 要等 10s |

**不修改：** `taskQueue.ts`、L1 抽取提示词、`memory_persona` 入队条件、向量召回。

---

## 任务 1：到期公式与记忆合并

**文件：**
- 创建：`electron-agent/electron/app/memoryLayerSchedule.ts`
- 测试：`electron-agent/electron/app/memoryLayerSchedule.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { computeFireAt, mergeLayerMemories } from './memoryLayerSchedule';

describe('computeFireAt', () => {
  it('从未跑过 L2 时只加 delay', () => {
    expect(computeFireAt(1_000, 0, 10_000, 900_000)).toBe(11_000);
  });

  it('取 delay 与最小间隔的较大值', () => {
    expect(computeFireAt(1_000_000, 200_000, 10_000, 900_000)).toBe(1_100_000);
    expect(computeFireAt(1_000_000, 995_000, 10_000, 900_000)).toBe(1_895_000);
  });
});

describe('mergeLayerMemories', () => {
  const a = { content: '先对齐', type: 'work_method' as const, priority: 90, scene_name: 's', source_message_ids: [], metadata: {} };
  const b = { content: '后落库', type: 'work_task' as const, priority: 80, scene_name: 's', source_message_ids: [], metadata: {} };

  it('追加新记录并跳过 content+type+scene_name 相同的条目', () => {
    expect(mergeLayerMemories([a], [a, b])).toEqual([a, b]);
  });

  it('超过 200 条丢掉最旧的', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...a, content: `c${i}` }));
    const merged = mergeLayerMemories(many, [{ ...b, content: 'newest' }]);
    expect(merged).toHaveLength(200);
    expect(merged[0].content).toBe('c1');
    expect(merged.at(-1)?.content).toBe('newest');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryLayerSchedule.test.ts`

预期：FAIL，`Failed to resolve import "./memoryLayerSchedule"`

- [ ] **步骤 3：编写最少实现**

```ts
import type { L1Record } from '../agent/memoryExtraction';

export const L2_DELAY_MS = 10_000;
export const L2_MIN_INTERVAL_MS = 900_000;
export const LAYER_SCENE_KIND = 'memory_scene';
export const MAX_PENDING_LAYER_MEMORIES = 200;

export function computeFireAt(now: number, lastFiredAt: number, delayMs: number, minIntervalMs: number): number {
  const delayed = now + delayMs;
  if (lastFiredAt <= 0) return delayed;
  return Math.max(delayed, lastFiredAt + minIntervalMs);
}

export function mergeLayerMemories(existing: L1Record[], incoming: L1Record[]): L1Record[] {
  const merged = [...existing];
  const seen = new Set(existing.map(memoryKey));
  for (const record of incoming) {
    const key = memoryKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(record);
  }
  return merged.length <= MAX_PENDING_LAYER_MEMORIES
    ? merged
    : merged.slice(merged.length - MAX_PENDING_LAYER_MEMORIES);
}

function memoryKey(record: L1Record): string {
  return `${record.content}\0${record.type}\0${record.scene_name}`;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：同上。预期：PASS

- [ ] **步骤 5：Commit**（仅当用户要求提交）

```bash
git add electron-agent/electron/app/memoryLayerSchedule.ts electron-agent/electron/app/memoryLayerSchedule.test.ts
git commit -m "feat(memory): add L2 fire-at and pending memory merge"
```

---

## 任务 2：日程表 CRUD

**文件：**
- 修改：`electron-agent/electron/app/memoryLayerSchedule.ts`
- 修改：`electron-agent/electron/app/memoryLayerSchedule.test.ts`
- 修改：`electron-agent/electron/agentData/memoryStore.ts`（构造里 `this.schedules = new LayerScheduleStore(db)` 并 `ensure()`）

- [ ] **步骤 1：编写失败的测试**（追加到 `memoryLayerSchedule.test.ts`）

```ts
import { DatabaseSync } from 'node:sqlite';
import { LayerScheduleStore } from './memoryLayerSchedule';

const scope = { userId: 'u', workspace: '/repo-a', projectId: 'project-A' };
const rec = { content: '先对齐', type: 'work_method' as const, priority: 90, scene_name: 's', source_message_ids: [] as string[], metadata: {} };

describe('LayerScheduleStore', () => {
  it('upsert 等待行，markFired 清 payload 并记下 last_fired_at', () => {
    const db = new DatabaseSync(':memory:');
    const schedules = new LayerScheduleStore(db);
    schedules.ensure();
    schedules.upsertPending({
      userId: 'u',
      kind: 'memory_scene',
      fireAt: 11_000,
      payload: { scope, source: 'session:s1', memories: [rec] },
      now: 1_000,
    });
    expect(schedules.get('u', 'memory_scene')).toMatchObject({
      lastFiredAt: 0,
      fireAt: 11_000,
      payload: { source: 'session:s1', memories: [rec] },
    });
    schedules.markFired('u', 'memory_scene', 11_500);
    expect(schedules.get('u', 'memory_scene')).toMatchObject({
      lastFiredAt: 11_500,
      fireAt: null,
      payload: null,
    });
    db.close();
  });

  it('listPending 只返回仍有 fire_at 的行', () => {
    const db = new DatabaseSync(':memory:');
    const schedules = new LayerScheduleStore(db);
    schedules.ensure();
    schedules.upsertPending({
      userId: 'u', kind: 'memory_scene', fireAt: 5, payload: { scope, source: 's', memories: [rec] }, now: 1,
    });
    schedules.markFired('u', 'memory_scene', 5);
    schedules.upsertPending({
      userId: 'v', kind: 'memory_scene', fireAt: 9, payload: { scope: { ...scope, userId: 'v' }, source: 's', memories: [rec] }, now: 1,
    });
    expect(schedules.listPending().map((row) => row.userId)).toEqual(['v']);
    db.close();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryLayerSchedule.test.ts`

预期：FAIL，`LayerScheduleStore is not exported`

- [ ] **步骤 3：实现 `LayerScheduleStore`**

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryScope } from '../agentData/memoryStore';

export interface LayerSchedulePayload {
  scope: MemoryScope;
  source: string;
  memories: L1Record[];
}

export interface LayerScheduleRow {
  userId: string;
  kind: string;
  lastFiredAt: number;
  fireAt: number | null;
  payload: LayerSchedulePayload | null;
}

export class LayerScheduleStore {
  constructor(private readonly db: DatabaseSync) {}

  ensure(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_layer_schedules (
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      last_fired_at INTEGER NOT NULL DEFAULT 0,
      fire_at INTEGER,
      payload TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind)
    )`);
  }

  get(userId: string, kind: string): LayerScheduleRow | undefined {
    const row = this.db.prepare('SELECT user_id,kind,last_fired_at,fire_at,payload FROM memory_layer_schedules WHERE user_id=? AND kind=?')
      .get(userId, kind) as Record<string, unknown> | undefined;
    return row ? mapSchedule(row) : undefined;
  }

  listPending(): LayerScheduleRow[] {
    const rows = this.db.prepare('SELECT user_id,kind,last_fired_at,fire_at,payload FROM memory_layer_schedules WHERE fire_at IS NOT NULL')
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapSchedule);
  }

  upsertPending(input: { userId: string; kind: string; fireAt: number; payload: LayerSchedulePayload; now: number }): LayerScheduleRow {
    const current = this.get(input.userId, input.kind);
    const payload: LayerSchedulePayload = current?.payload
      ? {
          scope: input.payload.scope,
          source: input.payload.source,
          memories: mergeLayerMemories(current.payload.memories, input.payload.memories),
        }
      : input.payload;
    this.db.prepare(`INSERT INTO memory_layer_schedules(user_id,kind,last_fired_at,fire_at,payload,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,kind) DO UPDATE SET fire_at=excluded.fire_at,payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(input.userId, input.kind, current?.lastFiredAt ?? 0, input.fireAt, JSON.stringify(payload), input.now);
    return this.get(input.userId, input.kind)!;
  }

  markFired(userId: string, kind: string, now: number): void {
    const current = this.get(userId, kind);
    if (!current) {
      this.db.prepare(`INSERT INTO memory_layer_schedules(user_id,kind,last_fired_at,fire_at,payload,updated_at) VALUES(?,?,?,NULL,NULL,?)`)
        .run(userId, kind, now, now);
      return;
    }
    this.db.prepare('UPDATE memory_layer_schedules SET last_fired_at=?,fire_at=NULL,payload=NULL,updated_at=? WHERE user_id=? AND kind=?')
      .run(now, now, userId, kind);
  }
}

function mapSchedule(row: Record<string, unknown>): LayerScheduleRow {
  return {
    userId: String(row.user_id),
    kind: String(row.kind),
    lastFiredAt: Number(row.last_fired_at),
    fireAt: row.fire_at == null ? null : Number(row.fire_at),
    payload: row.payload == null ? null : JSON.parse(String(row.payload)) as LayerSchedulePayload,
  };
}
```

在 `MemoryStore` 构造函数里，`ensureColumn` 之后：

```ts
this.schedules = new LayerScheduleStore(this.db);
this.schedules.ensure();
```

并增加 `readonly schedules: LayerScheduleStore`。从 `../app/memoryLayerSchedule` import。agentData 引用 app 已有先例（runtime 引 MemoryService）。

- [ ] **步骤 4：运行测试验证通过**

运行：同上。预期：PASS。另跑 `npm --prefix electron-agent test -- --run electron/agentData/memoryStore.test.ts`，确认建表不破坏现有 store。

- [ ] **步骤 5：Commit**（仅当用户要求提交）

```bash
git add electron-agent/electron/app/memoryLayerSchedule.ts electron-agent/electron/app/memoryLayerSchedule.test.ts electron-agent/electron/agentData/memoryStore.ts
git commit -m "feat(memory): persist L2 layer schedules"
```

---

## 任务 3：MemoryService 接日程（零延迟保持旧测绿）

**文件：**
- 修改：`electron-agent/electron/app/memoryService.ts`
- 修改：`electron-agent/electron/app/memoryService.test.ts`

- [ ] **步骤 1：先改 `setup()`，再改 `scheduleScene`**

`memoryService.test.ts` 的 `setup()`：

```ts
function setup(layerSchedule: MemoryServiceOptions['layerSchedule'] = { delayMs: 0, minIntervalMs: 0 }) {
  const db = new DatabaseSync(':memory:');
  const store = new MemoryStore(db);
  const tasks: QueueInput[] = [];
  const queue = { enqueue: vi.fn((input: QueueInput) => {
    tasks.push(input);
    return Promise.resolve(taskResult(input));
  }) };
  const service = new MemoryService({ store, queue, layerSchedule });
  return { db, store, tasks, queue, service, layerSchedule };
}
```

所有 `new MemoryService({ store, queue` 的重开实例同样传入 `layerSchedule: { delayMs: 0, minIntervalMs: 0 }`（或 `setup()` 返回值里的 `layerSchedule`）。缺这个，生产默认 10s 会让「立刻入队 memory_scene」断言失败。

需要 `export type { MemoryServiceOptions }`（已是 `export interface MemoryServiceOptions`）。

- [ ] **步骤 2：运行现有 memoryService 测试确认仍绿（尚未改 scheduleScene 时）**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryService.test.ts`

预期：PASS

- [ ] **步骤 3：实现注入与 `scheduleScene`**

`MemoryServiceOptions` 增加：

```ts
export interface LayerScheduleOptions {
  delayMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => { cancel: () => void };
}
export interface MemoryServiceOptions {
  store: MemoryStore;
  queue: MemoryTaskQueue;
  validateProject?: (projectId: string) => Promise<string>;
  extractMode?: 'work' | 'chat';
  layerSchedule?: LayerScheduleOptions;
}
```

类字段：`private readonly timers = new Map<string, { cancel: () => void }>();`

```ts
private now(): number {
  return this.options.layerSchedule?.now?.() ?? Date.now();
}

private delayMs(): number {
  return this.options.layerSchedule?.delayMs ?? L2_DELAY_MS;
}

private minIntervalMs(): number {
  return this.options.layerSchedule?.minIntervalMs ?? L2_MIN_INTERVAL_MS;
}

private immediateLayers(): boolean {
  return this.delayMs() === 0 && this.minIntervalMs() === 0;
}
```

把现有 `scheduleScene` 的 enqueue 抽成 `private enqueueScene(scope, source, l1)`（正文与现在 enqueue 块相同）。

新 `scheduleScene`：

```ts
private scheduleScene(scope: MemoryScope, source: string, l1: L1Record[]): void {
  if (l1.length === 0) return;
  if (this.immediateLayers()) {
    if (this.hasActiveScene(scope.userId)) return;
    this.enqueueScene(scope, source, l1);
    return;
  }
  const row = this.options.store.schedules.get(scope.userId, LAYER_SCENE_KIND);
  const fireAt = computeFireAt(this.now(), row?.lastFiredAt ?? 0, this.delayMs(), this.minIntervalMs());
  try {
    this.options.store.schedules.upsertPending({
      userId: scope.userId,
      kind: LAYER_SCENE_KIND,
      fireAt,
      payload: { scope, source, memories: l1 },
      now: this.now(),
    });
  } catch {
    return;
  }
  this.armSceneTimer(scope.userId, fireAt);
}

private hasActiveScene(userId: string): boolean {
  return Boolean(this.options.queue.findPending?.('memory_scene', (task) => {
    const input = task.input as Record<string, unknown> | undefined;
    return input?.userId === userId;
  }));
}

private armSceneTimer(userId: string, fireAt: number): void {
  this.timers.get(userId)?.cancel();
  const wait = Math.max(0, fireAt - this.now());
  const setTimer = this.options.layerSchedule?.setTimer ?? ((callback, ms) => {
    const handle = setTimeout(callback, ms);
    return { cancel: () => clearTimeout(handle) };
  });
  this.timers.set(userId, setTimer(() => { void this.fireScene(userId); }, wait));
}

private async fireScene(userId: string): Promise<void> {
  this.timers.delete(userId);
  const row = this.options.store.schedules.get(userId, LAYER_SCENE_KIND);
  if (!row?.payload || row.fireAt == null) return;
  if (this.hasActiveScene(userId)) return;
  try {
    this.enqueueScene(row.payload.scope, row.payload.source, row.payload.memories);
    this.options.store.schedules.markFired(userId, LAYER_SCENE_KIND, this.now());
  } catch {
    this.armSceneTimer(userId, this.now() + this.delayMs());
  }
}

recoverLayerSchedules(): void {
  for (const row of this.options.store.schedules.listPending()) {
    if (row.kind !== LAYER_SCENE_KIND || row.fireAt == null) continue;
    this.armSceneTimer(row.userId, row.fireAt);
  }
}

dispose(): void {
  for (const timer of this.timers.values()) timer.cancel();
  this.timers.clear();
}
```

`completeScene` 在成功 `applySceneDecisions` 之后、`schedulePersona` 之前：

```ts
this.options.store.schedules.markFired(pending.scope.userId, LAYER_SCENE_KIND, this.now());
const leftover = this.options.store.schedules.get(pending.scope.userId, LAYER_SCENE_KIND);
```

注意：`fireScene` 已 `markFired` 清掉 payload。若 fire 时先 enqueue 再 markFired，completeScene 再 markFired 只是刷新 `last_fired_at` 为完成时刻（更准）。**不要在 fireScene 里 markFired**，改成：

- `fireScene`：enqueue 成功后 **只清 pending**（把 `fire_at`/`payload` 置空，保留 `last_fired_at`）。
- `completeScene` 成功：`markFired(now)` 写下完成时间。
- 为此给 store 拆两个方法更干净：`clearPending(userId, kind)` 与 `markFired`。

在任务 2 的 store 上补：

```ts
clearPending(userId: string, kind: string, now: number): void {
  this.db.prepare('UPDATE memory_layer_schedules SET fire_at=NULL,payload=NULL,updated_at=? WHERE user_id=? AND kind=?')
    .run(now, userId, kind);
}
```

`fireScene` 成功 enqueue 后 `clearPending`。`completeScene` 成功后 `markFired`。

`completeScene` 末尾：若 `get()` 又有 payload（running 期间新 L1 写入），`armSceneTimer(userId, computeFireAt(...))`。

- [ ] **步骤 4：运行 memoryService 全文件**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryService.test.ts`

预期：PASS（零延迟下仍立刻入队 scene）

- [ ] **步骤 5：Commit**（仅当用户要求提交）

```bash
git add electron-agent/electron/app/memoryService.ts electron-agent/electron/app/memoryService.test.ts electron-agent/electron/app/memoryLayerSchedule.ts electron-agent/electron/app/memoryLayerSchedule.test.ts
git commit -m "feat(memory): schedule L2 scenes instead of enqueueing immediately"
```

---

## 任务 4：假时钟覆盖 debounce 与最小间隔

**文件：**
- 修改：`electron-agent/electron/app/memoryService.test.ts`

- [ ] **步骤 1：编写失败的测试**（若任务 3 的 timer 未接线，这些会红）

在文件末尾 `describe('MemoryService', ...)` 内追加。假时钟：

```ts
function setupClock() {
  let now = 1_000_000;
  const timers: Array<{ at: number; cb: () => void }> = [];
  const base = setup({
    delayMs: 10_000,
    minIntervalMs: 900_000,
    now: () => now,
    setTimer: (cb, ms) => {
      const entry = { at: now + ms, cb };
      timers.push(entry);
      return { cancel: () => {
        const index = timers.indexOf(entry);
        if (index >= 0) timers.splice(index, 1);
      } };
    },
  });
  const advance = async (ms: number) => {
    now += ms;
    const due = timers.filter((timer) => timer.at <= now);
    for (const timer of due) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
      timer.cb();
    }
    await Promise.resolve();
  };
  return { ...base, advance, now: () => now };
}
```

```ts
it('首次 L1 等待 10s 才入队 memory_scene', async () => {
  const { db, tasks, service, advance } = setupClock();
  const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
  service.completeExtraction(captured.taskId!, { l1: [{ content: '团队决定对齐抽取协议', type: 'work_method', priority: 90 }] });
  expect(tasks.map((task) => task.kind)).toEqual(['memory_extract']);
  await advance(9_999);
  expect(tasks.map((task) => task.kind)).toEqual(['memory_extract']);
  await advance(1);
  expect(tasks.map((task) => task.kind)).toEqual(['memory_extract', 'memory_scene']);
  expect((tasks[1].input as { memories: Array<{ content: string }> }).memories).toEqual([
    expect.objectContaining({ content: '团队决定对齐抽取协议' }),
  ]);
  db.close();
});

it('等待中的新 L1 合并并重新计 10s', async () => {
  const { db, tasks, service, advance } = setupClock();
  const first = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
  service.completeExtraction(first.taskId!, { l1: [{ content: '第一条方法', type: 'work_method', priority: 90 }] });
  await advance(5_000);
  const second = await service.capture({ ...scope, source: 'session:s2', transcript: 'user: b', fingerprint: 'fp2' });
  service.completeExtraction(second.taskId!, { l1: [{ content: '第二条任务', type: 'work_task', priority: 80 }] });
  await advance(9_999);
  expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(0);
  await advance(1);
  const scene = tasks.find((task) => task.kind === 'memory_scene');
  expect((scene!.input as { memories: Array<{ content: string }> }).memories.map((row) => row.content)).toEqual([
    '第一条方法',
    '第二条任务',
  ]);
  db.close();
});

it('L2 成功后 15 分钟内不再入队', async () => {
  const { db, tasks, service, advance } = setupClock();
  const first = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
  service.completeExtraction(first.taskId!, { l1: [{ content: '团队决定对齐抽取协议', type: 'work_method', priority: 90 }] });
  await advance(10_000);
  const scene = tasks.find((task) => task.kind === 'memory_scene');
  service.completeScene(scene!.id, {
    scenes: [{ filename: '团队记忆-SOP与禁忌.md', action: 'write', content: '## 核心 SOP\n先对齐' }],
  });
  const second = await service.capture({ ...scope, source: 'session:s2', transcript: 'user: b', fingerprint: 'fp2' });
  service.completeExtraction(second.taskId!, { l1: [{ content: '另一条方法', type: 'work_method', priority: 90 }] });
  await advance(899_999);
  expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
  await advance(1);
  expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(2);
  db.close();
});
```

注意：`setupClock` 里 `capture` 的第二次会再入队 `memory_extract`。scene 计数用 `filter kind === memory_scene`。

若 `setup({...})` 覆盖整个 `layerSchedule` 而丢掉 queue，确认任务 3 的 `setup(layerSchedule?)` 签名一致。

- [ ] **步骤 2：运行确认红或绿**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryService.test.ts`

预期：若任务 3 接线正确则 PASS；否则按失败信息补 `armSceneTimer` / `clearPending`。

- [ ] **步骤 3：Commit**（仅当用户要求提交）

```bash
git add electron-agent/electron/app/memoryService.test.ts
git commit -m "test(memory): cover L2 debounce and min interval"
```

---

## 任务 5：重启恢复与 running 不双入队

**文件：**
- 修改：`electron-agent/electron/app/memoryService.test.ts`

- [ ] **步骤 1：编写测试**

```ts
it('recoverLayerSchedules 在 fire_at 已过时立刻入队', async () => {
  const { db, store, queue, tasks, service, advance } = setupClock();
  const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
  service.completeExtraction(captured.taskId!, { l1: [{ content: '团队决定对齐抽取协议', type: 'work_method', priority: 90 }] });
  service.dispose();
  const reopened = new MemoryService({
    store,
    queue,
    layerSchedule: {
      delayMs: 10_000,
      minIntervalMs: 900_000,
      now: () => 1_000_000 + 11_000,
      setTimer: (cb, ms) => {
        if (ms <= 0) cb();
        return { cancel: () => {} };
      },
    },
  });
  reopened.recoverLayerSchedules();
  await Promise.resolve();
  expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
  reopened.dispose();
  db.close();
});
```

`setupClock` 必须把 `now` 的闭包与 `queue` 一起返回。上面 `now: () => 1_000_000 + 11_000` 假定起始 `now=1_000_000` 且 delay 10s，日程 `fireAt=1_010_000`，恢复时 1_011_000 已到期。

更稳：`setupClock` 返回 `getNow`，恢复用 `getNow()`。

```ts
it('已有 queued scene 时新 L1 只更新日程', async () => {
  const { db, tasks, queue, service } = setup({ delayMs: 0, minIntervalMs: 0 });
  queue.findPending = vi.fn((kind, matches) => {
    const task = tasks.map((item) => taskResult(item)).find((item) => item.kind === kind && matches(item));
    return task;
  });
  const first = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
  service.completeExtraction(first.taskId!, { l1: [{ content: '第一条方法', type: 'work_method', priority: 90 }] });
  expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
  const second = await service.capture({ ...scope, source: 'session:s2', transcript: 'user: b', fingerprint: 'fp2' });
  service.completeExtraction(second.taskId!, { l1: [{ content: '第二条任务', type: 'work_task', priority: 80 }] });
  expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
  db.close();
});
```

零延迟 + `hasActiveScene`：第一次 enqueue 后 `tasks` 里已有 scene，`findPending` 能找到，第二次不入队。日程在零延迟路径**不写 waiting 行**（规格：0/0 直接 enqueue）。因此「只更新日程」这条在 0/0 下退化成「不入第二队」。

补一条非零延迟：scene running 期间（手动 `findPending` 返回已入队的 scene）再 completeExtraction，`listPending()` 仍有 payload。需要 `setupClock` + 推进到入队之后、completeScene 之前再来一条 L1。

```ts
it('scene 未完成时到来的 L1 写入日程，完成后按最小间隔再跑', async () => {
  const { db, tasks, queue, service, advance } = setupClock();
  queue.findPending = vi.fn((kind, matches) => {
    return tasks.map((item) => taskResult(item, kind === 'memory_scene' ? 'running' : 'queued'))
      .find((item) => item.kind === kind && matches(item));
  });
  const first = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
  service.completeExtraction(first.taskId!, { l1: [{ content: '第一条方法', type: 'work_method', priority: 90 }] });
  await advance(10_000);
  expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
  const second = await service.capture({ ...scope, source: 'session:s2', transcript: 'user: b', fingerprint: 'fp2' });
  service.completeExtraction(second.taskId!, { l1: [{ content: '第二条任务', type: 'work_task', priority: 80 }] });
  expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
  const scene = tasks.find((task) => task.kind === 'memory_scene');
  service.completeScene(scene!.id, {
    scenes: [{ filename: '团队记忆-SOP与禁忌.md', action: 'write', content: '## 核心 SOP\nv1' }],
  });
  await advance(899_999);
  expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(1);
  await advance(1);
  expect(tasks.filter((task) => task.kind === 'memory_scene')).toHaveLength(2);
  const secondScene = tasks.filter((task) => task.kind === 'memory_scene')[1];
  expect((secondScene.input as { memories: Array<{ content: string }> }).memories.map((row) => row.content)).toContain('第二条任务');
  db.close();
});
```

实现要点：`fireScene` 若 `hasActiveScene` 则 **不要** `clearPending`，保留 payload。`completeScene` 的 `markFired` 会清 payload——**冲突**。

规格第 7 节：running 时 upsert 日程；完成后再算 `fire_at`。因此 `completeScene` **不能**对仍有新 payload 的行调用会清空 payload 的 `markFired`。

订正 `completeScene`：

```ts
const pendingSchedule = this.options.store.schedules.get(pending.scope.userId, LAYER_SCENE_KIND);
this.options.store.schedules.markFired(pending.scope.userId, LAYER_SCENE_KIND, this.now());
if (pendingSchedule?.payload && pendingSchedule.fireAt != null) {
  const fireAt = computeFireAt(this.now(), this.now(), this.delayMs(), this.minIntervalMs());
  this.options.store.schedules.upsertPending({
    userId: pending.scope.userId,
    kind: LAYER_SCENE_KIND,
    fireAt,
    payload: pendingSchedule.payload,
    now: this.now(),
  });
  this.armSceneTimer(pending.scope.userId, fireAt);
}
```

`markFired` 会清空；随即用完成前快照的 payload 再 upsert。`lastFiredAt` 已是完成时刻，新 `fireAt = now + 900s`（delay 10s 被间隔盖住）。`computeFireAt(now, now, 10_000, 900_000) = now+900_000`。对。

- [ ] **步骤 2：跑测**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryService.test.ts`

预期：PASS

- [ ] **步骤 3：Commit**（仅当用户要求提交）

```bash
git add electron-agent/electron/app/memoryService.ts electron-agent/electron/app/memoryService.test.ts
git commit -m "feat(memory): recover L2 schedules and coalesce while scene runs"
```

---

## 任务 6：Runtime 恢复、dispose、集成零延迟

**文件：**
- 修改：`electron-agent/electron/agentData/runtime.ts`
- 修改：`electron-agent/electron/agentData/extensionIntegration.test.ts`

- [ ] **步骤 1：给 Runtime 增加选项并接线**

`AgentDataRuntimeOptions`：

```ts
layerSchedule?: import('../app/memoryService').LayerScheduleOptions;
```

两处 `new MemoryService({...})` 都传入 `layerSchedule: this.options.layerSchedule`。创建后立刻 `this.memoryService.recoverLayerSchedules()`。

`close()` 开头：`this.memoryService?.dispose()`。

`extensionIntegration.test.ts` 的 `fixture()`：

```ts
const runtime = new AgentDataRuntime({
  dataPath: join(directory, 'agent-data.db'),
  methods: { 'permission.authorize': ... },
  executeServiceTask: async (task) => { ... },
  layerSchedule: { delayMs: 0, minIntervalMs: 0 },
});
```

其他 runtime 测试不强制改。`close`→`dispose` 会取消默认 10s timer，避免悬挂句柄。它们只断言 L1，不依赖立刻 L2。

- [ ] **步骤 2：跑集成与 runtime**

```
npm --prefix electron-agent test -- --run electron/agentData/extensionIntegration.test.ts electron/agentData/runtime.test.ts electron/agentData/runtime.extensions.test.ts electron/app/agentDataService.test.ts electron/app/memoryService.test.ts electron/app/memoryLayerSchedule.test.ts
```

预期：PASS

- [ ] **步骤 3：Commit**（仅当用户要求提交）

```bash
git add electron-agent/electron/agentData/runtime.ts electron-agent/electron/agentData/extensionIntegration.test.ts
git commit -m "feat(memory): recover L2 timers on runtime start"
```

---

## 任务 7：回归

- [ ] **步骤 1：跑记忆相关测试**

```
npm --prefix electron-agent test -- --run electron/app/memoryService.test.ts electron/app/memoryLayers.test.ts electron/app/memoryLayerSchedule.test.ts electron/app/memoryDedup.test.ts electron/agent/memoryExtraction.test.ts electron/agent/memoryPrompts.test.ts electron/agent/memoryLayerPrompts.test.ts electron/pi/systemWorkerManager.test.ts electron/app/appServer/serviceTaskRegistry.test.ts electron/agentData/runtime.test.ts electron/agentData/runtime.extensions.test.ts electron/agentData/runtime.memoryManagement.test.ts electron/app/agentDataService.test.ts electron/agentData/extensionIntegration.test.ts
```

在 `extensions/`：`npx vitest run memory`

预期：全部 PASS。无新增 `TODO`/`待定`。

- [ ] **步骤 2：Commit**（仅当用户要求提交）

```bash
git commit --allow-empty -m "test(memory): L2 throttle regression green"
```

---

## 自检

**规格覆盖：** 10s/900s 到期公式 → 任务 1；合并与 200 上限 → 任务 1；表与 last_fired_at → 任务 2；debounce 入队 → 任务 3–4；running 不双入队、完成后重算 → 任务 5；落盘恢复 → 任务 5–6；0/0 测试快捷路径 → 任务 3；enqueue 失败重挂 → 任务 3 `fireScene` catch；L1 不回滚 → 任务 3 upsert catch return；不改 TaskQueue → 文件结构；L3 仍绑 completeScene → 不改 `schedulePersona` 条件。

**占位符：** 无「待定 / TODO / 类似任务 N」。

**类型名：** `LayerScheduleStore`、`computeFireAt`、`mergeLayerMemories`、`LAYER_SCENE_KIND`、`recoverLayerSchedules`、`dispose`、`clearPending`、`markFired` 前后一致。

**任务 5 对 markFired 的订正：** 完成时先快照 payload 再 markFired 再 upsert，避免清掉 running 期间合并的 L1。
