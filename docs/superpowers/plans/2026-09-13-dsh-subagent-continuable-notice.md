# DSH 子代理规格 2：可续聊 + settle notice 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Electron embedded 的 `spawn_agent({ action: "spawn" })` 变成可续聊 Activation；结算后往父会话注入一条 DSH 句式的 `subagent-settled` notice；相邻 `send_message` / `interrupt_agent` 可投递或停轮。

**架构：** sidecar 进程内单例 Activation 图（按 `cwd` 分桶）+ 按 `sessionPath` 注册的 parent host。inbox 用 `AgentSession.prompt({ streamingBehavior })` 与 `pendingMessageCount`。notice 只走父扩展 `pi.sendMessage`。one-shot `action: "run"` 不改语义。

**技术栈：** TypeScript ESM、vitest、`@earendil-works/pi-coding-agent`、Electron `WorkspaceHandle`、React。

**上游规格：** `docs/superpowers/specs/2026-09-13-dsh-subagent-continuable-notice-design.md`（以复核后的 §12 附录为准）

**不要执行：** 规格 3 页头目录、规格 4 fork 种子、改 `spawn_agent` 工具名、把 `action: "run"` 改后台。

---

## 动工前必读

- **不要隔离 worktree**，在当前仓库原地做。工作区很脏：每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。
- Windows 提交用 PowerShell here-string，不要 bash `EOF` heredoc。
- 禁止 emoji。
- 每个任务 commit 前：

```powershell
cd "D:\OneDrive\Project Files\Pi\cli"; npx tsc --noEmit
```

`extensions/` 下**没有** tsconfig.json，在那里跑 `tsc --noEmit` 什么也检查不到。类型检查由 `cli/tsconfig.json` 承担（`include: ["src", "../extensions"]`，`target: ES2022`，`strict: true`）。

涉及 Electron 的任务再加：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit
```

- 扩展侧写 `custom` 用 `pi.appendEntry`；`SessionManager.appendCustomEntry` 只用于**子会话** `subagent_meta`。不存在 `pi.appendCustomEntry`。
- `pi.sendMessage` 同步 `void`，选项 `{ triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }`。notice **只走这一条通道**，禁止再 `sendUserMessage`。
- 队列读口：`session.pendingMessageCount` / `getSteeringMessages()` / `getFollowUpMessages()`。不要解析 `queue_update`。
- 流式中 `prompt` 必须带 `streamingBehavior`，否则 SDK 抛错。idle 时省略该参数即开新轮。是否流式用 `session.isStreaming`。
- 父 id：`ctx.sessionManager.getSessionId()`。父路径：`ctx.sessionManager.getSessionFile()`（已有 `parentSessionPath`）。
- parent-host 按 **`sessionPath`** 分桶，表项带 `workspace`。子→父时 `activation.workspace === host.workspace`，否则当父不可用。
- `WorkspaceHandle.prompt` 的 origin 只能 `'main' | 'goal'`。本计划 notice 不走这条（`sendMessage` 已核实认 `deliverAs`）。
- `WorkspaceContext.origin` 现在声明成 `"main" | "goal"`，但 `embedded-runner.ts` 已传 `"subagent"`。任务 1 先把类型扩成 `"main" | "goal" | "subagent"`。
- **ES2022 基线**：`Promise.withResolvers`（ES2024）与 `Array.prototype.findLastIndex` / `findLast`（ES2023）不在 target 的 lib 里。本计划任务 2 / 4 用到 `Promise.withResolvers`。动手前先跑一次探针（在 `cli/src` 下临时加一行 `const _p = Promise.withResolvers<void>()` 跑 tsc，确认后立即删）；不通过就一律手写 deferred：

  ```ts
  let resolve!: () => void; let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  ```

  不要为了让 `withResolvers` 通过去改 `cli/tsconfig.json` 的 target。
- 现有后台 spawn 在 `extensions/multi-agent/index.ts` 约 492–568 行。改造点就在这一段。
- `reapOrphans` 现在把所有 `running` 打成 `orphaned: process restarted`。continuable + JSONL 在时必须改成 `done` + `sidecar restarted`，**不** `sendNotice`。
- 测试：

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run multi-agent/<本任务文件>
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run <本任务列出的测试>
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `extensions/multi-agent/settlement-notice.ts` | DSH 句式 + `SettlementNotice` |
| `extensions/multi-agent/settlement-notice.test.ts` | 三句 + 无正文 |
| `extensions/multi-agent/inbox.ts` | 关闭中拒收；steer / followUp |
| `extensions/multi-agent/inbox.test.ts` | 关闭 / pending / 投递 |
| `extensions/multi-agent/parent-host.ts` | 按 sessionPath 注册；`sendNotice` |
| `extensions/multi-agent/parent-host.test.ts` | 分桶、workspace 隔离、busy/idle/drain |
| `extensions/multi-agent/activation.ts` | ChildLock、驻留、结算、冷恢复、drain |
| `extensions/multi-agent/activation.test.ts` | 串行、结算取消、未宣布、跨工作区 |
| `extensions/multi-agent/adjacent-tools.ts` | `send_message` / `interrupt_agent` |
| `extensions/multi-agent/adjacent-tools.test.ts` | 相邻权限、冷恢复、空操作 interrupt |
| `electron-agent/src/features/chat/SubagentSettledPill.tsx` | notice 专用 pill |
| `electron-agent/src/features/chat/SubagentSettledPill.test.tsx` | 标题不是「已注入上下文」 |

修改：

| 文件 | 职责 |
| --- | --- |
| `extensions/_shared/workspace-context.ts` | `WorkspaceContext.origin` 含 `"subagent"` |
| `extensions/multi-agent/embedded-runner.ts` | 拆出 `createEmbeddedChildSession`；continuable 不 dispose |
| `extensions/multi-agent/registry.ts` | 可选 `sessionPath` 列；`reapOrphans` 区分 continuable |
| `extensions/multi-agent/index.ts` | spawn 走 Activation；注册相邻工具；guidelines |
| `extensions/multi-agent/restart-reap.test.ts` | continuable 不发 notice |
| `electron-agent/electron/agent/workspaceHandle.ts` | 注册 / 注销 parent host；dispose 先 drain |
| `electron-agent/src/features/chat/ChatMessageItems.tsx` | `subagent-settled` 分支 |

---

### 任务 1：`WorkspaceContext.origin` 含 `subagent` + notice 句式

**文件：**
- 修改：`extensions/_shared/workspace-context.ts`
- 创建：`extensions/multi-agent/settlement-notice.ts`
- 测试：`extensions/multi-agent/settlement-notice.test.ts`
- 若已有 `extensions/_shared/workspace-context.test.ts`：补一条 origin 断言

- [ ] **步骤 1：写失败的 notice 测试**

```ts
import { describe, expect, it } from "vitest";
import { formatSettlementNotice } from "./settlement-notice.js";

describe("formatSettlementNotice", () => {
  it("completed with closing message", () => {
    const n = formatSettlementNotice({
      childId: "sa-abc",
      stopReason: "completed",
      output: "done here",
    });
    expect(n.summary).toBe(
      "Background subagent sa-abc finished and will do no further work unless you send it more.",
    );
    expect(n.content).toBe(
      "Background subagent sa-abc finished and will do no further work unless you send it more.\nIts closing message:\ndone here",
    );
  });

  it("aborted", () => {
    expect(formatSettlementNotice({ childId: "sa-x", stopReason: "aborted", output: "" }).summary).toBe(
      "Background subagent sa-x was stopped before it finished.",
    );
  });

  it("error with no output", () => {
    const n = formatSettlementNotice({ childId: "sa-x", stopReason: "error", output: "" });
    expect(n.content).toContain("It left no closing message.");
    expect(n.summary).toBe("Background subagent sa-x failed before it finished.");
  });
});
```

- [ ] **步骤 2：运行确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run multi-agent/settlement-notice.test.ts
```

预期：FAIL，找不到模块。

- [ ] **步骤 3：最少实现**

`extensions/_shared/workspace-context.ts` 把接口改成：

```ts
export interface WorkspaceContext {
  origin: ToolOrigin;
  workspace: string;
  cwd: string;
  config: Readonly<Record<string, string>>;
}
```

`extensions/multi-agent/settlement-notice.ts`：

```ts
import type { SubagentStopReason } from "./assistant-output.js";

export interface SettlementNoticeInput {
  childId: string;
  stopReason: SubagentStopReason;
  output: string;
  sessionPath?: string;
}

export interface SettlementNotice {
  childId: string;
  stopReason: SubagentStopReason;
  sessionPath?: string;
  summary: string;
  content: string;
}

function summaryOf(childId: string, stopReason: SubagentStopReason): string {
  const subject = `Background subagent ${childId}`;
  if (stopReason === "completed") {
    return `${subject} finished and will do no further work unless you send it more.`;
  }
  if (stopReason === "aborted") return `${subject} was stopped before it finished.`;
  return `${subject} failed before it finished.`;
}

export function formatSettlementNotice(input: SettlementNoticeInput): SettlementNotice {
  const summary = summaryOf(input.childId, input.stopReason);
  const body = input.output.trim()
    ? `Its closing message:\n${input.output}`
    : "It left no closing message.";
  return {
    childId: input.childId,
    stopReason: input.stopReason,
    sessionPath: input.sessionPath,
    summary,
    content: `${summary}\n${body}`,
  };
}
```

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run multi-agent/settlement-notice.test.ts
cd "D:\OneDrive\Project Files\Pi\extensions"; npx tsc --noEmit
```

- [ ] **步骤 5：Commit**

```powershell
git add -- "extensions/_shared/workspace-context.ts" "extensions/multi-agent/settlement-notice.ts" "extensions/multi-agent/settlement-notice.test.ts"
$msg = @"
feat(multi-agent): 结算 notice 句式与 subagent origin 类型
"@
$msg | git commit -F -
```

---

### 任务 2：Inbox

**文件：**
- 创建：`extensions/multi-agent/inbox.ts`
- 测试：`extensions/multi-agent/inbox.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { SubagentInbox } from "./inbox.js";

function fakeSession(over: Partial<{
  isStreaming: boolean;
  pendingMessageCount: number;
  prompt: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    isStreaming: over.isStreaming ?? false,
    pendingMessageCount: over.pendingMessageCount ?? 0,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    prompt: over.prompt ?? vi.fn(async () => {}),
  };
}

describe("SubagentInbox", () => {
  it("rejects deliver after close", () => {
    const session = fakeSession();
    const inbox = new SubagentInbox(session as never);
    void inbox.close(async () => {});
    expect(() => inbox.deliver("hi", "followUp")).toThrow(/ACTIVATION_CLOSING/);
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("hasPending follows pendingMessageCount", () => {
    const session = fakeSession({ pendingMessageCount: 2 });
    const inbox = new SubagentInbox(session as never);
    expect(inbox.hasPending).toBe(true);
    session.pendingMessageCount = 0;
    expect(inbox.hasPending).toBe(false);
  });

  it("steers when asked and session is streaming", async () => {
    const prompt = vi.fn(async () => {});
    const session = fakeSession({ isStreaming: true, prompt });
    const inbox = new SubagentInbox(session as never);
    inbox.deliver("go", "steer");
    expect(prompt).toHaveBeenCalledWith("go", { streamingBehavior: "steer" });
  });

  it("followUp omits streamingBehavior when idle", () => {
    const prompt = vi.fn(async () => {});
    const session = fakeSession({ isStreaming: false, prompt });
    const inbox = new SubagentInbox(session as never);
    inbox.deliver("next", "followUp");
    expect(prompt).toHaveBeenCalledWith("next", {});
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run multi-agent/inbox.test.ts
```

- [ ] **步骤 3：实现**

```ts
export type Delivery = "followUp" | "steer";

export class SubagentError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "SubagentError";
    this.code = code;
  }
}

export interface InboxSession {
  isStreaming: boolean;
  pendingMessageCount: number;
  prompt(text: string, opts?: { streamingBehavior?: "steer" | "followUp" }): Promise<unknown> | unknown;
}

export class SubagentInbox {
  private closingPromise: Promise<void> | undefined;

  constructor(private readonly session: InboxSession) {}

  get closing(): Promise<void> | undefined {
    return this.closingPromise;
  }

  get hasPending(): boolean {
    return this.session.pendingMessageCount > 0;
  }

  deliver(text: string, delivery: Delivery): void {
    if (this.closingPromise !== undefined) {
      throw new SubagentError("activation is being disposed; the message was not accepted", "ACTIVATION_CLOSING");
    }
    if (delivery === "steer" || this.session.isStreaming) {
      void this.session.prompt(text, { streamingBehavior: delivery === "steer" ? "steer" : "followUp" });
      return;
    }
    void this.session.prompt(text, {});
  }

  close(release: () => Promise<void>): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    const done = Promise.withResolvers<void>();
    this.closingPromise = done.promise;
    void release().then(done.resolve, done.reject);
    return this.closingPromise;
  }
}
```

`deliver` 规则锁死：调用方已选 `steer` 或 `session.isStreaming` 时必须带 `streamingBehavior`；idle + `followUp` 省略该参数。

- [ ] **步骤 4：跑通 + tsc**
- [ ] **步骤 5：Commit** `feat(multi-agent): Activation inbox 的 Queue/Steer 准入`

---

### 任务 3：Parent host

**文件：**
- 创建：`extensions/multi-agent/parent-host.ts`
- 测试：`extensions/multi-agent/parent-host.test.ts`

- [ ] **步骤 1：测试**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  lookupParentHost,
  registerParentSessionHost,
  sendSettlementToParent,
  __resetParentHostsForTest,
} from "./parent-host.js";
import { formatSettlementNotice } from "./settlement-notice.js";

describe("parent-host", () => {
  it("looks up by sessionPath and rejects other workspace", () => {
    __resetParentHostsForTest();
    const sendMessage = vi.fn();
    const unsub = registerParentSessionHost({
      sessionId: "p1",
      sessionPath: "/ws/a.jsonl",
      workspace: "A",
      isBusy: () => false,
      isDraining: () => false,
      sendMessage,
      prompt: vi.fn(),
    });
    expect(lookupParentHost("/ws/a.jsonl", "A")?.sessionId).toBe("p1");
    expect(lookupParentHost("/ws/a.jsonl", "B")).toBeUndefined();
    unsub();
    expect(lookupParentHost("/ws/a.jsonl", "A")).toBeUndefined();
  });

  it("idle parent triggerTurn followUp", () => {
    __resetParentHostsForTest();
    const sendMessage = vi.fn();
    registerParentSessionHost({
      sessionId: "p1",
      sessionPath: "/ws/a.jsonl",
      workspace: "A",
      isBusy: () => false,
      isDraining: () => false,
      sendMessage,
      prompt: vi.fn(),
    });
    sendSettlementToParent("/ws/a.jsonl", "A", formatSettlementNotice({
      childId: "sa-1",
      stopReason: "completed",
      output: "ok",
      sessionPath: "/ws/child.jsonl",
    }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0];
    expect(msg.customType).toBe("subagent-settled");
    expect(msg.display).toBe(true);
    expect(msg.details).toEqual({ childId: "sa-1", stopReason: "completed", sessionPath: "/ws/child.jsonl" });
    expect(opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("busy parent steers without triggerTurn", () => {
    __resetParentHostsForTest();
    const sendMessage = vi.fn();
    registerParentSessionHost({
      sessionId: "p1",
      sessionPath: "/ws/a.jsonl",
      workspace: "A",
      isBusy: () => true,
      isDraining: () => false,
      sendMessage,
      prompt: vi.fn(),
    });
    sendSettlementToParent("/ws/a.jsonl", "A", formatSettlementNotice({
      childId: "sa-1",
      stopReason: "aborted",
      output: "",
    }));
    expect(sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false, deliverAs: "steer" });
  });

  it("draining writes without waking", () => {
    __resetParentHostsForTest();
    const sendMessage = vi.fn();
    registerParentSessionHost({
      sessionId: "p1",
      sessionPath: "/ws/a.jsonl",
      workspace: "A",
      isBusy: () => false,
      isDraining: () => true,
      sendMessage,
      prompt: vi.fn(),
    });
    sendSettlementToParent("/ws/a.jsonl", "A", formatSettlementNotice({
      childId: "sa-1",
      stopReason: "aborted",
      output: "",
    }));
    expect(sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false });
  });

  it("missing host is a no-op", () => {
    __resetParentHostsForTest();
    expect(() => sendSettlementToParent("/nope", "A", formatSettlementNotice({
      childId: "sa-1",
      stopReason: "error",
      output: "",
    }))).not.toThrow();
  });
});
```

- [ ] **步骤 2：跑失败**
- [ ] **步骤 3：实现**

```ts
import type { SettlementNotice } from "./settlement-notice.js";

export interface ParentSessionHost {
  sessionId: string;
  sessionPath: string;
  workspace: string;
  isBusy(): boolean;
  isDraining(): boolean;
  sendMessage: (
    msg: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
    opts: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" },
  ) => void;
  prompt: (text: string, delivery: "followUp" | "steer") => void;
}

const hosts = new Map<string, ParentSessionHost>();

export function registerParentSessionHost(host: ParentSessionHost): () => void {
  hosts.set(host.sessionPath, host);
  return () => {
    if (hosts.get(host.sessionPath) === host) hosts.delete(host.sessionPath);
  };
}

export function lookupParentHost(sessionPath: string, workspace: string): ParentSessionHost | undefined {
  const host = hosts.get(sessionPath);
  if (!host || host.workspace !== workspace) return undefined;
  return host;
}

export function sendSettlementToParent(
  parentSessionPath: string,
  workspace: string,
  notice: SettlementNotice,
): void {
  const host = lookupParentHost(parentSessionPath, workspace);
  if (!host) return;
  const opts = host.isDraining()
    ? { triggerTurn: false as const }
    : host.isBusy()
      ? { triggerTurn: false as const, deliverAs: "steer" as const }
      : { triggerTurn: true as const, deliverAs: "followUp" as const };
  host.sendMessage(
    {
      customType: "subagent-settled",
      content: notice.content,
      display: true,
      details: {
        childId: notice.childId,
        stopReason: notice.stopReason,
        ...(notice.sessionPath ? { sessionPath: notice.sessionPath } : {}),
      },
    },
    opts,
  );
}

export function __resetParentHostsForTest(): void {
  hosts.clear();
}
```

- [ ] **步骤 4：跑通**
- [ ] **步骤 5：Commit** `feat(multi-agent): 按 sessionPath 注册父会话 host`

---

### 任务 4：Activation 图（锁、结算、未宣布、跨工作区）

**文件：**
- 创建：`extensions/multi-agent/activation.ts`
- 测试：`extensions/multi-agent/activation.test.ts`

用假 `AgentSession`：`waitForIdle` 由测试手动 resolve；`pendingMessageCount` 可改；`dispose` / `abort` / `prompt` 为 `vi.fn`。不要在本任务接真实 `createAgentSessionFromServices`。

- [ ] **步骤 1：测试覆盖规格 §11 inbox/activation**

必须包含：

1. `ChildLock`：第二次 `run` 等第一次结束（用 deferred）
2. 关闭中 `deliver` 不 `prompt`
3. idle + `pendingMessageCount === 0` → `sendSettlementToParent` 一次，`dispose` 一次
4. 结算前再 `deliver` → 取消本次结算（`sendNotice` 次数仍为 0，直到再次 idle）
5. `announced === false` 的 `disposeActivation` → 不 `sendSettlementToParent`
6. `announced === true` + `completed` → notice `details.childId` 正确
7. 子 workspace `A`、host 在 `B` → 不投递（`lookup` 失败即 no-op；另测 `authorizeParent` 抛 `PARENT_UNAVAILABLE` 的辅助函数）

假 session 最小形状：

```ts
function mockSession() {
  let idle = Promise.withResolvers<void>();
  return {
    isStreaming: false,
    pendingMessageCount: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: "child done" }] }],
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    waitForIdle: () => idle.promise,
    resolveIdle: () => {
      idle.resolve();
      idle = Promise.withResolvers<void>();
    },
  };
}
```

导出（名称锁死，后面任务按这个用）：

```ts
export class ChildLock { run<T>(childId: string, op: () => Promise<T>): Promise<T> }
export function installActivation(input: { ... }): Activation
export function getActivation(childId: string): Activation | undefined
export function deliverToChild(childId: string, text: string, delivery: Delivery): void
export function interruptChild(childId: string): void
export function disposeActivation(childId: string, reason: "settled" | "cancel" | "rollback"): Promise<void>
export function drainByParent(parentSessionPath: string): Promise<void>
export function authorizeParent(activation: Activation, workspace: string): void
export function coldResumeAndDeliver(childId: string, sessionPath: string, text: string, delivery: Delivery): Promise<void>
export function __resetActivationsForTest(): void
```

`coldResumeAndDeliver` 必须在本任务导出：任务 6 的 `send_message` 冷恢复与规格 4 计划任务 5 都直接调它。它内部走 `SessionManager.open(childPath)` → `createAgentSessionServices` → `createAgentSessionFromServices` → `bindExtensions` → `inbox.deliver`，四步缺一不可；并先读 `subagent_meta`，`mode !== "continuable"` 或 `tornDown` 直接抛 `NOT_RESUMABLE`。

`installActivation` 在 `announced: true` 时启动 `watchSettlement`。`watchSettlement` 循环：`waitForIdle` → lock 内看 `closing` / `hasPending` / `ownedChildren` → 再 poke 检查 → `extractAssistantOutput(session.messages)` → `inbox.close` + `session.dispose()`（不删 JSONL）→ 若 announced 则 `sendSettlementToParent`。

- [ ] **步骤 2–4：** 红 / 绿 / `tsc`
- [ ] **步骤 5：Commit** `feat(multi-agent): 进程内 Activation 结算与拆除`

---

### 任务 5：registry `sessionPath` + 重启 reap

**文件：**
- 修改：`extensions/multi-agent/registry.ts`
- 修改：`extensions/multi-agent/registry.test.ts`
- 修改：`extensions/multi-agent/restart-reap.test.ts`
- 新建：`extensions/multi-agent/reap-continuable.ts`（把「continuable 孤儿」的判定从 `registry.ts` 挪出来，registry 不认识 JSONL，也不该认识）

- [ ] **步骤 1：测试**

`registry.test.ts` 补：

```ts
it("stores sessionPath when provided", () => {
  const r = new SubAgentRegistry(join(dir, "registry.db"));
  r.load();
  r.create({ id: "sa-1", task: "t", sessionPath: "/ws/sa-1.jsonl" });
  expect(r.get("sa-1")?.sessionPath).toBe("/ws/sa-1.jsonl");
});
```

`reap-continuable.test.ts`：

```ts
it("marks continuable leftover as done without calling sendSettlementToParent", () => {
  // 写临时 JSONL：header + custom subagent_meta.mode=continuable
  // registry running + sessionPath
  // reapContinuableOrphans(reg) 
  // row.status === "done" && row.error === "sidecar restarted"
});

it("still errors a running row with no jsonl", () => {
  // 无文件 → status error, error 含 orphaned
});
```

`restart-reap.test.ts` 现有「leftover running → orphaned error」保留给**没有** continuable JSONL 的行。

- [ ] **步骤 3：实现要点**

`registry.ts`：`CREATE` 加 `sessionPath TEXT`；旧库 `PRAGMA table_info` 后 `ALTER`（照 `transcript` 迁移）。`create` / `get` / `list` 带上该列。`SubAgentRow.sessionPath: string | null`。

`reapOrphans()` **不要**再一刀切。改成：对每条 `running`，若 `sessionPath` 指向的文件里 `subagent_meta.mode === "continuable"` 且没有后续 `tornDown: true` → `finish(id, { status: "done", error: "sidecar restarted", output: "" })`；否则维持现在的 `orphaned: process restarted`。

读 meta 用 `SessionManager.open(path).getEntries()`，**不要**用 `buildContextEntries()`：`subagent_meta` 写在子会话创建时，子级一旦 compaction 就不在 leaf 上下文里了，用 leaf 路径会把它读丢、把可续聊子级误判成孤儿。这里要的是「文件里最后一条 `subagent_meta`」，是全文件语义。（目录折叠反过来必须用 leaf 路径——那是规格 3 的语义，别混。）

打不开文件、或文件里没有 `subagent_meta`，都当孤儿走现有分支。

- [ ] **步骤 5：Commit** `fix(multi-agent): 重启不把可续聊子级当已取消`

---

### 任务 6：相邻工具

**文件：**
- 创建：`extensions/multi-agent/adjacent-tools.ts`
- 测试：`extensions/multi-agent/adjacent-tools.test.ts`
- 修改：`extensions/multi-agent/index.ts`（只 `registerTool` 两工具 + 在子/父都注册；本任务先注册，execute 调 activation）

- [ ] **步骤 1：测试（mock activation / parent-host）**

用例锁死：

- 父 `getSessionId() === parentSessionId`，目标是其直接子 → `deliverToChild` 被调用，正文为 `Agent <parentId> sent a message: hi`，返回 `message delivered to agent sa-1`
- 父→无关 id → `isError`，文案含「未送达」
- 驻留子 `meta.parentSessionId === 父 id`，父 host 在且 workspace 同 → 调 host 侧投递（`sendMessage` 不是 settled；用 `session.prompt` 走父 session——见下）
- 子 dispose 后→父 → `PARENT_UNAVAILABLE` / 未送达
- 同级 → `UNAUTHORIZED`
- 冷恢复：无 Activation、JSONL 在、`mode===continuable`、未 tornDown → 调 `coldResumeAndDeliver`
- one-shot meta → `NOT_RESUMABLE`
- `interrupt` 不存在的 id → `interrupt requested for agent sa-missing`（非 error）

子→父投递：规格写父必须在线。`lookupParentHost(activation.parentSessionPath, activation.workspace)` 找到后调 host 的 `prompt(text, delivery)`（busy → `steer`，idle → `followUp`）。任务 3 的 `ParentSessionHost` 本任务起补：

```ts
prompt(text: string, delivery: "followUp" | "steer"): void;
```

`host.prompt` 只负责把**已经拼好的正文**按 delivery 投递。前缀 `Agent <senderId> sent a message: ` 由 `adjacent-tools.ts` 在调用前拼好——host 不知道 senderId，让它拼必然拼错。任务 8 里 `WorkspaceHandle` 的 `prompt` 实现也是这个契约（收到什么投什么）。

不要用 `subagent-settled` 这个 customType，那是运行时结算专用。本任务测试 mock `prompt`。

`send_message` 成功 `details.messageId`：优先 `session.messages` 最后一条 user 的 `id`（若有）；否则省略。

- [ ] **步骤 3：`registerAdjacentTools(pi)`**

两个工具参数用 Type.Object，和 `spawn_agent` 一样。`execute` 里用 `ctx.sessionManager.getSessionId()` 当 senderId。错误收成 `{ content: [{ type: "text", text: "..." }], isError: true }`，不 throw。

返回指引字符串导出为 `continuableReturnGuidance(parentSessionId: string)`，任务 7 拼接任务文本。

- [ ] **步骤 5：Commit** `feat(multi-agent): send_message 与 interrupt_agent`

---

### 任务 7：embedded 拆分 + spawn 走 Activation

**文件：**
- 修改：`extensions/multi-agent/embedded-runner.ts`
- 修改：`extensions/multi-agent/embedded-runner.run.test.ts`
- 修改：`extensions/multi-agent/index.ts`
- 修改：`extensions/multi-agent/index.test.ts`

- [ ] **步骤 1：测试**

`embedded-runner.run.test.ts` 现有 one-shot 路径必须仍 dispose。新增：

```ts
it("createEmbeddedChildSession does not dispose", async () => { ... });
```

`index.test.ts`：

- embedded + `action: "spawn"` 的 details 含 `mode: "continuable"`、`sessionPath`
- 返回文案仍以 `Background sub-agent started` 开头
- mock Activation `install` 被调用
- `action: "run"` 不 `installActivation`、不 `sendSettlementToParent`

- [ ] **步骤 3：实现要点**

从 `runEmbeddedSubagent` 抽出 `createEmbeddedChildSession(opts): Promise<{ session, sessionManager, sessionPath, unsub }>`，写齐 `subagent_meta`：

```ts
{
  origin: "subagent",
  agentId,
  parentSession: parentPath ?? null,
  parentSessionId: opts.parentSessionId ?? null,
  model: opts.model ?? null,
  mode: opts.mode ?? "one-shot",
  label: firstLine(opts.task).slice(0, 80),
  inheritedEventCount: 0,
}
```

`runEmbeddedSubagent`（one-shot）= create + prompt + waitForIdle + extract + dispose。

`startContinuableEmbedded(opts)` = create + `installActivation` + `inbox.deliver(task + 返回指引, "followUp")` + `announced=true`。**不要**在首次 idle 后 dispose。

首次 `inbox.deliver` 必须包 `try/catch`：`session.prompt` 会在「没选模型 / 没配 API key / 流式且没给 streamingBehavior」时抛错（SDK 已注明）。抛了就走 `disposeActivation(id, "rollback")` + 删不写目录 + 工具 `isError`，不能让 Activation 卡在「已安装但从没跑起来」。这条要有单测：mock session 的 `prompt` reject → 断言没有驻留残留、没有 notice。

`announced` 的置位点：在 `prompt` **成功返回之后**，不是调用之前——否则「投递失败但已宣布」会发出一条没有正文的 notice。

`index.ts` `action==="spawn"` 且 `canUseEmbeddedSubagent`：走 `startContinuableEmbedded`，`onUpdate` 仍 `registry.progress`；自然结算在 activation watcher 里 `registry.finish`。子进程回退：现有 `executeSubagent` + `.then` 里 `sendSettlementToParent`（host 在才发），`details.sessionPath` 可缺。

`promptGuidelines` 加一句：后台 spawn 结算后会收到 notice，不必为结论再 `wait`。

`excludeTools` 仍去掉 `spawn_agent` / `explore_context`，**不要**去掉 `send_message`。

规格 3 的 `establishCatalogChild` 本计划**不要调用**（会在规格 3 计划接）。本任务只留注释 `// spec 3: establishCatalogChild after first accept`。

- [ ] **步骤 5：Commit** `feat(multi-agent): embedded spawn 改为可续聊 Activation`

---

### 任务 8：WorkspaceHandle 挂 parent host + drain

**文件：**
- 修改：`electron-agent/electron/agent/workspaceHandle.ts`
- 修改：`electron-agent/electron/agent/workspaceHandle.test.ts`

- [ ] **步骤 1：测试**

现有 `workspaceHandle.test.ts` 补：

- `start()` 之后 `lookupParentHost(sessionPath, workspace)` 有值
- `dispose()` 之后 lookup 为空
- `dispose` 调用 `drainByParent`（mock activation 模块）

**parent host 由 `WorkspaceHandle` 注册，不由扩展注册。** 规格 §4 模块表就是这么定的，而且 `WorkspaceHandle` 手里正好有全部四样东西：`session.sessionFile`、`session.sessionId`、`options.workspace`、`session.sendCustomMessage`。不需要 `pi`，也就不存在「`pi` 每会话一份、模块级变量被覆盖」的问题。

```ts
// start() 末尾，bindAndSubscribe 之后
const sessionPath = this.session.sessionFile;
const sessionId = this.session.sessionId;
if (sessionPath && sessionId) {
  this.unregisterParentHost = registerParentSessionHost({
    sessionId,
    sessionPath,
    workspace: this.options.workspace,
    isBusy: () => this.session.isStreaming,
    isDraining: () => this.disposed,
    sendMessage: (msg, opts) => { void this.session.sendCustomMessage(msg, opts); },
    prompt: (text, delivery) => {
      void this.prompt(text, this.session.isStreaming ? { streamingBehavior: delivery } : {}, "main");
    },
  });
}
```

`dispose()` 顺序：`this.disposed = true` → `await drainByParent(this.parentSessionPath)`（内部给已宣布的发 `aborted`）→ `this.unregisterParentHost?.()` → 现有清理。`isDraining()` 依赖 `this.disposed`，所以置位必须最先。

`sessionPath` 要在 `start()` 里顺手存成私有字段 `parentSessionPath`，`dispose()` 直接用——dispose 阶段 `this.session` 可能已经被 runtime teardown，届时再读 `sessionFile` 拿到的可能是空值。

`sendCustomMessage` 是 `AgentSession` 的现成方法（`agent-session.d.ts:403`），签名与 `pi.sendMessage` 一致；不需要走 `pi`。

**若将来改成用 `pi` 注册**：`pi.on(...)` 必须在 **factory 作用域注册一次**，不要写在 `pi.on("session_start", ...)` 里——`session_start` 每次切会话 / fork / resume 都触发，在里面 `pi.on` 会每切一次多挂一个 handler。

- [ ] **步骤 3：** 按上面实现。换会话由 `AgentSession` 自己 replace，`WorkspaceHandle` 不感知；host 的生命周期跟着 handle 走。
- [ ] **步骤 5：Commit** `feat(multi-agent): 父会话注册 host 并在拆除时 drain`

---

### 任务 9：Electron `subagent-settled` pill

**文件：**
- 创建：`electron-agent/src/features/chat/SubagentSettledPill.tsx`
- 测试：`electron-agent/src/features/chat/SubagentSettledPill.test.tsx`
- 修改：`electron-agent/src/features/chat/ChatMessageItems.tsx`

- [ ] **步骤 1：测试**

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SubagentSettledPill } from './SubagentSettledPill';

afterEach(() => cleanup());

describe('SubagentSettledPill', () => {
  it('uses the first line as title and does not say 已注入上下文', () => {
    render(
      <SubagentSettledPill
        content={
          'Background subagent sa-1 finished and will do no further work unless you send it more.\nIts closing message:\nok'
        }
      />,
    );
    const el = screen.getByTestId('subagent-settled-pill');
    expect(el.textContent).toContain('Background subagent sa-1 finished');
    expect(el.textContent).not.toContain('已注入上下文');
  });
});
```

`ChatMessageItems.tsx` 的 `case 'notice'` 在 `visual-inline` 之后加：

```tsx
if (msg.customType === 'subagent-settled') return <SubagentSettledPill content={msg.content} />;
```

视觉：复用 `MutedLine` + 展开后 `LazyMarkdown`，和 `NoticePill` 同结构，标题 = `content` 第一行。

- [ ] **步骤 4：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/SubagentSettledPill.test.tsx
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit
```

- [ ] **步骤 5：Commit** `feat(chat): 渲染 subagent-settled notice`

---

### 任务 10：`cancel` 写 `tornDown` + 冷恢复拒绝

**文件：**
- 修改：`extensions/multi-agent/cancel.ts`
- 修改：`extensions/multi-agent/cancel.test.ts`
- 修改：`extensions/multi-agent/activation.ts`（`coldResume` 读 tornDown）

- [ ] **步骤 1：** `cancel` 除了现有 `inflight.abort()` + `registry.finish(cancelled)`，还要：

  1. `disposeActivation(id, "cancel")`——关 inbox、发 `aborted` notice（规格 §6.4）。**这一步别漏**，否则 cancel 之后父会话等不到任何回执。
  2. 写 `tornDown: true` 到子 `subagent_meta`。

第 2 步的写入通道分两种，**优先用第一种**：

- 驻留中（有 Activation）：用该 Activation 自己的 `sessionManager.appendCustomEntry("subagent_meta", { ...上一份, tornDown: true })`。
- 无驻留（子进程 / 已结算 / 重启后）：才 `SessionManager.open(childPath)` 写。

原因：驻留子级的 `SessionManager` 在内存里持有 `fileEntries` 并会继续 append；父进程另开一个 `SessionManager.open` 写同一个文件，两边各自 persist 会互相覆盖。同一份 `SessionManager` 写才安全。

`childPath` 来自任务 5 给 registry 加的 `sessionPath` 列；拿不到就跳过写 `tornDown`（此时 Activation 也已不存在，冷恢复本来就无从谈起）。

冷恢复见到 `tornDown` 抛 `NOT_RESUMABLE`。

- [ ] **步骤 5：Commit** `feat(multi-agent): cancel 后禁止冷恢复`

---

## 规格覆盖

| 规格章节 | 任务 |
| --- | --- |
| §5.1 meta 字段 | 7 |
| §5.2 / §6.3 结算 | 4 |
| §5.3 / §8.2 host | 3、8 |
| §6.1 spawn 启动 | 7 |
| §6.2 inbox | 2 |
| §6.4 重启 reap | 5 |
| §6.4 cancel tornDown | 10 |
| §7 相邻工具 | 6 |
| §8.1 / §8.3 notice UI | 1、9 |
| §8.4 子进程 notice | 7 |
| §4 origin 类型 | 1 |
| 规格 3 目录写入 | 不做 |

---

## 完成定义

- `action: "run"` 行为与规格 1 金样例一致
- embedded `spawn` 首次 idle 后 JSONL 还在、Activation 已拆、父会话有且仅有一条 `subagent-settled`
- `send_message` 相邻成功、越权失败
- sidecar 重启：continuable JSONL 在 → registry `done` + `sidecar restarted`，父会话没有新 notice
