# DSH 子代理第八期：通用 jobs 服务与结构化输出

- 日期：2026-09-14
- 状态：待审查
- 主题：对齐 DSH `dsh-jobs` / `dsh-tool-jobs`：进程内通用后台 job 注册表 + `job_output` / `job_list` / `job_kill` + 结算 notice；`spawn_agent` 的 one-shot 后台作为首个生产者接入；`executeSubagent` 程序接口增加 `outputSchema` 结构化输出（不暴露给父模型）。
- 依赖：[规格 2](./2026-09-13-dsh-subagent-continuable-notice-design.md)（continuable 路径不变、子进程 notice 归属调整）、[规格 5](./2026-09-14-dsh-subagent-delegation-scope-design.md)（声明拼接顺序）、[规格 7](./2026-09-14-dsh-subagent-nested-delegation-design.md)（子级结算须等活 job）
- 关联：新 `extensions/jobs/`、`extensions/multi-agent/index.ts`、`embedded-runner.ts`、`activation.ts`、`electron-agent/src/features/chat/ChatMessageItems.tsx`
- DSH 参照：`packages/jobs/jobs/src/types.ts`、`packages/jobs/tool-jobs/src/index.ts`、`packages/subagent/subagent-in-process-driver/src/structured.ts`

---

## 1. 问题

现状（2026-09-14 核对）：

- Pi 没有 jobs 概念。`spawn_agent` 的 `wait` / `status` / `cancel` / `list` 是一套子代理专用的后台面。
- 规格 2 把 embedded `action: "spawn"` 整个改成可续聊 Activation，没有「后台跑完即散、结果用 wait 收」的 one-shot 后台；子进程回退路径有，但 notice 由 multi-agent 自己发。
- 没有结构化输出：程序调用方只能拿子级最后一条 assistant 正文。

DSH：jobs 是通用服务，生产者有 `bash` / `pwsh` / `terminal` / `subagent`；`job_output` 对流式 job 返回增量、对终值 job 返回终值；结算发 notice（忙则 steer 注入、闲则唤醒，连续唤醒有预算）。`outputSchema` 只在服务 API 上（`SubagentStartRequest`），模型面工具不暴露；子级拿到作用域内 `structured_output` 工具 + 尾部指令。

## 2. 目标与成功标准

1. 任一会话可 `spawn_agent({ action: "spawn", mode: "one-shot" })` 得到 `jobId`，`job_output({ job_id, wait: true })` 收到最终正文；job 结算时父会话收到 `job-done` notice。
2. `job_list` 只列自己的 job；他人 `job_output` / `job_kill` 报错。
3. `mode` 缺省仍是可续聊（规格 2 行为零变化）。
4. 程序调用 `executeSubagent(..., { outputSchema })`（embedded）→ 子级看到 `structured_output` 工具，调用后 `result.structured` 为校验过的值。
5. `bash` 后台化下一期只需新增生产者，不改服务与工具。

**范围**：新扩展 `extensions/jobs` + `multi-agent` 生产者接入 + Electron notice 渲染 + `executeSubagent` 接口。

## 3. 方案取舍（已锁定）

| 方案 | 做法 | 结论 |
|---|---|---|
| **1. 新扩展 `extensions/jobs`，进程内单例，subagent 首个生产者（采用）** | 服务 + 三工具 + notice；jobs 不落盘，subagent 生产者仍写 registry.db 供重启 reap | 生产者 / 消费者分离；bash 后台化只加生产者 |
| 2. jobs 做进 `multi-agent` | 少一个目录 | bash 要反向依赖 multi-agent，边界错 |
| 3. jobs 落 SQLite | 重启后可见 | `done` promise 随进程消失，只能显示未知；DSH 不持久化 |
| D-a. `outputSchema` 只做程序接口（采用） | 与 DSH 一致 | — |
| D-b. `spawn_agent` 暴露 `output_schema` | 父模型可要求 schema | 超出 DSH；本期不做 |

## 4. 设计 C：jobs 服务（`extensions/jobs/`）

加进 `extensions/package.json` `pi.extensions` 与 `embedded-runner.ts` `CORE_ALWAYS_ON`（子级也要能用 `job_output`）。

### 4.1 模块

| 文件 | 职责 |
|---|---|
| `types.ts` | 见 §4.2 |
| `service.ts` | `JobsService` 进程内单例：`start`、`read`、`list`、`kill`、`hasLive(owner)`、`onJobDone`、`attachOwner` / `detachOwner` |
| `notice.ts` | `formatJobNotice(snapshot, limitBytes)` |
| `index.ts` | 注册三工具；`session_start` attach owner；`session_shutdown` detach；`input` 事件重置唤醒计数；`promptGuidelines` |

### 4.2 类型

```ts
export type JobKind = "subagent"; // 后续生产者用声明合并扩展
export type JobStatus = "running" | "stopping" | "completed" | "failed" | "killed";

export interface JobStart {
  kind: JobKind;
  label: string;              // 一行，模型可见
  owner: string;              // 启动方 sessionId
  workspace: string;
  outputLimitBytes?: number;  // notice / 单次读的 UTF-8 上限，默认 16 KiB
  run(): JobHooks;            // 同步返回；抛错则什么都不登记
}

export interface JobHooks {
  cancel(reason?: string): void;        // 同步、幂等，最终使 done 结算
  done: Promise<JobOutcome>;            // 不 reject；reject 视为 failed
  readOutput?(): string;                // 流式 kind 才有；缺省为终值 job
}

export interface JobOutcome { status: "completed" | "failed" | "killed"; output?: string; error?: string }

export interface JobSnapshot {
  id: string; kind: JobKind; label: string; owner: string; workspace: string;
  status: JobStatus; startedAt: number; finishedAt?: number;
  output?: string; error?: string; reported: boolean;
}
```

`id` = `<kind>-<N>`，N 进程内递增。

### 4.3 服务语义

- `start(req)`：`run()` 抛错 → 不登记、原样抛。`done` 结算后写 snapshot 终态并触发 `onJobDone`。
- `read(id, caller, { wait?, timeoutMs? })`：`caller !== owner` → `JobsError("NOT_OWNER")`。终值 job：未完成返回 `{ status: "running", text: "" }`；`wait` 阻塞到终态或超时（默认 `JOBS_WAIT_TIMEOUT_MS` = 60000，上限 `JOBS_WAIT_MAX_MS` = 600000），超时返回 running 且 job 仍活；终态返回输出并标 `reported: true`。流式 job：返回 `readOutput()` 增量（本期无生产者，接口保留）。
- `list(caller)`：只返回 `owner === caller` 的 snapshot。
- `kill(id, caller, reason?)`：围栏同 read；活 → 状态置 `stopping`、调 `hooks.cancel(reason)`，返回 `"requested"`；已终 → `"already-finished"`。
- `hasLive(owner)`：该 owner 有 `running` / `stopping` job。
- `attachOwner(sessionId, { sendMessage, isIdle })` / `detachOwner(sessionId)`：detach 时对该 owner 全部活 job `cancel("owner disposed")` 并 `await done`。

### 4.4 工具

- `job_output({ job_id, wait?: boolean, timeout_ms?: number })` → 文本 `[status: <s>]` + 换行 + 输出（running 时无输出）。
- `job_list()` → 表：`id | kind | label | status | startedAt | finishedAt`。
- `job_kill({ job_id, reason? })` → `cancellation requested for job <id>` / `job <id> had already finished [status: <s>]`。
- 调用方 sessionId 取 `ctx.sessionManager.getSessionId()`。围栏失败 → `isError`：`job <id> 不属于当前会话`。

`promptGuidelines`（对齐 DSH `tool:jobs` 段）：记住每个启动的 job id；结算时会收到 notice，不要忙等或 sleep；收尾前用 `job_output` 收齐仍相关的 job（只在真正被阻塞时 `wait: true`）；不再重要的 `job_kill`。

### 4.5 结算 notice

`onJobDone(snapshot)`：

- owner 未 attach → 丢弃（`reported` 保持 false，后续 `job_output` 读到时置 true）。
- `formatJobNotice`：首行 `Background job <id> (<kind>: <label>) finished <status>.`；终值 job 附输出，超 `outputLimitBytes` 截断并加 `\n[notice truncated]`；流式 job 不附。
- owner 忙（`!isIdle()`）→ `sendMessage({ customType: "job-done", content, display: true, details: { jobId, kind, status } }, { triggerTurn: false, deliverAs: "steer" })`。
- owner 闲且 `wakes[owner] < JOBS_WAKE_BUDGET`（默认 3）→ `{ triggerTurn: true, deliverAs: "followUp" }`，`wakes[owner]++`；否则 `{ triggerTurn: false }`（只写不唤醒）。
- `input` 事件（用户输入）→ `wakes[owner] = 0`。

Electron：`ChatMessageItems.tsx` `case 'notice'` 加 `msg.customType === 'job-done'` → `JobDonePill`（复用 `SubagentSettledPill` 样式：标题首行，展开看输出）。主 store type 白名单不改（父会话自己的 `custom_message`）。

## 5. 设计 C：subagent 生产者（`extensions/multi-agent/index.ts`）

`spawn_agent` 参数新增：

```
mode?: "one-shot" | "continuable"   // 仅 action: "spawn" 有意义；默认 "continuable"
```

**`action: "spawn", mode: "one-shot"`**

- embedded：
  ```ts
  const jobId = jobs.start({
    kind: "subagent", label: catalogLabel(task), owner: parentSid, workspace,
    run: () => {
      const controller = new AbortController();
      const done = executeSubagent(ctx.cwd, task, id, profile, { ...opts, signal: controller.signal })
        .then(r => ({ status: mapStop(r.stopReason), output: r.output, error: r.error }))
        .catch(e => ({ status: "failed", error: String(e) }));
      return { cancel: () => controller.abort(), done };
    },
  });
  ```
  `mapStop`：`completed → completed`、`aborted → killed`、`error → failed`。跑完 dispose（one-shot 语义）。同时照旧 `registry.create` / `finish`（重启 reap、右坞列表不变）+ 父目录事实 `mode: "one-shot"`。
- 子进程回退：同一 `jobs.start` 包现有 detached `executeSubagent`；规格 2 §8.4 的子进程退出 `subagent-settled` notice **删除**，改由 `job-done` 统一承担。`subagent-settled` 只留给 continuable。
- 返回：`Background one-shot sub-agent started as job <jobId>. Collect with job_output({ job_id: "<jobId>" }).`，`details: { agentId, jobId, sessionPath?, mode: "one-shot" }`。
- `inflight` 仍登记（UI 取消 / reapStuck 路径不变）。

**别名**：`spawn_agent({ action: "wait" | "status" | "cancel", agentId })` 保留；registry 行加 `jobId TEXT NULL`，别名按 `agentId → jobId` 转调 `jobs.read` / `jobs.kill`（无 `jobId` 的旧行仍走 registry 轮询）。描述标「等价于 `job_output` / `job_kill`」。

**不变**：`mode: "continuable"` 路径；`tasks` / `chain` / worktree 不支持后台。

**嵌套（规格 7）**：子级里的 one-shot job owner 是子级 sessionId，notice 落子级 JSONL（子级扩展实例 attach 的 `pi`）。one-shot job 不进 `ownedChildren`；`activation.ts` `watchSettlement` 在 `act.inbox.hasPending || act.ownedChildren.size > 0` 同位加 `jobs.hasLive(act.childId)`，子级有活 job 不结算。job 结算 → `poke` 该 Activation（`onJobDone` 里按 owner 查 `getActivation`）。

## 6. 设计 D：结构化输出（程序接口）

`executeSubagent(..., opts)` 增加 `outputSchema?: TObject`（typebox 对象 schema）；`SubagentRunResult` 增加 `structured?: unknown`。

- 仅 embedded。子进程路径收到 `outputSchema` → 抛 `Error("outputSchema 需要 Electron 进程内子会话")`。
- embedded（`embedded-runner.ts`）：`extensionFactories` 末尾追加**每子级一份**的 factory 闭包：
  ```ts
  (pi) => pi.registerTool({
    name: "structured_output",
    description: "Deliver your final result. Call exactly once with arguments matching the schema.",
    parameters: outputSchema,
    execute: async (_id, params) => { captured = { value: params }; return { content: [{ type: "text", text: captured had value before ? "结果已替换先前记录" : "结果已记录" }] }; },
  })
  ```
  校验由 pi 工具层按 `parameters` 做；不通过的调用不会到 `execute`。
- 尾部指令拼进 `systemPrompt`，顺序：named agent 提示 → 规格 5 声明 → `得出最终答案后，必须调用 structured_output 工具、参数严格符合其 schema 来交付结果。不要以纯文本收尾：只有这次工具调用算作你的结果。`
- `structured_output` 不在子级 `excludeTools` 内；父级看不到（factory 只挂到子 services）。
- 结算后：`captured` 有值 → `structured = captured.value`；无值 → 省略，`stopReason` 不变（不升级为 error，由调用方决定）。
- 本期无调用方（`im-platforms` 走子进程）。这是给 goal / 自定义扩展的接口；`spawn_agent` 不暴露。

## 7. 错误

| 情况 | 结果 |
|---|---|
| `job_output` / `job_kill` 非 owner | `isError`：`job <id> 不属于当前会话` |
| 未知 `job_id` | `isError`：`job <id> 不存在（jobs 不跨进程保留）` |
| `wait` 超时 | `[status: running]`，job 仍活 |
| `run()` 抛错 | `spawn_agent` `isError`，registry 行 `error`，不登记 job |
| owner 会话 dispose | 活 job `cancel("owner disposed")`，`await done`，不发 notice |
| `mode: "one-shot"` + `tasks` / `chain` / worktree | `isError`（现有拒绝文案） |
| `outputSchema` + 子进程 | 抛错，不启动 |
| `structured_output` 参数不合 schema | pi 工具层校验失败，子模型收到校验错误重试 |

## 8. 明确不做

- jobs 持久化 / 跨进程
- `bash` / `pwsh` 流式生产者（接口留好，下一份规格）
- `spawn_agent` 的 `output_schema` 参数
- jobs 专用 UI 面板（右坞 registry 托盘已覆盖 subagent kind）
- 流式 job 的 spill 文件
- `JOBS_WAKE_BUDGET` 之外的投递策略
- `structured_output` 在子进程路径

## 9. 测试

**`jobs/service.test.ts`**
- id 递增 `subagent-1` / `subagent-2`；`run()` 抛错不登记
- 他人 `read` / `kill` → `NOT_OWNER`；`list` 只见自己
- 终值 job：running 时空输出；`wait` 超时返回 running 且 job 活；结算后返回输出并 `reported: true`
- `kill` 活 → `requested` 且 `cancel(reason)` 被调；已终 → `already-finished`
- `detachOwner` 取消并等待全部活 job；`hasLive` 两态

**`jobs/notice.test.ts`**：三种 status 首行；截断标记；流式不附输出

**`jobs/index.test.ts`**：忙 → steer 不 triggerTurn；闲 → triggerTurn，第 4 次不唤醒；`input` 后重置；owner 未 attach 不发；`job-done` details 含 jobId/kind/status

**`multi-agent/index.test.ts`**
- `mode: "one-shot"` embedded：`jobs.start` 被调、registry 行含 `jobId`、目录 `mode: "one-shot"`、跑完 dispose、无 `subagent-settled`
- `mode` 缺省 → continuable 路径（`installActivation` 被调、`jobs.start` 未调）
- 子进程后台经 `jobs.start`，不再直接发 settled
- `wait` 别名对有 `jobId` 的行转调 `jobs.read`；旧行仍轮询 registry

**`activation.test.ts`**：子级有活 one-shot job 时不结算；job 结算 poke 后结算

**`embedded-runner.test.ts`**
- `outputSchema` → 子 services 的 factories 多一个，注册工具名 `structured_output`、`parameters` 即 schema
- 子级调用一次 → `structured` 回传；两次 → 后者覆盖；未调用 → 省略且 `stopReason` 不变
- 系统提示顺序：agent → 声明 → 结构化指令
- 子进程路径 + `outputSchema` → 抛错

**`registry.test.ts`**：旧库无 `jobId` 列迁移

**Electron**：`job-done` notice 渲染 `JobDonePill`，标题为首行
