# DSH 子代理第八期：通用 jobs 服务与结构化输出 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 新扩展 `extensions/jobs` 提供进程内 job 注册表 + `job_output` / `job_list` / `job_kill` + 结算 notice（忙 steer / 闲唤醒、唤醒预算）；`spawn_agent({ action: "spawn", mode: "one-shot" })` 作为首个生产者接进 jobs；`executeSubagent` 程序接口加 `outputSchema`，子级得到作用域内 `structured_output` 工具，结果回传 `structured`。

**架构：** `jobs/service.ts` 单例（owner 围栏、wait、kill、hasLive、onJobDone、attach/detach owner）；`jobs/index.ts` 注册三工具、`session_start` attach、`input` 重置唤醒计数、`onJobDone` 投递 `job-done` `custom_message`。`multi-agent/index.ts` 的后台 one-shot 分支改为 `jobs.start(...)` 包 `executeSubagent`；registry 加 `jobId` 列；`wait` / `status` / `cancel` 对有 `jobId` 的行转调 jobs。`activation.ts` `watchSettlement` 加 `jobs.hasLive(childId)`。`embedded-runner.ts` 在 `outputSchema` 存在时追加一个每子级一份的 factory 注册 `structured_output`。

**技术栈：** TypeScript、typebox、vitest、React。

**规格：** `docs/superpowers/specs/2026-09-14-dsh-subagent-jobs-structured-output-design.md`

**前置：** 第五、六、七期已落地（`executeSubagent` 含 `withDelegationScope`；`watchSettlement` 已有 `ownedChildren` 分支；registry 已有��移块）。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `extensions/jobs/types.ts` | 创建 | `JobKind`、`JobStatus`、`JobStart`、`JobHooks`、`JobOutcome`、`JobSnapshot`、`JobsError` |
| `extensions/jobs/service.ts` | 创建 | `JobsService` + 单例 `jobs` + `__resetJobsForTest` |
| `extensions/jobs/service.test.ts` | 创建 | 围栏 / wait / kill / detach / hasLive |
| `extensions/jobs/notice.ts` | 创建 | `formatJobNotice` |
| `extensions/jobs/notice.test.ts` | 创建 | 句式 / 截断 |
| `extensions/jobs/index.ts` | 创建 | 三工具 + owner attach + notice 投递 |
| `extensions/jobs/index.test.ts` | 创建 | 投递策略 / 围栏文案 |
| `extensions/index.ts` | 修改 | 注册 `jobs` 扩展（在 `multi-agent` 之前） |
| `extensions/multi-agent/embedded-runner.ts` | 修改 | `CORE_ALWAYS_ON` 加 `jobs`；`outputSchema` factory；`EmbeddedSubagentResult.structured` |
| `extensions/multi-agent/embedded-runner.run.test.ts` | 修改 | 结构化用例 |
| `extensions/multi-agent/index.ts` | 修改 | `mode` 参数；one-shot 后台经 jobs；别名转调；`outputSchema` 透传 |
| `extensions/multi-agent/index.test.ts` | 修改 | one-shot job 用例 |
| `extensions/multi-agent/registry.ts` | 修改 | `jobId` 列 |
| `extensions/multi-agent/registry.test.ts` | 修改 | 迁移用例 |
| `extensions/multi-agent/activation.ts` | 修改 | `hasLive` 检查 + job 结算 poke |
| `extensions/multi-agent/activation.test.ts` | 修改 | 活 job 不结算 |
| `extensions/multi-agent/structured-output.ts` | 创建 | `STRUCTURED_OUTPUT_TOOL`、`createStructuredCapture`、`withStructuredInstruction` |
| `extensions/multi-agent/runner.ts` | 修改 | `outputSchema` → 抛错 |
| `electron-agent/src/features/chat/JobDonePill.tsx` | 创建 | notice 渲染 |
| `electron-agent/src/features/chat/ChatMessageItems.tsx` | 修改 | `job-done` 分支 |
| `electron-agent/src/features/chat/ChatMessageItems.test.tsx`（或已有 notice 测试文件） | 修改 | 渲染用例 |

---

### 任务 1：jobs 类型与服务

**文件：**
- 创建：`extensions/jobs/types.ts`
- 创建：`extensions/jobs/service.ts`
- 创建：`extensions/jobs/service.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
// extensions/jobs/service.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobsError } from "./types.js";
import { jobs, __resetJobsForTest } from "./service.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function startJob(over: { owner?: string; cancel?: () => void; readOutput?: () => string } = {}) {
  const d = deferred<{ status: "completed" | "failed" | "killed"; output?: string; error?: string }>();
  const cancel = over.cancel ?? vi.fn();
  const id = jobs.start({
    kind: "subagent",
    label: "do x",
    owner: over.owner ?? "s1",
    workspace: "/ws",
    run: () => ({ cancel, done: d.promise, ...(over.readOutput ? { readOutput: over.readOutput } : {}) }),
  });
  return { id, done: d, cancel };
}

beforeEach(() => __resetJobsForTest());

describe("JobsService", () => {
  it("ids are <kind>-N and increment", () => {
    expect(startJob().id).toBe("subagent-1");
    expect(startJob().id).toBe("subagent-2");
  });

  it("run() throwing registers nothing and rethrows", () => {
    expect(() => jobs.start({ kind: "subagent", label: "x", owner: "s1", workspace: "/ws", run: () => { throw new Error("boom"); } })).toThrow("boom");
    expect(jobs.list("s1")).toEqual([]);
  });

  it("read / kill by a non-owner throw NOT_OWNER; list only shows own jobs", async () => {
    const { id } = startJob({ owner: "s1" });
    await expect(jobs.read(id, "s2")).rejects.toMatchObject({ code: "NOT_OWNER" });
    expect(() => jobs.kill(id, "s2")).toThrow(JobsError);
    expect(jobs.list("s2")).toEqual([]);
    expect(jobs.list("s1").map((j) => j.id)).toEqual([id]);
  });

  it("unknown id throws NOT_FOUND", async () => {
    await expect(jobs.read("subagent-99", "s1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("final-output job: running → empty; wait times out leaving the job alive; settled → output + reported", async () => {
    const { id, done } = startJob();
    expect(await jobs.read(id, "s1")).toEqual({ status: "running", text: "" });
    expect(await jobs.read(id, "s1", { wait: true, timeoutMs: 10 })).toEqual({ status: "running", text: "" });
    expect(jobs.hasLive("s1")).toBe(true);
    done.resolve({ status: "completed", output: "answer" });
    const r = await jobs.read(id, "s1", { wait: true, timeoutMs: 1000 });
    expect(r).toEqual({ status: "completed", text: "answer" });
    expect(jobs.snapshot(id)?.reported).toBe(true);
    expect(jobs.hasLive("s1")).toBe(false);
  });

  it("stream job returns readOutput delta", async () => {
    let n = 0;
    const { id } = startJob({ readOutput: () => `chunk${++n}` });
    expect(await jobs.read(id, "s1")).toEqual({ status: "running", text: "chunk1" });
    expect(await jobs.read(id, "s1")).toEqual({ status: "running", text: "chunk2" });
  });

  it("kill: live → requested + cancel(reason) + stopping; finished → already-finished", async () => {
    const { id, done, cancel } = startJob();
    expect(jobs.kill(id, "s1", "why")).toBe("requested");
    expect(cancel).toHaveBeenCalledWith("why");
    expect(jobs.snapshot(id)?.status).toBe("stopping");
    done.resolve({ status: "killed" });
    await jobs.read(id, "s1", { wait: true, timeoutMs: 100 });
    expect(jobs.kill(id, "s1")).toBe("already-finished");
  });

  it("rejected done becomes failed", async () => {
    const id = jobs.start({ kind: "subagent", label: "x", owner: "s1", workspace: "/ws", run: () => ({ cancel: () => {}, done: Promise.reject(new Error("bad")) }) });
    const r = await jobs.read(id, "s1", { wait: true, timeoutMs: 100 });
    expect(r.status).toBe("failed");
    expect(jobs.snapshot(id)?.error).toBe("bad");
  });

  it("onJobDone fires once per settled job with the snapshot", async () => {
    const seen: string[] = [];
    jobs.onJobDone((s) => seen.push(`${s.id}:${s.status}`));
    const { id, done } = startJob();
    done.resolve({ status: "completed", output: "o" });
    await vi.waitFor(() => expect(seen).toEqual([`${id}:completed`]));
  });

  it("detachOwner cancels and awaits every live job of that owner", async () => {
    const a = startJob({ owner: "s1" });
    const b = startJob({ owner: "s2" });
    a.done.resolve({ status: "killed" });
    await jobs.detachOwner("s1");
    expect(a.cancel).toHaveBeenCalledWith("owner disposed");
    expect(b.cancel).not.toHaveBeenCalled();
    expect(jobs.hasLive("s1")).toBe(false);
    expect(jobs.hasLive("s2")).toBe(true);
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run jobs/service --reporter=dot`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现（types.ts）**

```ts
// extensions/jobs/types.ts
export type JobKind = "subagent";
export type JobStatus = "running" | "stopping" | "completed" | "failed" | "killed";
export type JobTerminalStatus = Extract<JobStatus, "completed" | "failed" | "killed">;

export interface JobOutcome {
  status: JobTerminalStatus;
  output?: string;
  error?: string;
}

export interface JobHooks {
  /** 同步、幂等；最终使 done 结算。 */
  cancel(reason?: string): void;
  /** 不应 reject；reject 视为 failed。 */
  done: Promise<JobOutcome>;
  /** 流式 kind 才有；缺省为终值 job。 */
  readOutput?(): string;
}

export interface JobStart {
  kind: JobKind;
  label: string;
  owner: string;
  workspace: string;
  outputLimitBytes?: number;
  run(): JobHooks;
}

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  label: string;
  owner: string;
  workspace: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  reported: boolean;
  outputLimitBytes: number;
  stream: boolean;
}

export type JobsErrorCode = "NOT_OWNER" | "NOT_FOUND";

export class JobsError extends Error {
  constructor(message: string, public readonly code: JobsErrorCode) {
    super(message);
    this.name = "JobsError";
  }
}

export const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024;
```

- [ ] **步骤 4：实现（service.ts）**

```ts
// extensions/jobs/service.ts
// 进程内 job 注册表：不落盘，随 sidecar 进程生灭。owner 用 sessionId 围栏。
import {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  JobsError,
  type JobHooks,
  type JobKind,
  type JobSnapshot,
  type JobStart,
} from "./types.js";

type JobRecord = JobSnapshot & { hooks: JobHooks; waiters: Array<() => void> };

export type JobDoneListener = (snapshot: JobSnapshot) => void;

export interface JobRead {
  status: JobSnapshot["status"];
  text: string;
}

function toSnapshot(r: JobRecord): JobSnapshot {
  const { hooks: _h, waiters: _w, ...rest } = r;
  return { ...rest };
}

export class JobsService {
  private readonly records = new Map<string, JobRecord>();
  private readonly counters = new Map<JobKind, number>();
  private readonly listeners = new Set<JobDoneListener>();

  start(req: JobStart): string {
    const n = (this.counters.get(req.kind) ?? 0) + 1;
    const hooks = req.run();
    this.counters.set(req.kind, n);
    const id = `${req.kind}-${n}`;
    const record: JobRecord = {
      id,
      kind: req.kind,
      label: req.label,
      owner: req.owner,
      workspace: req.workspace,
      status: "running",
      startedAt: Date.now(),
      reported: false,
      outputLimitBytes: req.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
      stream: typeof hooks.readOutput === "function",
      hooks,
      waiters: [],
    };
    this.records.set(id, record);
    void hooks.done
      .then(
        (outcome) => this.settle(record, outcome.status, outcome.output, outcome.error),
        (e) => this.settle(record, "failed", undefined, String((e as Error)?.message ?? e)),
      );
    return id;
  }

  private settle(r: JobRecord, status: JobSnapshot["status"], output?: string, error?: string): void {
    if (r.finishedAt !== undefined) return;
    r.status = status;
    r.finishedAt = Date.now();
    if (output !== undefined) r.output = output;
    if (error !== undefined) r.error = error;
    for (const w of r.waiters.splice(0)) w();
    const snap = toSnapshot(r);
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        /* listener errors must not break settlement */
      }
    }
  }

  private owned(id: string, caller: string): JobRecord {
    const r = this.records.get(id);
    if (!r) throw new JobsError(`job ${id} 不存在（jobs 不跨进程保留）`, "NOT_FOUND");
    if (r.owner !== caller) throw new JobsError(`job ${id} 不属于当前会话`, "NOT_OWNER");
    return r;
  }

  snapshot(id: string): JobSnapshot | undefined {
    const r = this.records.get(id);
    return r ? toSnapshot(r) : undefined;
  }

  markReported(id: string): void {
    const r = this.records.get(id);
    if (r) r.reported = true;
  }

  async read(id: string, caller: string, opts: { wait?: boolean; timeoutMs?: number } = {}): Promise<JobRead> {
    const r = this.owned(id, caller);
    if (r.finishedAt === undefined && opts.wait) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, opts.timeoutMs ?? 60000));
        r.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (r.finishedAt === undefined) {
      return { status: r.status, text: r.stream ? r.hooks.readOutput!() : "" };
    }
    r.reported = true;
    return { status: r.status, text: r.stream ? r.hooks.readOutput!() : (r.output ?? r.error ?? "") };
  }

  list(caller: string): JobSnapshot[] {
    return [...this.records.values()].filter((r) => r.owner === caller).map(toSnapshot);
  }

  kill(id: string, caller: string, reason?: string): "requested" | "already-finished" {
    const r = this.owned(id, caller);
    if (r.finishedAt !== undefined) return "already-finished";
    r.status = "stopping";
    r.hooks.cancel(reason);
    return "requested";
  }

  hasLive(owner: string): boolean {
    for (const r of this.records.values()) {
      if (r.owner === owner && r.finishedAt === undefined) return true;
    }
    return false;
  }

  onJobDone(listener: JobDoneListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async detachOwner(owner: string): Promise<void> {
    const live = [...this.records.values()].filter((r) => r.owner === owner && r.finishedAt === undefined);
    for (const r of live) {
      r.status = "stopping";
      try {
        r.hooks.cancel("owner disposed");
      } catch {
        /* cancel 抛错不阻塞 dispose */
      }
    }
    await Promise.all(live.map((r) => r.hooks.done.catch(() => undefined)));
  }

  __reset(): void {
    this.records.clear();
    this.counters.clear();
    this.listeners.clear();
  }
}

export const jobs = new JobsService();

export function __resetJobsForTest(): void {
  jobs.__reset();
}
```

- [ ] **步骤 5：运行确认通过**

运行：`cd extensions && npx vitest run jobs/service --reporter=dot`
预期：PASS（10 tests）

- [ ] **步骤 6：Commit**

```bash
git add extensions/jobs/types.ts extensions/jobs/service.ts extensions/jobs/service.test.ts
git commit -m "feat(jobs): 进程内 job 注册表服务"
```

---

### 任务 2：notice 句式

**文件：**
- 创建：`extensions/jobs/notice.ts`
- 创建：`extensions/jobs/notice.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
// extensions/jobs/notice.test.ts
import { describe, expect, it } from "vitest";
import { formatJobNotice } from "./notice.js";
import type { JobSnapshot } from "./types.js";

const snap = (over: Partial<JobSnapshot>): JobSnapshot => ({
  id: "subagent-1", kind: "subagent", label: "do x", owner: "s1", workspace: "/ws",
  status: "completed", startedAt: 0, finishedAt: 1, reported: false, outputLimitBytes: 64, stream: false, ...over,
});

describe("formatJobNotice", () => {
  it("first line names id, kind, label, status", () => {
    for (const status of ["completed", "failed", "killed"] as const) {
      expect(formatJobNotice(snap({ status })).split("\n")[0]).toBe(`Background job subagent-1 (subagent: do x) finished ${status}.`);
    }
  });
  it("final-output job appends output", () => {
    expect(formatJobNotice(snap({ output: "answer" }))).toBe("Background job subagent-1 (subagent: do x) finished completed.\nanswer");
  });
  it("failed job with error but no output appends the error", () => {
    expect(formatJobNotice(snap({ status: "failed", error: "boom" }))).toContain("\nboom");
  });
  it("truncates output beyond outputLimitBytes with a marker", () => {
    const text = formatJobNotice(snap({ output: "x".repeat(200) }));
    expect(text.endsWith("\n[notice truncated]")).toBe(true);
    expect(Buffer.byteLength(text.split("\n")[1] ?? "", "utf8")).toBeLessThanOrEqual(64);
  });
  it("stream job has only the first line", () => {
    expect(formatJobNotice(snap({ stream: true, output: "ignored" })).split("\n")).toHaveLength(1);
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run jobs/notice --reporter=dot`

- [ ] **步骤 3：实现**

```ts
// extensions/jobs/notice.ts
import type { JobSnapshot } from "./types.js";

function truncateUtf8(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
  let end = Math.min(text.length, limit);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > limit) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/** 对齐 DSH tool-jobs：首行 `Background job <id> (<kind>: <label>) finished <status>.`，终值 job 附输出。 */
export function formatJobNotice(snapshot: JobSnapshot): string {
  const head = `Background job ${snapshot.id} (${snapshot.kind}: ${snapshot.label}) finished ${snapshot.status}.`;
  if (snapshot.stream) return head;
  const body = snapshot.output ?? snapshot.error ?? "";
  if (!body) return head;
  const cut = truncateUtf8(body, snapshot.outputLimitBytes);
  return `${head}\n${cut.text}${cut.truncated ? "\n[notice truncated]" : ""}`;
}
```

- [ ] **步骤 4：运行确认通过 + Commit**

运行：`cd extensions && npx vitest run jobs/notice --reporter=dot`

```bash
git add extensions/jobs/notice.ts extensions/jobs/notice.test.ts
git commit -m "feat(jobs): job 结算 notice 句式"
```

---

### 任务 3：jobs 扩展（三工具 + owner + notice 投递）

**文件：**
- 创建：`extensions/jobs/index.ts`
- 创建：`extensions/jobs/index.test.ts`
- 修改：`extensions/index.ts`（注册）
- 修改：`extensions/multi-agent/embedded-runner.ts`（`CORE_ALWAYS_ON` 加 `"jobs"`）

- [ ] **步骤 1：写失败的测试**

```ts
// extensions/jobs/index.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn(() => undefined) }));

import jobsExtension from "./index.js";
import { jobs, __resetJobsForTest } from "./service.js";

type Execute = (id: string, params: Record<string, unknown>, s: null, u: null, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
type Handler = (event: unknown, ctx: unknown) => unknown;

function harness() {
  const tools: Record<string, Execute> = {};
  const handlers: Record<string, Handler> = {};
  const sendMessage = vi.fn();
  const pi = {
    registerTool: (t: { name: string; execute: Execute }) => { tools[t.name] = t.execute; },
    on: (ev: string, h: Handler) => { handlers[ev] = h; },
    sendMessage,
  };
  jobsExtension(pi as never);
  return { tools, handlers, sendMessage };
}

function sessionCtx(sessionId: string, idle = true) {
  return { cwd: "/ws", isIdle: () => idle, sessionManager: { getSessionId: () => sessionId } };
}

function startFor(owner: string) {
  let resolve!: (o: { status: "completed"; output: string }) => void;
  const done = new Promise<{ status: "completed"; output: string }>((r) => (resolve = r));
  const id = jobs.start({ kind: "subagent", label: "L", owner, workspace: "/ws", run: () => ({ cancel: () => {}, done }) });
  return { id, resolve };
}

beforeEach(() => __resetJobsForTest());

describe("jobs extension · tools", () => {
  it("job_output returns [status] and output; job_list lists own; job_kill requests", async () => {
    const h = harness();
    await h.handlers.session_start({ type: "session_start" }, sessionCtx("s1"));
    const { id, resolve } = startFor("s1");
    expect((await h.tools.job_output("t", { job_id: id }, null, null, sessionCtx("s1"))).content[0].text).toBe("[status: running]");
    expect((await h.tools.job_list("t", {}, null, null, sessionCtx("s1"))).content[0].text).toContain(id);
    expect((await h.tools.job_kill("t", { job_id: id, reason: "r" }, null, null, sessionCtx("s1"))).content[0].text).toBe(`cancellation requested for job ${id}`);
    resolve({ status: "completed", output: "out" });
    const r = await h.tools.job_output("t", { job_id: id, wait: true, timeout_ms: 100 }, null, null, sessionCtx("s1"));
    expect(r.content[0].text).toBe("[status: completed]\nout");
    expect((await h.tools.job_kill("t", { job_id: id }, null, null, sessionCtx("s1"))).content[0].text).toContain("had already finished");
  });

  it("non-owner gets isError with the ownership message", async () => {
    const h = harness();
    const { id } = startFor("s1");
    const r = await h.tools.job_output("t", { job_id: id }, null, null, sessionCtx("s2"));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`job ${id} 不属于当前会话`);
  });

  it("timeout_ms is capped by JOBS_WAIT_MAX_MS", async () => {
    const h = harness();
    const { id } = startFor("s1");
    const t0 = Date.now();
    await h.tools.job_output("t", { job_id: id, wait: true, timeout_ms: 999999 }, null, null, sessionCtx("s1"));
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 10000);
});

describe("jobs extension · notice delivery", () => {
  it("busy owner → steer without triggerTurn", async () => {
    const h = harness();
    await h.handlers.session_start({ type: "session_start" }, sessionCtx("s1", false));
    const { resolve } = startFor("s1");
    resolve({ status: "completed", output: "o" });
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
    const [msg, opts] = h.sendMessage.mock.calls[0];
    expect(msg).toMatchObject({ customType: "job-done", display: true, details: { jobId: "subagent-1", kind: "subagent", status: "completed" } });
    expect(msg.content.split("\n")[0]).toBe("Background job subagent-1 (subagent: L) finished completed.");
    expect(opts).toEqual({ triggerTurn: false, deliverAs: "steer" });
  });

  it("idle owner → wake up to JOBS_WAKE_BUDGET times, then inject only; input resets", async () => {
    const h = harness();
    await h.handlers.session_start({ type: "session_start" }, sessionCtx("s1", true));
    for (let i = 0; i < 4; i++) startFor("s1").resolve({ status: "completed", output: String(i) });
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(4));
    const optsList = h.sendMessage.mock.calls.map((c) => c[1]);
    expect(optsList.slice(0, 3)).toEqual(Array(3).fill({ triggerTurn: true, deliverAs: "followUp" }));
    expect(optsList[3]).toEqual({ triggerTurn: false });
    await h.handlers.input({ type: "input", text: "hi", source: "interactive" }, sessionCtx("s1"));
    startFor("s1").resolve({ status: "completed", output: "again" });
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(5));
    expect(h.sendMessage.mock.calls[4][1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("owner not attached → nothing sent, snapshot stays unreported", async () => {
    const h = harness();
    const { id, resolve } = startFor("nobody");
    resolve({ status: "completed", output: "o" });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(jobs.snapshot(id)?.reported).toBe(false);
  });

  it("session_shutdown detaches and cancels live jobs", async () => {
    const h = harness();
    await h.handlers.session_start({ type: "session_start" }, sessionCtx("s1"));
    const cancel = vi.fn();
    let resolve!: (o: { status: "killed" }) => void;
    jobs.start({ kind: "subagent", label: "L", owner: "s1", workspace: "/ws", run: () => ({ cancel, done: new Promise((r) => (resolve = r)) }) });
    const p = h.handlers.session_shutdown({ type: "session_shutdown" }, sessionCtx("s1"));
    resolve({ status: "killed" });
    await p;
    expect(cancel).toHaveBeenCalledWith("owner disposed");
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run jobs/index --reporter=dot`

- [ ] **步骤 3：实现（jobs/index.ts）**

```ts
// extensions/jobs/index.ts
// 通用后台 job：job_output / job_list / job_kill + 结算 notice。生产者（subagent 等）调 jobs.start。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfig } from "../_shared/runtime-config.js";
import { formatJobNotice } from "./notice.js";
import { jobs } from "./service.js";
import { JobsError, type JobSnapshot } from "./types.js";

const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_WAIT_MAX_MS = 600_000;
const DEFAULT_WAKE_BUDGET = 3;

interface OwnerHost {
  sendMessage: ExtensionAPI["sendMessage"];
  isIdle: () => boolean;
}

const owners = new Map<string, OwnerHost>();
const wakes = new Map<string, number>();
let listening = false;

function num(key: string, fallback: number): number {
  const n = Number(getConfig(key) ?? "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function callerId(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
  try {
    return ctx.sessionManager?.getSessionId?.()?.trim() ?? "";
  } catch {
    return "";
  }
}

function fail(e: unknown) {
  const text = e instanceof JobsError ? e.message : String((e as Error)?.message ?? e);
  return { content: [{ type: "text" as const, text }], isError: true };
}

function statusLine(s: JobSnapshot): string {
  return `[status: ${s.status}]`;
}

function deliver(snapshot: JobSnapshot): void {
  if (snapshot.reported) return;
  const host = owners.get(snapshot.owner);
  if (!host) return;
  const msg = {
    customType: "job-done",
    content: formatJobNotice(snapshot),
    display: true,
    details: { jobId: snapshot.id, kind: snapshot.kind, status: snapshot.status },
  };
  if (!host.isIdle()) {
    host.sendMessage(msg, { triggerTurn: false, deliverAs: "steer" });
    return;
  }
  const spent = wakes.get(snapshot.owner) ?? 0;
  if (spent < num("JOBS_WAKE_BUDGET", DEFAULT_WAKE_BUDGET)) {
    wakes.set(snapshot.owner, spent + 1);
    host.sendMessage(msg, { triggerTurn: true, deliverAs: "followUp" });
  } else {
    host.sendMessage(msg, { triggerTurn: false });
  }
  jobs.markReported(snapshot.id);
}

export default function (pi: ExtensionAPI) {
  if (!listening) {
    listening = true;
    jobs.onJobDone(deliver);
  }

  pi.on("session_start", async (_e, ctx) => {
    const id = callerId(ctx);
    if (!id) return;
    owners.set(id, { sendMessage: (m, o) => pi.sendMessage(m, o), isIdle: () => ctx.isIdle() });
    wakes.set(id, 0);
  });

  pi.on("session_shutdown", async (_e, ctx) => {
    const id = callerId(ctx);
    if (!id) return;
    owners.delete(id);
    wakes.delete(id);
    await jobs.detachOwner(id);
  });

  pi.on("input", async (_e, ctx) => {
    const id = callerId(ctx);
    if (id) wakes.set(id, 0);
    return undefined;
  });

  pi.registerTool({
    name: "job_output",
    label: "Job Output",
    description:
      "Read a background job by id. Final-output jobs return their output once finished; stream jobs return output since the previous read. " +
      "Set `wait: true` to block until the job settles or `timeout_ms` expires (a timed-out wait returns [status: running] and leaves the job alive).",
    promptGuidelines: [
      "Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one.",
      "Before giving a final answer, collect every still-relevant job with job_output (wait: true only when genuinely blocked), and job_kill jobs that stopped mattering.",
    ],
    parameters: Type.Object({
      job_id: Type.String({ description: "Job id returned by the tool that started the background work." }),
      wait: Type.Optional(Type.Boolean({ description: "Block until the job reaches a terminal status or the timeout expires." })),
      timeout_ms: Type.Optional(Type.Number({ description: "Max wait in milliseconds (with wait: true). Capped by JOBS_WAIT_MAX_MS." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const max = num("JOBS_WAIT_MAX_MS", DEFAULT_WAIT_MAX_MS);
        const timeoutMs = Math.min(typeof params.timeout_ms === "number" ? params.timeout_ms : num("JOBS_WAIT_TIMEOUT_MS", DEFAULT_WAIT_MS), max);
        const r = await jobs.read(params.job_id, callerId(ctx), { wait: params.wait === true, timeoutMs });
        const text = r.text ? `[status: ${r.status}]\n${r.text}` : `[status: ${r.status}]`;
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return fail(e);
      }
    },
  });

  pi.registerTool({
    name: "job_list",
    label: "Job List",
    description: "List your background jobs (running and finished) with their ids, kinds, and statuses.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const rows = jobs.list(callerId(ctx));
      if (rows.length === 0) return { content: [{ type: "text", text: "(no jobs)" }] };
      const lines = rows.map((s) => `${s.id} | ${s.kind} | ${s.label} | ${s.status} | ${new Date(s.startedAt).toISOString()} | ${s.finishedAt ? new Date(s.finishedAt).toISOString() : "-"}`);
      return { content: [{ type: "text", text: ["id | kind | label | status | startedAt | finishedAt", ...lines].join("\n") }] };
    },
  });

  pi.registerTool({
    name: "job_kill",
    label: "Job Kill",
    description: "Request cancellation of a running background job by id. Returns immediately; the job settles as killed once its work actually stops.",
    parameters: Type.Object({
      job_id: Type.String({ description: "Job id returned by the tool that started the background work." }),
      reason: Type.Optional(Type.String({ description: "Optional short reason, forwarded to the job." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const outcome = jobs.kill(params.job_id, callerId(ctx), params.reason);
        const snap = jobs.snapshot(params.job_id);
        const text =
          outcome === "already-finished"
            ? `job ${params.job_id} had already finished ${snap ? statusLine(snap) : ""}`.trim()
            : `cancellation requested for job ${params.job_id}`;
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return fail(e);
      }
    },
  });
}

export function __resetJobsOwnersForTest(): void {
  owners.clear();
  wakes.clear();
}
```

测试文件 `beforeEach` 里 `__resetJobsForTest()` 会清掉 `listeners`，而 `listening` 是模块级布尔——所以 `__resetJobsForTest` 之后要让 `deliver` 重新挂上。把 `listening` 逻辑改成每次 `harness()` 都重新订阅：在 `index.ts` 里去掉 `listening` 守卫，改为模块级 `let unsubscribe: (() => void) | undefined;`，factory 开头 `unsubscribe?.(); unsubscribe = jobs.onJobDone(deliver);`。多会话共用一个 `deliver`（按 `snapshot.owner` 找 host），重复订阅无副作用。测试 `beforeEach` 加 `__resetJobsOwnersForTest()`。

- [ ] **步骤 4：注册扩展**

`extensions/index.ts`：import `jobsExtension from "./jobs/index.js"`；`allExtensions` 数组里 `multiAgent` 之前插入 `jobsExtension`；`namedExtensions` 里 `{ name: "multi-agent", … }` 之前插入 `{ name: "jobs", factory: jobsExtension }`。

`extensions/multi-agent/embedded-runner.ts` `CORE_ALWAYS_ON` 加 `"jobs"`。

- [ ] **步骤 5：运行确认通过**

运行：`cd extensions && npx vitest run jobs --reporter=dot` 与 `npx vitest run index --reporter=dot`（若 `extensions/index.test.ts` 快照扩展列表，按新增更新快照）
预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add extensions/jobs extensions/index.ts extensions/multi-agent/embedded-runner.ts
git commit -m "feat(jobs): job_output / job_list / job_kill 与结算 notice"
```

---

### 任务 4：registry `jobId` 列

**文件：**
- 修改：`extensions/multi-agent/registry.ts`
- 修改：`extensions/multi-agent/registry.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
  it("migrates jobId column and stores it", () => {
    const reg = new SubAgentRegistry(join(dir, "r3.db"));
    reg.load();
    expect(reg.create({ id: "sa-j", task: "t", jobId: "subagent-1" })).toMatchObject({ jobId: "subagent-1" });
    expect(reg.get("sa-j")?.jobId).toBe("subagent-1");
    reg.setJobId("sa-j", "subagent-2");
    expect(reg.get("sa-j")?.jobId).toBe("subagent-2");
    reg.close();
  });
```

- [ ] **步骤 2：实现**

`SubAgentRow` 加 `jobId: string | null;`。`CREATE TABLE` 加 `jobId TEXT,`；迁移块加 `if (!cols.some((c) => c.name === "jobId")) db.exec("ALTER TABLE subagents ADD COLUMN jobId TEXT");`。`create` input 加 `jobId?: string | null;`，row / INSERT 加对应项；行映射加 `jobId: (r.jobId as string | null) ?? null`。新增：

```ts
  setJobId(id: string, jobId: string): void {
    this.database.prepare("UPDATE subagents SET jobId=?, updatedAt=? WHERE id=?").run(jobId, Date.now(), id);
  }
```

- [ ] **步骤 3：运行确认通过 + Commit**

运行：`cd extensions && npx vitest run multi-agent/registry --reporter=dot`

```bash
git add extensions/multi-agent/registry.ts extensions/multi-agent/registry.test.ts
git commit -m "feat(multi-agent): registry 记录 jobId"
```

---

### 任务 5：`spawn_agent` one-shot 后台经 jobs

**文件：**
- 修改：`extensions/multi-agent/index.ts`（`mode` 参数；`action === "spawn"` 分支；`wait` / `status` / `cancel` 别名）
- 修改：`extensions/multi-agent/index.test.ts`

- [ ] **步骤 1：写失败的测试**

`index.test.ts` 顶部 mock 区加：

```ts
vi.mock("../jobs/service.js", () => {
  const start = vi.fn((req: { run: () => { done: Promise<unknown> } }) => {
    req.run();
    return "subagent-1";
  });
  return {
    jobs: {
      start,
      read: vi.fn(async () => ({ status: "completed", text: "job-out" })),
      kill: vi.fn(() => "requested"),
      snapshot: vi.fn(() => ({ status: "running" })),
      hasLive: vi.fn(() => false),
      onJobDone: vi.fn(() => () => {}),
    },
  };
});
import { jobs } from "../jobs/service.js";
```

（`onJobDone` 必须给：`activation.ts` 在模块顶层订阅它——任务 6——`index.test.ts` 间接 import 了 `activation.ts`，缺它会在 import 时崩。）

末尾追加：

```ts
describe("spawn_agent · one-shot background via jobs", () => {
  it("mode one-shot (embedded) starts a job, records jobId, writes one-shot catalog, no subagent-settled", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    const sendSettlement = vi.spyOn(parentHost, "sendSettlementToParent");
    const h = loadSpawnHarness();
    const r = await h.execute("t", { task: "x", action: "spawn", mode: "one-shot" }, null, null, ctx);
    expect(jobs.start).toHaveBeenCalledWith(expect.objectContaining({ kind: "subagent", label: "x" }));
    expect(r.content[0].text).toContain("job subagent-1");
    expect(r.details).toMatchObject({ jobId: "subagent-1", mode: "one-shot" });
    expect(startContinuableEmbedded).not.toHaveBeenCalled();
    expect(runEmbeddedSubagent).toHaveBeenCalled();
    await vi.waitFor(() => expect(h.appendEntry).toHaveBeenCalledWith("subagent_catalog", expect.objectContaining({ mode: "one-shot" })));
    expect(sendSettlement).not.toHaveBeenCalled();
  });

  it("mode omitted → continuable path unchanged", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    await loadSpawnAgent()("t", { task: "x", action: "spawn" }, null, null, ctx);
    expect(startContinuableEmbedded).toHaveBeenCalled();
    expect(jobs.start).not.toHaveBeenCalled();
  });

  it("subprocess background spawn goes through jobs and no longer emits subagent-settled itself", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(false);
    const sendSettlement = vi.spyOn(parentHost, "sendSettlementToParent");
    await loadSpawnAgent()("t", { task: "x", action: "spawn" }, null, null, ctx);
    expect(jobs.start).toHaveBeenCalled();
    await vi.waitFor(() => expect(spawnPiAgent).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(sendSettlement).not.toHaveBeenCalled();
  });

  it("wait alias reads through jobs when the row has a jobId", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    const h = loadSpawnHarness();
    await h.execute("t", { task: "x", action: "spawn", mode: "one-shot" }, null, null, ctx);
    const r = await h.execute("t2", { action: "wait", agentId: "sa_test" }, null, null, ctx);
    expect(jobs.read).toHaveBeenCalledWith("subagent-1", expect.any(String), expect.objectContaining({ wait: true }));
    expect(r.content[0].text).toContain("job-out");
  });

  it("mode one-shot with tasks/chain/worktree is rejected", async () => {
    const r = await loadSpawnAgent()("t", { tasks: ["a", "b"], action: "spawn", mode: "one-shot" }, null, null, ctx);
    expect(r.isError ?? /仅支持单任务/.test(r.content[0].text)).toBeTruthy();
  });
});
```

`registry.js` 的 mock（`index.test.ts:24-48`）要补 `setJobId: vi.fn()` 与在 `get` 返回的行里带 `jobId`（照该 mock 的实现：`create` 存 row 时把 `input.jobId ?? null` 一起存）。`ctx` 需要 `sessionManager.getSessionId`（用于 `owner`）：把 `ctx` 常量改为含 `sessionManager: { getSessionId: () => "parent-session" }`，或在本 describe 内用 `{ ...ctx, sessionManager: … }`。

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run multi-agent/index -t "one-shot background" --reporter=dot`

- [ ] **步骤 3：实现**

import：

```ts
import { jobs } from "../jobs/service.js";
import type { JobOutcome } from "../jobs/types.js";
```

`parameters` 加：

```ts
      mode: Type.Optional(
        Type.Union([Type.Literal("one-shot"), Type.Literal("continuable")], {
          description: 'Only with action "spawn": "continuable" (default) keeps the child resident for send_message; "one-shot" runs once as a background job, collect with job_output.',
        }),
      ),
```

新增辅助：

```ts
function mapStop(r: SubagentRunResult, aborted: boolean): JobOutcome {
  const status = r.stopReason === "aborted" || aborted ? "killed" : r.ok ? "completed" : "failed";
  return { status, output: r.output, ...(r.error ? { error: r.error } : {}) };
}
```

`action === "spawn"` 分支开头，`const spawnedText = …` 之后：

```ts
        const spawnMode = params.mode === "one-shot" ? "one-shot" : "continuable";
        const startOneShotJob = (): { jobId: string } => {
          registry.create({ id, task, profile: params.profile ? JSON.stringify(profile) : null, model: chosenModel ?? null, parentId: parentSid ?? null, depth: childDepth });
          const controller = new AbortController();
          inflight.set(id, controller);
          const jobId = jobs.start({
            kind: "subagent",
            label: catalogLabel(task),
            owner: parentSid ?? ctx.cwd,
            workspace,
            run: () => {
              const done = executeSubagent(ctx.cwd, task, id, profile, {
                parentSessionPath: parentPath,
                model: chosenModel,
                systemPrompt: layer.systemPrompt,
                tools: layer.tools,
                env: profileEnv,
                mcp: profile.mcp,
                timeoutMs: limits.timeoutMs,
                seedMessages,
                depth: childDepth,
                thinkingLevel: thinkingLevel || undefined,
                signal: controller.signal,
                onUpdate: (u) => {
                  if (u.sessionPath) registry.setSessionPath(id, u.sessionPath);
                  registry.progress(id, u.transcript);
                },
              })
                .then((r) => {
                  const aborted = controller.signal.aborted;
                  registry.finish(id, r.ok
                    ? { status: "done", output: r.output, exitCode: r.exitCode, transcript: r.transcript }
                    : { status: aborted ? "cancelled" : "error", output: r.output, error: r.error, exitCode: r.exitCode, transcript: r.transcript });
                  if (r.ok) writeOneShotCatalog(pi, ctx, { childId: id, sessionPath: r.sessionPath, label: catalogLabel(task) });
                  return mapStop(r, aborted);
                })
                .catch((e): JobOutcome => {
                  registry.finish(id, { status: "error", error: String((e as Error)?.message ?? e), exitCode: -1 });
                  return { status: "failed", error: String((e as Error)?.message ?? e) };
                })
                .finally(() => inflight.delete(id));
              return { cancel: () => controller.abort(), done };
            },
          });
          registry.setJobId(id, jobId);
          return { jobId };
        };
```

然后：

- `if (canUseEmbeddedSubagent(profile))` 分支之前加：

```ts
        if (spawnMode === "one-shot") {
          const { jobId } = startOneShotJob();
          return {
            content: [{ type: "text", text: `Background one-shot sub-agent started as job ${jobId}. Collect with job_output({ job_id: "${jobId}" }).` }],
            details: { agentId: id, jobId, mode: "one-shot", status: "running" },
          };
        }
```

- 原来的子进程后台分支（`registry.create` + `void executeSubagent(...)` + `sendSettlementToParent` + `Promise.race`，约 `index.ts:696-771`）整段替换为：

```ts
        const { jobId } = startOneShotJob();
        return {
          content: [{ type: "text", text: `${spawnedText}\nAlso tracked as job ${jobId} (job_output / job_kill).` }],
          details: { agentId: id, jobId, status: "running" },
        };
```

`sendSettlementToParent` / `formatSettlementNotice` 若此后 `index.ts` 无引用，从 import 删掉。

- `wait` / `status` / `cancel` 别名：在 `if (action === "status" || action === "wait" || …)` 块内，取到 `row` 之后：

```ts
        if ((action === "wait" || action === "status") && row?.jobId) {
          const caller = parentSessionId(ctx) ?? ctx.cwd;
          const r = await jobs.read(row.jobId, caller, { wait: action === "wait", timeoutMs: capMs });
          const fresh = registry.get(id) ?? row;
          return {
            content: [{ type: "text", text: r.text ? `${statusText(fresh)}\n${r.text}` : statusText(fresh) }],
            details: { agentId: fresh.id, jobId: row.jobId, status: fresh.status, exitCode: fresh.exitCode },
          };
        }
        if (action === "cancel" && row?.jobId) {
          try {
            jobs.kill(row.jobId, parentSessionId(ctx) ?? ctx.cwd, "spawn_agent cancel");
          } catch {
            /* 非 owner / 已终：仍走下面的 registry cancel */
          }
        }
```

（`capMs` 在 `wait` 分支已计算；若在 `status` 分支拿不到，用 `0`。）

- `mode: "one-shot"` 与 `tasks` / `chain` / worktree：现有 `if (list.length !== 1) throw new Error("background spawn 仅支持单任务")` 与 worktree 检查已覆盖，不用加。

- [ ] **步骤 4：运行确认通过**

运行：`cd extensions && npx vitest run multi-agent --reporter=dot`
预期：PASS。旧用例里断言子进程后台会发 `subagent-settled` 的（搜 `sendSettlementToParent` 在 `index.test.ts` 的用法）改为断言 `jobs.start` 被调。

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/index.ts extensions/multi-agent/index.test.ts
git commit -m "feat(multi-agent): one-shot 后台子代理经 jobs 服务"
```

---

### 任务 6：子级结算等活 job

**文件：**
- 修改：`extensions/multi-agent/activation.ts`
- 修改：`extensions/multi-agent/activation.test.ts`

- [ ] **步骤 1：写失败的测试**

`activation.test.ts` 顶部加 mock：

```ts
const jobsMock = vi.hoisted(() => ({ hasLive: vi.fn(() => false), onJobDone: vi.fn(() => () => {}) }));
vi.mock("../jobs/service.js", () => ({ jobs: jobsMock }));
```

`describe("activation")` 追加：

```ts
  it("does not settle while the child owns a live job; settles after the job is gone", async () => {
    jobsMock.hasLive.mockReturnValue(true);
    const session = mockSession();
    const sendMessage = registerHost();
    install(session, { announced: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMessage).not.toHaveBeenCalled();
    jobsMock.hasLive.mockReturnValue(false);
    const listener = jobsMock.onJobDone.mock.calls[0]?.[0] as (s: { owner: string }) => void;
    listener({ owner: "sa-1" });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  });
```

`jobs.onJobDone` 在 `activation.ts` import 时就被调用；若该测试文件的 `beforeEach` 有 `vi.clearAllMocks()` / `vi.resetAllMocks()`，`mock.calls[0]` 会被清掉——改成在 `vi.hoisted` 里把 listener 存到变量：`onJobDone: vi.fn((l) => { jobsMock.listener = l; return () => {}; })`，测试里用 `jobsMock.listener`。

- [ ] **步骤 2：实现**

`activation.ts` import `jobs` from `../jobs/service.js`。`watchSettlement` 里（第七期已改成）

```ts
      if (act.ownedChildren.size > 0) return "wait" as const;
```

改为

```ts
      if (act.ownedChildren.size > 0 || jobs.hasLive(act.childId)) return "wait" as const;
```

模块顶层（`activations` 定义之后）订阅 job 结算，用第七期的 `wake`：

```ts
jobs.onJobDone((snapshot) => {
  const act = activations.get(snapshot.owner);
  if (act) wake(act);
});
```

- [ ] **步骤 3：运行确认通过 + Commit**

运行：`cd extensions && npx vitest run multi-agent/activation --reporter=dot`

```bash
git add extensions/multi-agent/activation.ts extensions/multi-agent/activation.test.ts
git commit -m "feat(multi-agent): 子级结算等待自己的活 job"
```

---

### 任务 7：Electron `job-done` notice 渲染

**文件：**
- 创建：`electron-agent/src/features/chat/JobDonePill.tsx`
- 修改：`electron-agent/src/features/chat/ChatMessageItems.tsx:105`
- 修改：`electron-agent/src/features/chat/ChatMessageItems.test.tsx`（若无此文件，找渲染 `subagent-settled` 的现有测试文件：`grep -rln "subagent-settled" electron-agent/src --include=*.test.tsx`）

- [ ] **步骤 1：写失败的测试**

照现有 `subagent-settled` 渲染用例的写法追加：

```tsx
  it('renders job-done notices as a JobDonePill with the first line as title', () => {
    render(<ChatMessageItems messages={[notice({ customType: 'job-done', content: 'Background job subagent-1 (subagent: L) finished completed.\nout' })]} />);
    expect(screen.getByTestId('job-done-pill')).toBeTruthy();
    expect(screen.getByText('Background job subagent-1 (subagent: L) finished completed.')).toBeTruthy();
    expect(screen.queryByText('已注入上下文')).toBeNull();
  });
```

（`notice(...)` 与 `ChatMessageItems` 的 props 照该测试文件既有夹具。）

- [ ] **步骤 2：实现**

`JobDonePill.tsx`：复制 `SubagentSettledPill.tsx`，改名 `JobDonePill` / `JobDonePillInner`，`data-testid="job-done-pill"`，图标换 `Briefcase`（lucide-react）。样式块与标题/正文切分逻辑完全相同——为避免两份拷贝漂移，把 `SubagentSettledPill.tsx` 里的 `styles` 与 `useMemo` 切分抽成 `electron-agent/src/features/chat/NoticeSplitPill.tsx`：

```tsx
// NoticeSplitPill.tsx
import { createStaticStyles, cssVar } from 'antd-style';
import type { LucideIcon } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { MutedLine } from './conv/MutedLine';
import { LazyMarkdown } from './LazyMarkdown';

const styles = createStaticStyles(({ css }) => ({ body: css`/* 与 SubagentSettledPill 相同 */` }));

interface NoticeSplitPillProps {
  content: string;
  icon: LucideIcon;
  testId: string;
}

function NoticeSplitPillInner({ content, icon, testId }: NoticeSplitPillProps) {
  const [expanded, setExpanded] = useState(false);
  const { title, body } = useMemo(() => {
    const newline = content.search(/\r?\n/);
    const first = (newline === -1 ? content : content.slice(0, newline)).trim();
    const rest = newline === -1 ? '' : content.slice(newline).replace(/^\r?\n/, '');
    return { title: first || content.trim(), body: rest || content };
  }, [content]);
  return (
    <div data-testid={testId} style={{ paddingInlineStart: 4, maxWidth: '100%' }}>
      <MutedLine icon={icon} text={title} open={expanded} onToggle={() => setExpanded((v) => !v)} />
      {expanded ? <div className={styles.body}><LazyMarkdown variant="chat" fontSize={12}>{body}</LazyMarkdown></div> : null}
    </div>
  );
}

export const NoticeSplitPill = memo(NoticeSplitPillInner);
```

然后 `SubagentSettledPill.tsx` 简化为 `<NoticeSplitPill content={content} icon={Bot} testId="subagent-settled-pill" />`，`JobDonePill.tsx` 为 `<NoticeSplitPill content={content} icon={Briefcase} testId="job-done-pill" />`。

`ChatMessageItems.tsx:105` 之后加：

```tsx
      if (msg.customType === 'job-done') return <JobDonePill content={msg.content} />;
```

- [ ] **步骤 3：运行确认通过 + Commit**

运行：`cd electron-agent && npx vitest run src/features/chat --reporter=dot 2>&1 | tail -5`

```bash
git add electron-agent/src/features/chat/JobDonePill.tsx electron-agent/src/features/chat/NoticeSplitPill.tsx electron-agent/src/features/chat/SubagentSettledPill.tsx electron-agent/src/features/chat/ChatMessageItems.tsx electron-agent/src/features/chat/*.test.tsx
git commit -m "feat(chat): 渲染 job-done notice"
```

---

### 任务 8：结构化输出程序接口

**文件：**
- 修改：`extensions/multi-agent/embedded-runner.ts`（`EmbeddedSubagentOpts.outputSchema`、`EmbeddedSubagentResult.structured`、factory 注入、指令拼接、结果回传）
- 修改：`extensions/multi-agent/runner.ts`（`SpawnPiAgentOpts.outputSchema` + 抛错）
- 修改：`extensions/multi-agent/index.ts`（`executeSubagent` 透传；`SubagentRunResult.structured`）
- 修改：`extensions/multi-agent/embedded-runner.run.test.ts`、`runner.test.ts`
- 创建：`extensions/multi-agent/structured-output.ts`（常量与 factory 构造）

- [ ] **步骤 1：写失败的测试**

`embedded-runner.run.test.ts` 追加：

```ts
describe("outputSchema", () => {
  const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };

  function captureFactories() {
    const factories: Array<(pi: unknown) => void> = [];
    vi.mocked(createAgentSessionServicesMock).mockImplementation(async (opts: { resourceLoaderOptions: { extensionFactories: Array<(pi: unknown) => void>; appendSystemPrompt?: string[] } }) => {
      factories.push(...opts.resourceLoaderOptions.extensionFactories);
      lastAppend = opts.resourceLoaderOptions.appendSystemPrompt ?? [];
      return { modelRuntime: { id: "runtime" } };
    });
    return factories;
  }
  let lastAppend: string[] = [];

  it("adds a per-child factory registering structured_output with the schema, and appends the instruction", async () => {
    const factories = captureFactories();
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-s1", outputSchema: schema as never, systemPrompt: "P" });
    const registered: Array<{ name: string; parameters: unknown }> = [];
    for (const f of factories) f({ registerTool: (t: { name: string; parameters: unknown }) => registered.push(t), on: () => {} });
    expect(registered.some((t) => t.name === "structured_output" && t.parameters === schema)).toBe(true);
    expect(lastAppend[0]).toMatch(/^P[\s\S]*structured_output/);
  });

  it("returns structured when the child called the tool; last call wins; omitted when not called", async () => {
    const factories = captureFactories();
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    const p = runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-s2", outputSchema: schema as never });
    await vi.waitFor(() => expect(factories.length).toBeGreaterThan(0));
    let exec: ((id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    for (const f of factories) f({ registerTool: (t: { name: string; execute: typeof exec }) => { if (t.name === "structured_output") exec = t.execute; }, on: () => {} });
    expect(await exec!("c1", { answer: "one" })).toMatchObject({ content: [{ text: "结果已记录" }] });
    expect(await exec!("c2", { answer: "two" })).toMatchObject({ content: [{ text: "结果已替换先前记录" }] });
    const r = await p;
    expect(r.structured).toEqual({ answer: "two" });

    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    const r2 = await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-s3", outputSchema: schema as never });
    expect(r2).not.toHaveProperty("structured");
    expect(r2.stopReason).toBe("completed");
  });
});
```

该文件把 `createAgentSessionServices` mock 成匿名 `vi.fn`——把它提到顶层常量 `createAgentSessionServicesMock`（照 `createAgentSessionFromServices` 的写法），并且该 mock 的 `getConfig` 对 `PI_SYSTEM_WORKER` 返回 `"1"`（factories 为空）——结构化 factory 必须在这种情况下**仍然**追加（它不属于 `manifestExtensions`）。

`runner.test.ts` 追加：

```ts
  it("outputSchema is rejected on the subprocess path", () => {
    expect(() => buildSubagentLaunch("D:/a", "t", { outputSchema: { type: "object" } as never })).toThrow("outputSchema 需要 Electron 进程内子会话");
  });
```

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run multi-agent/embedded-runner.run multi-agent/runner --reporter=dot`

- [ ] **步骤 3：实现（structured-output.ts）**

```ts
// extensions/multi-agent/structured-output.ts
// 每子级一份的 structured_output 工具：schema 由调用方给，值经 pi 工具层按 parameters 校验后进 execute。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STRUCTURED_OUTPUT_TOOL = "structured_output";

export const STRUCTURED_OUTPUT_INSTRUCTION =
  `得出最终答案后，必须调用 ${STRUCTURED_OUTPUT_TOOL} 工具、参数严格符合其 schema 来交付结果。` +
  "不要以纯文本收尾：只有这次工具调用算作你的结果。";

export interface StructuredCapture {
  factory: (pi: ExtensionAPI) => void;
  captured: () => { value: unknown } | undefined;
}

export function createStructuredCapture(schema: object): StructuredCapture {
  let captured: { value: unknown } | undefined;
  return {
    captured: () => captured,
    factory: (pi) => {
      pi.registerTool({
        name: STRUCTURED_OUTPUT_TOOL,
        label: "Structured Output",
        description: "Deliver your final result. Call exactly once with arguments matching the schema.",
        parameters: schema as never,
        async execute(_id, params) {
          const replaced = captured !== undefined;
          captured = { value: params };
          return { content: [{ type: "text", text: replaced ? "结果已替换先前记录" : "结果已记录" }] };
        },
      });
    },
  };
}

export function withStructuredInstruction(systemPrompt: string | undefined): string {
  const head = systemPrompt?.trim() ?? "";
  return head ? `${head}\n\n${STRUCTURED_OUTPUT_INSTRUCTION}` : STRUCTURED_OUTPUT_INSTRUCTION;
}
```

- [ ] **步骤 4：实现（embedded-runner.ts）**

`EmbeddedSubagentOpts` 加 `outputSchema?: object;`；`EmbeddedSubagentResult` 加 `structured?: unknown;`。

`openEmbeddedChildSession` 里 `createAgentSessionServices({...})` 之前：

```ts
  const structured = opts.outputSchema ? createStructuredCapture(opts.outputSchema) : undefined;
  const baseFactories = getConfig("PI_SYSTEM_WORKER") === "1" ? [] : await filterExtensionFactories();
  const extensionFactories = structured ? [...baseFactories, structured.factory] : baseFactories;
  const systemPrompt = structured ? withStructuredInstruction(opts.systemPrompt) : opts.systemPrompt?.trim();
```

并把 `resourceLoaderOptions` 改为用这两个变量：

```ts
    resourceLoaderOptions: {
      extensionFactories,
      noContextFiles: getConfig("PI_DISABLE_PROJECT_CONTEXT") === "1",
      ...(systemPrompt ? { appendSystemPrompt: [systemPrompt] } : {}),
    },
```

`OpenedEmbedded` 加 `structured?: StructuredCapture;`，返回对象带上。`runEmbeddedSubagent` 两处构造 `result` 时加：

```ts
          ...(child.structured?.captured() ? { structured: child.structured.captured()!.value } : {}),
```

`buildExcludeTools` 不需要改（`structured_output` 不在 deny 里）。

- [ ] **步骤 5：实现（runner.ts / index.ts）**

`runner.ts` `SpawnPiAgentOpts` 加 `outputSchema?: object;`；`buildSubagentLaunch` 开头：

```ts
  if (opts.outputSchema) throw new Error("outputSchema 需要 Electron 进程内子会话");
```

`index.ts` `SubagentRunResult` 加 `structured?: unknown`；`executeSubagent` embedded 分支透传 `outputSchema: opts.outputSchema,`（子进程分支靠 `spawnPiAgent` 抛错）。

- [ ] **步骤 6：运行确认通过**

运行：`cd extensions && npx vitest run multi-agent --reporter=dot`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add extensions/multi-agent/structured-output.ts extensions/multi-agent/embedded-runner.ts extensions/multi-agent/embedded-runner.run.test.ts extensions/multi-agent/runner.ts extensions/multi-agent/runner.test.ts extensions/multi-agent/index.ts
git commit -m "feat(multi-agent): executeSubagent 支持 outputSchema 结构化输出"
```

---

### 任务 9：回归、类型检查、规格状态

- [ ] **步骤 1：类型检查**

运行：`cd cli && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5` 与 `cd electron-agent && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
预期：无错误

- [ ] **步骤 2：回归**

运行：`cd extensions && npx vitest run --reporter=dot 2>&1 | tail -5` 与 `cd electron-agent && npx vitest run src/features/chat src/features/subagents electron/app/subagentService --reporter=dot 2>&1 | tail -5`
预期：全部 PASS

- [ ] **步骤 3：规格状态**

把 `docs/superpowers/specs/2026-09-14-dsh-subagent-jobs-structured-output-design.md` 的 `- 状态：待审查` 改为 `- 状态：已落地`；规格 2 §8.4 加一句「（第八期起子进程后台 notice 由 `job-done` 承担）」。

```bash
git add docs/superpowers/specs/2026-09-14-dsh-subagent-jobs-structured-output-design.md docs/superpowers/specs/2026-09-13-dsh-subagent-continuable-notice-design.md
git commit -m "docs(specs): 第八期 jobs 与结构化输出标记已落地"
```
