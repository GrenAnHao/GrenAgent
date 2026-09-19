# Goal 回到 Pi 会话 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 Goal 的权威源迁回当前 Pi 会话 JSONL；`/goal`、条、三个模型工具和 `agent_settled` 续跑读写同一份折叠快照；拆除 AgentData Goal 领域；完成由工作模型自报。

**架构：** 纯扩展 `extensions/goal`：`appendEntry("goal", event)` 写状态事件，`sendMessage({ customType: "goal-round" })` 写续跑正文。折叠器只认带 `kind` 的 `goal` 事件。桌面只消费 `setStatus` 投影，条上动作走同一套 `/goal`（`pi.prompt`），禁止 `agentDataApi.goals`。无 Coordinator、无 Goal worker、无独立裁判。

**技术栈：** TypeScript ESM、vitest、React、antd-style、@lobehub/ui、zustand。只测 `extensions/goal` 与 Electron；不升级 tauri Goal 条。

**上游规格：** `docs/superpowers/specs/2026-09-13-goal-on-session-design.md`  
条的视觉与宽度仍以 `docs/superpowers/specs/2026-09-13-goal-bar-and-chat-width-design.md` §2 / §2.4 为准，但其中 CAS `edit`、project 通道、`judging`、AgentData 历史作废。

**不要执行：** `docs/superpowers/plans/2026-09-13-goal-bar-and-chat-width.md`（旧线，权威源仍是 AgentData）。

---

## 动工前必读

- **不要隔离 worktree**，在当前仓库原地做。工作区很脏：每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。
- Windows 提交用 PowerShell here-string，不要 bash `EOF` heredoc。
- 禁止 emoji。图标用 `@lobehub/ui` 的 `Icon` / `ActionIcon` + `lucide-react`。
- **不要改** `tauri-agent` 的 Goal 条交互。拆除 IPC 后若 tauri 仍引用已删符号，只切断引用让它能编译。
- 每个任务 commit 前：

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx tsc --noEmit
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit
```

- `pi.appendEntry` 返回 `void`：不检查返回值，不伪造失败回执。快照一律再 `foldGoal(getEntries())`。
- 续跑钩子是 `pi.on("agent_settled")`：`on()` 类型里已有该重载，**不需要**类型断言。`AgentSettledEvent` **只有 `type` 字段**，没有 `messages`。禁止退回 `agent_end` 做重入。
- abort / error 判定不能直接读 `agent_settled` 的 event（它不带 messages）。`agent_end` 带 `{ messages: AgentMessage[] }` 且先于 settle 触发：在 `agent_end` 里把本轮 assistant 的 `stopReason` 记进进程内捕获，`agent_settled` 读取并在判定后清空。`stopReason` 在 `AgentMessage` 联合类型上，需按 `role === "assistant"` 收窄再读。
- 一轮只 settle 一次（`_emitAgentSettled` 只有 run 的 finally 一个调用点）；重入消息在 settle 之后发出，进入下一次 run 的 flush，不要在测试里断言 flush 顺序。
- `sendMessage` 续跑正文必须带 `customType: "goal-round"`、`display: false`、`details: { goalId, revision, round }`、`{ triggerTurn: true }`。类型没有 `details` 就断言写入，禁止改成只靠 content 解析来源。
- 配置键 `goal.autoContinueOnOpen`：值 **`"true"` 为开，其余（含 `"1"` / `"false"` / 缺失）为关**。现有设置开关默认写 `'1'`/`'0'`，本键必须写 `'true'` / `''`，见任务 10。
- 工具权限：**不要**用 `origin === 'goal'` 当 Goal Round。拆除 sidecar 后续跑仍是交互会话，`origin` 是 `main`。Goal Round 只认进程内 pending `{ goalId, revision, round }`。`subagent` 一律拒。删除 `PI_GOAL_WORKER` / `PI_SYSTEM_WORKER` / `PI_HUMAN_ORIGIN_TOKEN` 在 Goal 工具里的判定。
- `blocked` 阈值常量名 `GOAL_BLOCKED_MIN_ROUNDS = 3`。`blockedReason.code` 固定 `'model-reported'`。
- `maxRounds` 默认 `256`，首版无改上限命令。达上限文案逐字：`已达轮次上限`。
- 回执不含 `goalId` / `revision`。条上不显示轮次。
- 条动作走 `pi.prompt(workspace, '/goal …')`，与输入框同一 handler；禁止 `agentDataApi.goals`。
- 旧 AgentData Goal **不迁**。会话没有 `kind` 事件就是没有 Goal。
- 旧计划里的 CAS `edit`、project 通道放行、`judging`、`MemoryClient` `goal.*` **不要做**。

**测试命令（按任务裁剪）：**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run goal
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run <本任务列出的测试文件>
```

UI 以 vitest 为准，本计划不要求点真窗。

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `extensions/goal/types.ts` | 事件、快照、八种 `kind`、工具动作 |
| `extensions/goal/fold.ts` | `foldGoal`：只折 `customType==="goal"` 且 `kind` 合法的条目 |
| `extensions/goal/parse.ts` | `/goal` 解析表 |
| `extensions/goal/config.ts` | `readAutoContinueOnOpen()` 唯一读取函数 |
| `extensions/goal/receipt.ts` | 状态句与 notify 回执（不含 id/revision） |
| `extensions/goal/prompt.ts` | Goal Round 完成 / 阻塞审计正文 |
| `extensions/goal/auth.ts` | 真人 `input` 标记、Goal Round pending、origin / 权限 |
| `extensions/goal/continue.ts` | `agent_settled` 重入、上限 notify 去重 |
| `extensions/goal/history.ts` | 抽屉用：`goal` 事件 + `goal-round` 正文 |
| `electron-agent/src/stores/commandInputStore.ts` | 按 `sessionId` 的本地 `command-input` |
| `electron-agent/src/features/chat/input/goalElapsed.ts` | `Ns` / `Nm` / `Nh` |
| `electron-agent/src/features/chat/chatStyles.test.ts` | 宽度常量断言 |

重写：

| 文件 | 职责 |
| --- | --- |
| `extensions/goal/index.ts` | 命令、hooks、`setStatus`、`appendEntry` |
| `extensions/goal/tools.ts` | 只留 `get_goal` / `create_goal` / `update_goal` |
| `extensions/goal/contracts.ts` | 与 `types.ts` 对齐或改为再导出（不要留 AgentData 形状） |
| `electron-agent/src/stores/goalStore.ts` | 快照改为规格 §2.3 + 信封 `sessionId` |
| `electron-agent/src/features/extensionUi/ExtensionUiHost.tsx` | 解析新快照；去掉 `judging` / `error` / `goal://status` 依赖 |
| `electron-agent/src/features/chat/input/GoalPill.tsx` | 顶行条；动作走 `/goal` |
| `electron-agent/src/features/chat/input/SessionGoalDrawer.tsx` | 历史来自 `setStatus.history`；改条件走 `/goal edit` |
| `electron-agent/src/features/chat/input/editor/MessageEditor.tsx` | 条挪进 `surface` 顶行 |
| `electron-agent/src/features/chat/ChatView.tsx` | 执行性 `/goal`：toast + `command-input` |
| `electron-agent/src/features/chat/groupMessages.ts` | `DisplayMessage` 增加 `command-input`（列表拼接，不进 `groupMessages`） |
| `electron-agent/src/lib/pi.ts` | 去掉对 `electron/agentData/goalContracts` 的 Goal 类型依赖 |
| `docs/architecture.md` | 「会话 Goal」改写为会话事件流 |

删除（不留兼容、不做 migrate）：

| 文件 |
| --- |
| `extensions/goal/state.ts` 及 `state.test.ts`（由 `fold.ts` 取代） |
| `extensions/goal/judge.ts` / `judge.test.ts` / `llm.ts` / `llm.test.ts` |
| `electron-agent/electron/agentData/goalStore.ts` / `goalStore.test.ts` / `goalContracts.ts` |
| `electron-agent/electron/agentData/runtime.goal.test.ts` |
| `electron-agent/electron/app/goalCoordinator.ts` / `goalCoordinator.test.ts` / `goalJudge.ts` / `goalJudge.test.ts` |
| `electron-agent/electron/agent/goalHost.ts` / `goalHost.test.ts` / `createGoalHandle.ts` |
| 渲染层 `agentDataApi.goals` 及 IPC `agentData_goal_*` |

`extensions/goal/package.json` 的 description 去掉「independent judge」。

---

### 任务 1：事件类型与折叠器

**文件：**
- 创建：`extensions/goal/types.ts`
- 创建：`extensions/goal/fold.ts`
- 创建：`extensions/goal/fold.test.ts`
- 删除（本任务末步）：不要先删 `state.ts`，等任务 4 接上命令再删，避免中间无法编译。本任务只新增。

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/goal/fold.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { foldGoal, isGoalEventKind } from "./fold.js";
import type { GoalEvent } from "./types.js";

const at = "2026-09-13T00:00:00.000Z";

function ev(event: GoalEvent) {
  return { type: "custom", customType: "goal", data: event, timestamp: event.at };
}

describe("isGoalEventKind", () => {
  it("accepts the eight kinds and rejects others", () => {
    for (const kind of ["create", "edit", "pause", "resume", "complete", "blocked", "clear", "round"] as const) {
      expect(isGoalEventKind(kind)).toBe(true);
    }
    expect(isGoalEventKind("begin_judging")).toBe(false);
    expect(isGoalEventKind(undefined)).toBe(false);
  });
});

describe("foldGoal", () => {
  it("folds create → edit → pause → resume → round → complete", () => {
    const snapshot = foldGoal([
      ev({ kind: "create", goalId: "g1", revision: 1, at, payload: { condition: "  写完  ", maxRounds: 8 } }),
      ev({ kind: "edit", goalId: "g1", revision: 2, at, payload: { condition: "写完并通过测试" } }),
      ev({ kind: "pause", goalId: "g1", revision: 3, at, payload: { reason: "user" } }),
      ev({ kind: "resume", goalId: "g1", revision: 4, at, payload: {} }),
      ev({ kind: "round", goalId: "g1", revision: 5, at, payload: { round: 1 } }),
      ev({ kind: "complete", goalId: "g1", revision: 6, at, payload: { summary: "done" } }),
    ]);
    expect(snapshot).toMatchObject({
      goalId: "g1",
      revision: 6,
      condition: "写完并通过测试",
      status: "complete",
      roundsStarted: 1,
      maxRounds: 8,
    });
    expect(snapshot?.activation).toBeUndefined();
  });

  it("clears the projection but keeps later create on a new goalId at revision 1", () => {
    const snapshot = foldGoal([
      ev({ kind: "create", goalId: "old", revision: 1, at, payload: { condition: "旧" } }),
      ev({ kind: "clear", goalId: "old", revision: 2, at, payload: {} }),
      ev({ kind: "create", goalId: "new", revision: 1, at, payload: { condition: "新" } }),
    ]);
    expect(snapshot).toMatchObject({ goalId: "new", revision: 1, condition: "新", status: "active", roundsStarted: 0, maxRounds: 256 });
  });

  it("returns undefined after clear with no later create", () => {
    expect(foldGoal([
      ev({ kind: "create", goalId: "g", revision: 1, at, payload: { condition: "x" } }),
      ev({ kind: "clear", goalId: "g", revision: 2, at, payload: {} }),
    ])).toBeUndefined();
  });

  it("sorts by revision and ignores goal-round bodies and kind-less goal entries", () => {
    const snapshot = foldGoal([
      { type: "custom", customType: "goal-round", data: { kind: "create", goalId: "x", revision: 9, payload: { condition: "假" } } },
      { type: "custom", customType: "goal", data: { condition: "legacy", react: 2 } },
      ev({ kind: "edit", goalId: "g", revision: 2, at, payload: { condition: "后写先出现" } }),
      ev({ kind: "create", goalId: "g", revision: 1, at, payload: { condition: "先" } }),
      { type: "message", customType: "goal-round", content: "续跑", details: { goalId: "g", revision: 2, round: 1 } },
    ]);
    expect(snapshot).toMatchObject({ goalId: "g", revision: 2, condition: "后写先出现", status: "active", roundsStarted: 0 });
  });

  it("rejects illegal transitions by skipping the event", () => {
    const snapshot = foldGoal([
      ev({ kind: "create", goalId: "g", revision: 1, at, payload: { condition: "c" } }),
      ev({ kind: "complete", goalId: "g", revision: 2, at, payload: {} }),
      ev({ kind: "resume", goalId: "g", revision: 3, at, payload: {} }),
    ]);
    expect(snapshot).toMatchObject({ status: "complete", revision: 2 });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run goal/fold.test.ts
```

预期：FAIL，找不到 `./fold.js`。

- [ ] **步骤 3：最少实现**

`types.ts`：

```ts
export const GOAL_EVENT_KINDS = ["create", "edit", "pause", "resume", "complete", "blocked", "clear", "round"] as const;
export type GoalEventKind = (typeof GOAL_EVENT_KINDS)[number];
export type GoalStatus = "active" | "paused" | "blocked" | "complete";
export type GoalActivation = "armed" | "disarmed";

export interface GoalEvent {
  kind: GoalEventKind;
  goalId: string;
  revision: number;
  at: string;
  payload: Record<string, unknown>;
}

export interface GoalBlockedReason {
  code: "model-reported";
  message: string;
}

export interface GoalSnapshot {
  goalId: string;
  revision: number;
  condition: string;
  status: GoalStatus;
  roundsStarted: number;
  maxRounds: number;
  createdAt: string;
  updatedAt: string;
  activation?: GoalActivation;
  blockedReason?: GoalBlockedReason;
}

export const DEFAULT_MAX_ROUNDS = 256;
export const GOAL_BLOCKED_MIN_ROUNDS = 3;
```

`fold.ts`：`isGoalEventKind`；`readGoalEvent(entry)` 要求 `customType === "goal"` 且 `data.kind` 为八种之一、`goalId` 非空、`revision` 为正整数；`foldGoal` 抽出事件后按 `revision` 升序应用：

| kind | 规则 |
| --- | --- |
| `create` | 无当前投影，或上一事件是 `clear` 之后：新快照 `active`，`condition` trim，`maxRounds` 缺省 256，非法 maxRounds 当 256 |
| `edit` | 有投影则改 `condition`（trim 后 1..4000，否则跳过），阶段不变 |
| `pause` | 仅 `active` → `paused` |
| `resume` | 仅 `paused` / `blocked` → `active`，去掉 `blockedReason` |
| `complete` | 仅 `active` → `complete` |
| `blocked` | 仅 `active`，且 `payload.message` 非空 → `blocked` |
| `clear` | 投影清空（函数返回过程中用哨兵，结束后 `undefined`） |
| `round` | 有投影则 `roundsStarted = Number(payload.round)`（须为 >=1 的整数） |

`activation` **不要**写进折叠结果。条件 trim；`create` 的空条件跳过整条事件。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run goal/fold.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "extensions/goal/types.ts" "extensions/goal/fold.ts" "extensions/goal/fold.test.ts"
git commit -m @"
feat(goal): 会话事件折叠为快照

"@
```

---

### 任务 2：`/goal` 解析与回执文案

**文件：**
- 创建：`extensions/goal/parse.ts`
- 创建：`extensions/goal/parse.test.ts`
- 创建：`extensions/goal/receipt.ts`
- 创建：`extensions/goal/receipt.test.ts`

- [ ] **步骤 1：编写失败的测试**

`parse.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { parseGoalArgs } from "./parse.js";

describe("parseGoalArgs", () => {
  it("parses the command table", () => {
    expect(parseGoalArgs("")).toEqual({ type: "query" });
    expect(parseGoalArgs("   ")).toEqual({ type: "query" });
    expect(parseGoalArgs("pause")).toEqual({ type: "pause" });
    expect(parseGoalArgs("PAUSE")).toEqual({ type: "pause" });
    expect(parseGoalArgs("resume")).toEqual({ type: "resume" });
    expect(parseGoalArgs("clear")).toEqual({ type: "clear" });
    expect(parseGoalArgs("reset")).toEqual({ type: "clear" });
    expect(parseGoalArgs("edit")).toEqual({ type: "error", code: "MISSING_CONDITION" });
    expect(parseGoalArgs("edit   ")).toEqual({ type: "error", code: "MISSING_CONDITION" });
    expect(parseGoalArgs("edit 写完")).toEqual({ type: "edit", condition: "写完" });
    expect(parseGoalArgs("EDIT 写完")).toEqual({ type: "edit", condition: "写完" });
    expect(parseGoalArgs("pause after verify")).toEqual({ type: "create", condition: "pause after verify" });
    expect(parseGoalArgs("写完并通过测试")).toEqual({ type: "create", condition: "写完并通过测试" });
  });

  it("rejects empty or overlong conditions after trim", () => {
    expect(parseGoalArgs("a".repeat(4001))).toEqual({ type: "error", code: "INVALID_PARAMS" });
    expect(parseGoalArgs(`edit ${"a".repeat(4001)}`)).toEqual({ type: "error", code: "INVALID_PARAMS" });
  });
});
```

`receipt.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { formatGoalReceipt, goalStatusSentence } from "./receipt.js";
import type { GoalSnapshot } from "./types.js";

const base: GoalSnapshot = {
  goalId: "g", revision: 2, condition: "写完", status: "active",
  roundsStarted: 3, maxRounds: 256, createdAt: "t", updatedAt: "t",
};

describe("goalStatusSentence", () => {
  it("uses activation only for active", () => {
    expect(goalStatusSentence({ ...base, activation: "armed" })).toBe("执行中的目标");
    expect(goalStatusSentence({ ...base, activation: "disarmed" })).toBe("未运行的目标");
    expect(goalStatusSentence({ ...base, status: "paused" })).toBe("已暂停的目标");
    expect(goalStatusSentence({ ...base, status: "blocked", blockedReason: { code: "model-reported", message: "缺密钥" } })).toBe("受阻的目标");
    expect(goalStatusSentence({ ...base, status: "complete" })).toBe("已完成的目标");
  });
});

describe("formatGoalReceipt", () => {
  it("omits goalId and revision and includes blocked reason", () => {
    const text = formatGoalReceipt({
      ...base,
      status: "blocked",
      activation: "disarmed",
      blockedReason: { code: "model-reported", message: "缺密钥" },
    });
    expect(text).toContain("受阻的目标");
    expect(text).toContain("写完");
    expect(text).toContain("3/256");
    expect(text).toContain("disarmed");
    expect(text).toContain("缺密钥");
    expect(text).not.toContain("goalId");
    expect(text).not.toMatch(/\bg\b/);
    expect(text).not.toContain("revision");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run goal/parse.test.ts goal/receipt.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：最少实现**

解析（`args.trim()` 后）：整段小写等于 `pause` / `resume` / `clear` / `reset` / `edit` 才是控制词；`edit` + 空白 + 条件为 edit；其余非空为 create。条件 trim 后长度 0 或 >4000 → `INVALID_PARAMS`。整段 `edit`（或 edit 后 trim 为空）→ `MISSING_CONDITION`。

回执至少四行：状态句、条件、`roundsStarted/maxRounds`、`activation`（无则 `disarmed`）；`blocked` 再加 `blockedReason.message`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run goal/parse.test.ts goal/receipt.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "extensions/goal/parse.ts" "extensions/goal/parse.test.ts" "extensions/goal/receipt.ts" "extensions/goal/receipt.test.ts"
git commit -m @"
feat(goal): 解析 /goal 并格式化回执

"@
```

---

### 任务 3：`readAutoContinueOnOpen`

**文件：**
- 创建：`extensions/goal/config.ts`
- 创建：`extensions/goal/config.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { __resetForTest } from "../_shared/runtime-config.js";
import { readAutoContinueOnOpen } from "./config.js";

afterEach(() => {
  __resetForTest();
  delete process.env["goal.autoContinueOnOpen"];
});

describe("readAutoContinueOnOpen", () => {
  it("is true only for the exact string true", () => {
    process.env["goal.autoContinueOnOpen"] = "true";
    expect(readAutoContinueOnOpen()).toBe(true);
    process.env["goal.autoContinueOnOpen"] = "TRUE";
    expect(readAutoContinueOnOpen()).toBe(false);
    process.env["goal.autoContinueOnOpen"] = "1";
    expect(readAutoContinueOnOpen()).toBe(false);
    process.env["goal.autoContinueOnOpen"] = "false";
    expect(readAutoContinueOnOpen()).toBe(false);
    delete process.env["goal.autoContinueOnOpen"];
    expect(readAutoContinueOnOpen()).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run goal/config.test.ts
```

预期：FAIL。

- [ ] **步骤 3：最少实现**

```ts
import { getConfig } from "../_shared/runtime-config.js";

export function readAutoContinueOnOpen(): boolean {
  return getConfig("goal.autoContinueOnOpen") === "true";
}
```

禁止在 `index.ts` / `continue.ts` 里再写裸比较。

- [ ] **步骤 4–5：测试通过并 commit**

```powershell
git add "extensions/goal/config.ts" "extensions/goal/config.test.ts"
git commit -m @"
feat(goal): 封装重开自动继续读取

"@
```

---

### 任务 4：会话写入与 `/goal` 命令

**文件：**
- 创建：`extensions/goal/session.ts`（append、折算、进程内 activation、`setStatus`）
- 修改：`extensions/goal/index.ts`
- 重写：`extensions/goal/index.test.ts`
- 修改：`extensions/goal/contracts.ts` 改为 `export type { ... } from "./types.js"`
- 本任务仍可暂留 `state.ts`，任务 5 删。

- [ ] **步骤 1：重写失败的命令测试**

`index.test.ts` 不再注入 `MemoryClient`。`setup()` mock：

```ts
appendEntry: (t: string, d: unknown) => { entries.push({ type: "custom", customType: t, data: d }); },
sendMessage: (...a: unknown[]) => calls.send.push(a),
on: (e: string, h: Function) => { handlers[e] = h; },
registerCommand / registerTool
```

`ctx.sessionManager.getEntries = () => entries`，`getSessionId = () => "session-a"`。

断言：

1. 注册 `goal`，hooks 含 `session_start`、`input`、`agent_end`（**仅**捕获本轮 assistant `stopReason`：不发消息、不重入）、`agent_settled`（唯一续跑钩子）。
2. 命令 description 含「查询」且不含「清除」作为裸命令语义。
3. `handler("")` 无目标 → notify `当前没有生效的目标。` + `warning`。
4. `handler("写完")` → `appendEntry("goal", { kind: "create", revision: 1, payload: { condition: "写完" } })`；`setStatus("goal", json)` 的 snapshot `status==="active"`；notify `info` 且文本含「执行中的目标」。
5. 已有未 complete 再 create → 不 append，notify error，提示先 edit 或 clear。
6. `handler("complete 之后仍可建")`：先 create、再手动往 entries 推 `complete` 事件、再 handler 新条件 → 新 `goalId`，revision 1（有意不先 clear）。
7. `handler("pause after verify")` → create，条件逐字 `pause after verify`。
8. `handler("pause")` → `kind: "pause"`，之后 status 投影 `paused`，activation 推送 `disarmed`。
9. `handler("resume")` 在 paused 上 → `kind: "resume"`，activation `armed`。
10. 先 create，再把 entries 折成 active 但进程 activation 置 `disarmed`，`handler("resume")` → **不** append `resume`，只把 activation 打成 `armed`。
11. `handler("clear")` → `kind: "clear"`，`setStatus` 的 snapshot 为 `null` / 缺省。
12. `handler("edit")` → error「缺少新的目标条件」类文案。
13. 无目标 `handler("edit 新")` → error「当前没有生效的目标」。
14. 成功 / 失败 notify 级别：成功 `info`，失败 `error`，没目标 `warning`。
15. 回执 JSON / 文本不含 `goalId` 字段名（`setStatus` 内部快照可以含，notify 文本不能含）。

`setStatus` 载荷写死：

```ts
{
  schemaVersion: 1,
  sessionId: string,
  workspace?: string,
  snapshot: (GoalSnapshot & { activation: "armed" | "disarmed" }) | null,
  history: ReturnType<typeof listGoalHistory>,
}
```

无目标时 `snapshot: null`。`history` 本任务可先 `[]`，任务 12 前补上（任务 8 会先做 `history.ts`）。若本任务想一次做完，见任务 8 的 `listGoalHistory`，命令测试只断言 `schemaVersion` 与 `snapshot`。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run goal/index.test.ts
```

预期：FAIL（仍注册 `agent_end`、仍走 RPC）。

- [ ] **步骤 3：实现命令面**

`session.ts` 职责：

- `readSnapshot(ctx)` = `foldGoal(ctx.sessionManager.getEntries())`。
- `activation` 进程内 `Map<sessionKey, "armed" | "disarmed">`，key 用 `getSessionId()`。
- `nextRevision(snapshot)` = `snapshot ? snapshot.revision + 1 : 1`。
- `newGoalId()` = `crypto.randomUUID()`。
- `writeEvent(pi, ctx, event)`：`pi.appendEntry("goal", event)`，再 `readSnapshot`。
- `pushStatus(ctx)`：按上面信封 `setStatus`。
- 人 `pause`：写事件，activation=`disarmed`。
- 人 `resume`：`paused`/`blocked` 写事件并 `armed`；`active` 只 `armed`。
- `create`：已有且 `status !== "complete"` 拒绝；否则新 id、revision 1、`armed`。
- `complete` 后的投影仍在，再 `create` 放行。
- `session_start`：默认 `disarmed`；`readAutoContinueOnOpen() && status==="active"` 则 `armed`。

`index.ts`：删 `MemoryClient`、`GoalPort`、`injectedClient`。`registerGoalTools(pi)` 不再传 client（任务 5 改签名，本任务可先让 tools 仍编译：若 tools 还依赖 MemoryClient，先把 `registerGoalTools` 从 index 拿掉、任务 5 再接回——**不要**留 RPC 空壳。本任务 index 只 `registerCommand` + hooks，tools 下一任务再 `registerGoalTools`）。

命令 handler：`parseGoalArgs` → 上述动作 → `formatGoalReceipt` / 错误码文案。`INVALID_PARAMS` 用 `error`。

`input`：`setGoalHumanInput(true)`（任务 5 的 `auth.ts`；本任务可先在 `index.ts` 里空函数，任务 5 替换）。为避免两次改 hooks，本任务就创建 `auth.ts` 的 `setGoalHumanInput` / `clearGoalTurnMarks` 空实现，任务 5 填权限。

- [ ] **步骤 4：测试通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run goal/index.test.ts
```

- [ ] **步骤 5：Commit**

```powershell
git add "extensions/goal/session.ts" "extensions/goal/index.ts" "extensions/goal/index.test.ts" "extensions/goal/contracts.ts"
git commit -m @"
feat(goal): /goal 改为会话事件写入

"@
```

---

### 任务 5：三个工具与权限

**文件：**
- 创建：`extensions/goal/auth.ts`
- 创建：`extensions/goal/auth.test.ts`
- 重写：`extensions/goal/tools.ts`
- 重写：`extensions/goal/tools.test.ts`
- 修改：`extensions/goal/index.ts`（`registerGoalTools`、`input` / `agent_settled` 清标记）
- 删除：`extensions/goal/state.ts`、`state.test.ts`（确认无引用后）

- [ ] **步骤 1：编写失败的测试**

`auth.test.ts`（纯函数，不调工具）：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { runInWorkspace } from "../_shared/workspace-context.js";
import {
  __resetGoalAuthForTest,
  assertToolCaller,
  clearGoalTurnMarks,
  hasGoalRound,
  hasHumanInput,
  setGoalHumanInput,
  setGoalRoundPending,
} from "./auth.js";

afterEach(() => {
  __resetGoalAuthForTest();
  delete process.env.PI_GOAL_WORKER;
  delete process.env.PI_IS_SUBAGENT;
});

const ws = { origin: "main" as const, workspace: "/repo", cwd: "/repo", config: {} };

describe("goal tool auth", () => {
  it("rejects subagent origin", () => {
    process.env.PI_IS_SUBAGENT = "1";
    expect(() => assertToolCaller()).toThrow("GOAL_TOOL_ORIGIN");
  });

  it("does not treat PI_GOAL_WORKER as authority", () => {
    process.env.PI_GOAL_WORKER = "1";
    runInWorkspace(ws, () => {
      expect(hasHumanInput()).toBe(false);
      expect(hasGoalRound({ goalId: "g", revision: 1, round: 1 })).toBe(false);
    });
  });

  it("human mark lives until agent_settled", () => {
    runInWorkspace(ws, () => {
      setGoalHumanInput();
      expect(hasHumanInput()).toBe(true);
      clearGoalTurnMarks();
      expect(hasHumanInput()).toBe(false);
    });
  });

  it("pending round matches exactly and dies after settle", () => {
    runInWorkspace(ws, () => {
      setGoalRoundPending({ goalId: "g", revision: 2, round: 3 });
      expect(hasGoalRound({ goalId: "g", revision: 2, round: 3 })).toBe(true);
      expect(hasGoalRound({ goalId: "g", revision: 2, round: 2 })).toBe(false);
      clearGoalTurnMarks();
      expect(hasGoalRound({ goalId: "g", revision: 2, round: 3 })).toBe(false);
    });
  });
});
```

`tools.test.ts`：`registerGoalTools(pi)` **不传** MemoryClient。`execute` 里用真实 `session.ts` + 内存 entries，或把 `write` 注入。推荐：tools 调 `session.ts` 的导出，测试用与命令测试相同的 pi mock。

必须覆盖：

1. 注册名恰好 `["get_goal","create_goal","update_goal"]`，没有 `block` / `begin_judging` / `request_goal_completion`。
2. 无真人：`create_goal` / `update_goal` 的 `edit|pause|resume` 抛 `GOAL_TOOL_HUMAN`。
3. `setGoalHumanInput()` 后 `create_goal({ condition: "x" })` 成功，结果带 `goalId`/`revision`/`activation`。
4. `update_goal` `action:"resume"` 在 `paused` 上抛 `GOAL_TOOL_RESUME_PAUSED`（有真人也不行）。
5. `update_goal` `action:"complete"`：无真人且无 pending → `GOAL_TOOL_ROUND`；`setGoalRoundPending` 匹配当前 `roundsStarted` 则成功。
6. pending 被 `clearGoalTurnMarks` 后，旧 round 的 complete/blocked 抛 `GOAL_TOOL_ROUND`。
7. `blocked`：`roundsStarted < 3` 抛 `GOAL_TOOL_BLOCKED`；`>=3` 且 `blockedReason.message` 非空才成功。字段名是 `blockedReason`，不是 `blocked_reason`。
8. `get_goal` 无目标返回 `null`（`details: null`）。
9. `PI_GOAL_WORKER=1` 不能让 create 成功。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run goal/auth.test.ts goal/tools.test.ts
```

- [ ] **步骤 3：实现**

`assertToolCaller`：`resolveToolOrigin() === "subagent"` → `GOAL_TOOL_ORIGIN`。不要读 Goal worker env。

`create`/`edit`/`pause`/`resume`：`hasHumanInput()` 否则 `GOAL_TOOL_HUMAN`。

`complete`/`blocked`：`hasHumanInput() || hasGoalRound({ goalId, revision, round: snapshot.roundsStarted })` 否则 `GOAL_TOOL_ROUND`。

`resume` + `status==="paused"` → `GOAL_TOOL_RESUME_PAUSED`。

`blocked`：`roundsStarted >= GOAL_BLOCKED_MIN_ROUNDS` 且 `blockedReason?.message?.trim()`，否则 `GOAL_TOOL_BLOCKED`。写入 payload `{ message }`，code 在折叠时固定。

`update_goal` 参数：`goalId`、`revision`、`action: edit|pause|resume|complete|blocked`，可选 `condition`、`blockedReason`。revision 必须等于当前快照，否则 `VERSION_CONFLICT`。

`create_goal` 参数：`condition`，可选 `maxRounds`。不要 `continuousIntentEvidence`。

`index.ts`：`input` 里 `event.source === "extension"` 不当真人；`interactive` / `rpc` 调 `setGoalHumanInput()`。`agent_settled` **先** `clearGoalTurnMarks()`（续跑任务 6 在清除之后再决定是否重入；pending 必须在本轮工具执行之后、重入发送之前按任务 6 的顺序处理——见下）。

权限标记寿命：工具在当轮 `agent_settled` 之前执行，所以 settle 时先跑续跑判定（要用 pending），**再** clear。任务 6 把顺序写死为：续跑函数开头读 pending/human 副本，结尾 `clearGoalTurnMarks()`。本任务 `agent_settled` 只 clear 也可以，任务 6 改成先 continue 再 clear。

删 `state.ts` / `state.test.ts`。

- [ ] **步骤 4–5：通过并 commit**

```powershell
git add "extensions/goal/auth.ts" "extensions/goal/auth.test.ts" "extensions/goal/tools.ts" "extensions/goal/tools.test.ts" "extensions/goal/index.ts" "extensions/goal/state.ts" "extensions/goal/state.test.ts"
git commit -m @"
feat(goal): 工具改为会话写入并收紧权限

"@
```

若 `git add` 已删文件，用 `git add -u -- extensions/goal/state.ts extensions/goal/state.test.ts`。

---

### 任务 6：`agent_settled` 续跑与完成审计正文

**文件：**
- 创建：`extensions/goal/prompt.ts`
- 创建：`extensions/goal/prompt.test.ts`
- 创建：`extensions/goal/continue.ts`
- 创建：`extensions/goal/continue.test.ts`
- 修改：`extensions/goal/index.ts`、`index.test.ts`
- 删除：`extensions/goal/judge.ts`、`judge.test.ts`、`llm.ts`、`llm.test.ts`

- [ ] **步骤 1：编写失败的测试**

`prompt.test.ts`：`buildGoalRoundPrompt({ condition, round, maxRounds })` 必须包含当前条件、要求对着工作区核需求、禁止靠记忆 `complete`、`blocked` 须过连续阈值（文案含 `3` 或 `GOAL_BLOCKED_MIN_ROUNDS`）。

`continue.test.ts` 测纯函数 `decideGoalContinuation(input)`：

```ts
type Stop = { stopReason?: string };

function decideGoalContinuation(input: {
  snapshot: GoalSnapshot | undefined;
  activation: "armed" | "disarmed";
  assistantStops: Stop[];
  alreadyNotifiedMaxRounds: boolean;
}): { action: "none" | "reenter" | "max-rounds"; nextRound?: number }
```

用例：

| 输入 | 结果 |
| --- | --- |
| 无 snapshot | `none` |
| `paused` / `blocked` / `complete` | `none` |
| `active` + `disarmed` | `none` |
| `active` + `armed` + 任一 `stopReason==="aborted"` | `none` |
| `active` + `armed` + 任一 `stopReason==="error"` | `none` |
| `active` + `armed` + `roundsStarted >= maxRounds` | `max-rounds` |
| 同上且 `alreadyNotifiedMaxRounds` | `none`（调用方不再 notify） |
| `active` + `armed` + 正常结束 | `reenter`，`nextRound = roundsStarted + 1` |

中止 **不等于** pause：函数不得要求写 pause 事件。

`index.test.ts` 补集成：

1. create 后 `activation=armed`，先 `handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx)`，再 `handlers.agent_settled({}, ctx)` → `appendEntry` 含 `kind:"round"`，`sendMessage` 第一参 `customType==="goal-round"`、`display===false`、`details` 匹配 `{ goalId, revision, round }`，第二参 `{ triggerTurn: true }`。
2. 同样先 `agent_end` 注入 `stopReason:"aborted"` / `"error"` 再 settle → 不 send、不写 round，activation 仍 armed。
2b. 只 settle 而**没有**先 `agent_end`（无捕获记录）→ 按正常结束处理，允许重入。
3. `roundsStarted` 已是 `maxRounds` → 不 send；第一次 notify `已达轮次上限` `warning` 或 `info`；第二次 settle 不再 notify。
4. 重入前 `setGoalRoundPending`，settle 结束（含不重入）后 pending 被清。

- [ ] **步骤 2：跑红**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run goal/prompt.test.ts goal/continue.test.ts goal/index.test.ts
```

- [ ] **步骤 3：实现**

`continue.ts` 的 `onAgentSettled(event, ctx, pi)` 顺序：

1. 读进程内「本轮 stopReason 捕获」：由 `agent_end` 写入（遍历 `event.messages`，`role === "assistant"` 的收 `stopReason`），本函数读后**立即清空**该捕获，避免污染下一轮。没有捕获记录视为正常结束（不要扫历史会话里更早的 aborted）。
2. `decideGoalContinuation`。
3. `max-rounds`：进程内 `Set` 记 `${sessionId}:${goalId}:${revision}`，notify 一次「已达轮次上限」；**不**改阶段。
4. `reenter`：`writeEvent` `round`，`setGoalRoundPending`，`sendMessage`。
5. **最后** `clearGoalTurnMarks()`（步骤 4 的 pending 是给下一轮工具用的，不能在本函数清刚刚 set 的 pending）。

因此 clear 的是**上一轮**标记。实现：函数入口先把「本轮是否重入」算完；`clearGoalTurnMarks()` 在 set pending **之前**调用；然后若 reenter 再 set pending。

`continue.ts` 另导出 `recordRunStopReasons(messages)` / `takeRunStopReasons()`：只收 `role === "assistant"` 的 `stopReason`（`aborted` / `error` / 其它），进程内按 session key 存，`take` 后清空。`index.ts` 注册 `agent_end`：**只**调 `recordRunStopReasons(event.messages)`，不写事件、不发消息、不重入。

`session_start`（本任务只武装，空闲立刻重入放任务 7）：默认 disarmed；`readAutoContinueOnOpen() && active` → armed。

删 judge / llm 及其测试。`package.json` description 改为会话目标，去掉 independent judge。

- [ ] **步骤 4–5：通过并 commit**

```powershell
git add "extensions/goal/prompt.ts" "extensions/goal/prompt.test.ts" "extensions/goal/continue.ts" "extensions/goal/continue.test.ts" "extensions/goal/index.ts" "extensions/goal/index.test.ts" "extensions/goal/package.json" "extensions/goal/judge.ts" "extensions/goal/judge.test.ts" "extensions/goal/llm.ts" "extensions/goal/llm.test.ts"
git commit -m @"
feat(goal): 在本会话 agent_settled 后续跑

"@
```

---

### 任务 7：重开自动继续与空闲立刻重入

**文件：**
- 修改：`extensions/goal/index.ts`、`index.test.ts`

- [ ] **步骤 1：失败测试**

1. 默认（无配置）：entries 里已有 active create，`session_start` 后 `setStatus` 的 `activation==="disarmed"`，`sendMessage` 未被调用。
2. `process.env["goal.autoContinueOnOpen"]="true"`：同样 entries，`session_start` 后 `activation==="armed"`，并写出 `round` + `sendMessage`（会话空闲：测试里没有 in-flight 标记即视为空闲）。
3. 配置为 `"1"`：与默认相同，不重入。
4. 阶段 `paused` 即使 `"true"` 也不 armed、不重入。

测前 `afterEach` 调 `__resetForTest()`（runtime-config）并删 env。

- [ ] **步骤 2–5：实现、通过、commit**

`session_start`：折算 → 设 activation → `pushStatus` → 若 armed 且 active 且空闲，走与 `onAgentSettled` 相同的 `reenter` 路径（不要复制一份 sendMessage，抽 `reenterGoalRound(pi, ctx, snapshot)`）。

空闲判定：本扩展不维护 streaming 标志则「`session_start` 即空闲」。不要在 `agent_start` 里自动重入。

```powershell
git add "extensions/goal/index.ts" "extensions/goal/index.test.ts" "extensions/goal/continue.ts" "extensions/goal/session.ts"
git commit -m @"
feat(goal): 打开重开自动继续时武装并续跑

"@
```

---

### 任务 8：历史列表（抽屉数据）

**文件：**
- 创建：`extensions/goal/history.ts`
- 创建：`extensions/goal/history.test.ts`
- 修改：`extensions/goal/session.ts`（`pushStatus` 带上 `history`）

- [ ] **步骤 1：失败测试**

`listGoalHistory(entries)`：

- `customType==="goal"` 且合法 kind → `{ source: "event", kind, revision, at, payload }`
- `customType==="goal-round"` → `{ source: "round", goalId, revision, round, content? }`（从 `data` / `details` / `content` 能读到的都收）
- 无 kind 的旧 `{ condition, react }` **不**进历史
- 顺序按条目出现顺序

- [ ] **步骤 2–5：实现、`pushStatus` 带 history、commit**

```powershell
git add "extensions/goal/history.ts" "extensions/goal/history.test.ts" "extensions/goal/session.ts"
git commit -m @"
feat(goal): 折叠抽屉所需的事件与续跑史

"@
```

---

### 任务 9：前端快照类型与 `setStatus` 解析

**文件：**
- 修改：`electron-agent/src/stores/goalStore.ts`
- 修改：`electron-agent/src/stores/goalStore.test.ts`
- 修改：`electron-agent/src/features/extensionUi/ExtensionUiHost.tsx`
- 修改：`electron-agent/src/features/extensionUi/ExtensionUiHost.test.tsx`
- 修改：`electron-agent/src/lib/pi.ts`（`GoalStatusEnvelope.snapshot` 改用前端类型；可删 `onGoalStatus` 若已无发射方——本任务先留 listen，任务 15 再删）

前端 `GoalSnapshot` 写死为：

```ts
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

export interface GoalSnapshot {
  goalId: string;
  sessionId: string;
  revision: number;
  condition: string;
  status: GoalStatus;
  roundsStarted: number;
  maxRounds: number;
  createdAt: string;
  updatedAt: string;
  activation: 'armed' | 'disarmed';
  blockedReason?: { code: string; message: string };
  history?: GoalHistoryItem[];
}
```

`sessionId` 只给 zustand 索引用，来自信封，不是折叠字段。不要再从 `electron/agentData/goalContracts` import。

- [ ] **步骤 1：改 `goalStore.test.ts` fixture 为新字段**（`roundsStarted`、`activation`，去掉 `workspace`/`roundsUsed`/`judging`）。迟到 revision 保护可保留。

`ExtensionUiHost.test.tsx`：

- v1 + `snapshot` 含 `activation`/`roundsStarted` → `setSnapshot`
- 旧 `{ condition, paused, react }` 忽略
- `status: "judging"` 忽略
- `snapshot: null` → `setSnapshot(sessionId, undefined)`
- `history` 原样进 snapshot（或并存于 store；条不展示、抽屉读）

`parseGoalStatus` 只接受 `active|paused|blocked|complete`。缺 `activation` 时默认 `'disarmed'`。

- [ ] **步骤 2–5：改测试与实现、commit**

```powershell
git add "electron-agent/src/stores/goalStore.ts" "electron-agent/src/stores/goalStore.test.ts" "electron-agent/src/features/extensionUi/ExtensionUiHost.tsx" "electron-agent/src/features/extensionUi/ExtensionUiHost.test.tsx" "electron-agent/src/lib/pi.ts"
git commit -m @"
feat(goal): 前端快照改为会话投影形状

"@
```

本任务之后 `GoalPill.test.tsx` / `MessageEditor.test.tsx` / `SessionGoalDrawer.test.tsx` 会因旧 fixture 红。下一任务立刻改，不要在本任务扩大 diff。若 tsc 因旧 fixture 字段失败，本任务可先把那些测试文件的 snapshot 字面量改成新字段（不改行为断言），并列入本 commit。

---

### 任务 10：设置项 `goal.autoContinueOnOpen`

**文件：**
- 修改：`electron-agent/src/features/settings/settingsSchema.ts`
- 修改：`electron-agent/src/features/settings/settingsSchema.test.ts`
- 修改：`electron-agent/src/features/settings/SettingField.tsx`（及现有 SettingField 测试，若有）

- [ ] **步骤 1：失败测试**

`settingsSchema.test.ts` 的 general keys 末尾增加 `'goal.autoContinueOnOpen'`。字段：

```ts
{
  key: 'goal.autoContinueOnOpen',
  label: 'Goal 重开后自动继续',
  type: 'boolean',
  default: '0',
  description: '打开后，重启或打开已有进行中目标的会话时自动武装并续跑。默认关。仅写入 true 生效。',
  storeBoolean: 'true-empty',
}
```

给 `SettingField` 增加可选 `storeBoolean?: 'one-zero' | 'true-empty'`，默认 `'one-zero'`（旧开关仍写 `'1'`/`'0'`）。`'true-empty'`：开写 `'true'`，关写 `''`。

若没有 SettingField 单测，新建 `SettingField.test.tsx`：`storeBoolean: 'true-empty'` 时打开 Switch 调用 `onChange('true')`，关上 `onChange('')`。

- [ ] **步骤 2–5：实现、通过、commit**

显示态：`storeBoolean==='true-empty'` 时 `on = value === 'true'`（不要把 `'1'` 显示成开）。

```powershell
git add "electron-agent/src/features/settings/settingsSchema.ts" "electron-agent/src/features/settings/settingsSchema.test.ts" "electron-agent/src/features/settings/SettingField.tsx"
git commit -m @"
feat(settings): 写入 Goal 重开自动继续开关

"@
```

---

### 任务 11：执行性 `/goal` 与 `command-input`

**文件：**
- 修改：`electron-agent/src/features/chat/input/commandClassification.ts`
- 修改：`electron-agent/src/features/chat/input/commandClassification.test.ts`
- 创建：`electron-agent/src/stores/commandInputStore.ts`
- 创建：`electron-agent/src/stores/commandInputStore.test.ts`
- 修改：`electron-agent/src/features/chat/groupMessages.ts`
- 修改：`electron-agent/src/features/chat/ChatMessageItems.tsx`
- 修改：`electron-agent/src/features/chat/ChatListView.tsx`
- 修改：`electron-agent/src/features/chat/ChatListView.test.tsx`
- 修改：`electron-agent/src/features/chat/ChatView.tsx`

- [ ] **步骤 1：失败测试**

`commandClassification.test.ts`：

```ts
expect(isExecutiveCommand('goal')).toBe(true);
expect(isExecutiveCommand('GOAL')).toBe(true);
expect(isExecutiveCommandMessage('/goal 写完')).toBe(true);
expect(isExecutiveCommandMessage('/skill:goal')).toBe(false);
```

注释里「goal 不放」删掉。

`commandInputStore.test.ts`：`append(sessionId, { command: '/goal', rest: '写完' })` 后 `list(sessionId)` 为一条 `{ kind:'command-input', id, command, rest }`；`list('other')` 空；`dropSession` 后消失。

`ChatView`：找到现有 executive 测试则追加；否则在 `ChatListView.test.tsx` 里往 store append 后断言列表出现 `/goal` 与 `写完`。`groupMessages` 的输入 **没有** `command-input`，拼接发生在 `ChatListView`：`[...groupMessages(messages), ...list(sessionId)]`。

`ChatView.handleSend`：executive 成功后 `append`（`rest` 为去掉命令 token 后的原文 trim）。「已执行 /goal」toast **保留**。不 `pushUserMessage`、不 `awaitingResponse`。

`sessionId`：`handleSend` 里已有 `getState`，把 `sessionId` 读出再 append；没有 sessionId 就不插行，仍 toast。

`renderMessageBody` 增加 `case 'command-input'`：命令标签 + `rest`。`data-testid="command-input"`。

- [ ] **步骤 2–5：实现、通过、commit**

```powershell
git add "electron-agent/src/features/chat/input/commandClassification.ts" "electron-agent/src/features/chat/input/commandClassification.test.ts" "electron-agent/src/stores/commandInputStore.ts" "electron-agent/src/stores/commandInputStore.test.ts" "electron-agent/src/features/chat/groupMessages.ts" "electron-agent/src/features/chat/ChatMessageItems.tsx" "electron-agent/src/features/chat/ChatListView.tsx" "electron-agent/src/features/chat/ChatListView.test.tsx" "electron-agent/src/features/chat/ChatView.tsx"
git commit -m @"
feat(chat): /goal 作为执行性命令并留下本地行

"@
```

---

### 任务 12：经过时间、Goal 条、顶行附着

**文件：**
- 创建：`electron-agent/src/features/chat/input/goalElapsed.ts`
- 创建：`electron-agent/src/features/chat/input/goalElapsed.test.ts`
- 重写：`electron-agent/src/features/chat/input/GoalPill.tsx`
- 重写：`electron-agent/src/features/chat/input/GoalPill.test.tsx`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.tsx`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx`
- 修改：`electron-agent/src/features/chat/input/SessionGoalDrawer.tsx`
- 修改：`electron-agent/src/features/chat/input/SessionGoalDrawer.test.tsx`

- [ ] **步骤 1：`goalElapsed` 失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { formatGoalElapsed } from './goalElapsed';

describe('formatGoalElapsed', () => {
  const now = Date.parse('2026-09-13T00:01:00.000Z');
  it('uses 1s below one second', () => {
    expect(formatGoalElapsed('2026-09-13T00:00:59.500Z', now)).toBe('1s');
  });
  it('uses seconds then minutes then hours', () => {
    expect(formatGoalElapsed('2026-09-13T00:00:10.000Z', now)).toBe('50s');
    expect(formatGoalElapsed('2026-09-13T00:00:00.000Z', now)).toBe('1m');
    expect(formatGoalElapsed('2026-09-12T22:01:00.000Z', now)).toBe('2h');
  });
});
```

- [ ] **步骤 2：GoalPill 失败测试（mock `pi.prompt`，禁止 mock `agentDataApi.goals`）**

`makeSnapshot` 用新类型。`useGoalStore.setSnapshot` 预置，不再 `goalGet`。

| 用例 | 断言 |
| --- | --- |
| `active`+`armed` | 文案「执行中的目标」；灯 `data-testid="goal-lamp"` style 含 `#3dd68c` 与 `box-shadow`；有「暂停目标」「编辑目标」「清除目标」「展开目标详情」 |
| `active`+`disarmed` | 「未运行的目标」；灯 `#8b919c` 无光晕；「恢复目标」 |
| `paused` | 「已暂停的目标」；灯 `#f5a524`；恢复 |
| `blocked` | 「受阻的目标」；灯 `#f53f3f`；行 `title` 为 `blockedReason.message` |
| `complete` | 「已完成的目标」；灯 `#3dd68c` 且 `box-shadow` 为 `none`；无暂停/编辑；有清除/放大 |
| 无 snapshot | 无 `goal-pill` |
| 编辑 | 输入预填；Enter → `pi.prompt(workspace, '/goal edit 新条件')`；Esc 不 prompt；空白禁用保存 |
| 清除 | `confirm` 为真才 prompt `'/goal clear'`；连点 busy 只一次 |
| 暂停 / 恢复 | `'/goal pause'` / `'/goal resume'` |
| 无轮次 | `queryByText(/\/256/)` 空 |

`window.confirm` mock，文案逐字 `清除当前目标？`。

`aria-label` 逐字：暂停目标、恢复目标、编辑目标、清除目标、展开目标详情。

条不要自己 `agentDataApi.goals.get`。数据只来 zustand。

行内结构：8px 圆灯、状态句、条件（`title` 为全文，blocked 时整行 title 优先）、`·`、经过时间。

- [ ] **步骤 3：MessageEditor**

`GoalPill` 从 `surface` **外**挪到 `surface` **内**第一行。顶行与 chips/编辑器之间 1px `colorBorderSecondary`。`MessageEditor.test.tsx`：有 snapshot 时 `goal-pill` 是 `surface` 的后代（给 surface 加 `data-testid="composer-surface"`）。

- [ ] **步骤 4：抽屉**

删除 `agentDataApi.goals.update` / `history`。改条件：`pi.prompt(workspace, '/goal edit ' + draft)`。清除：`'/goal clear'` + 同一 confirm。历史渲染 `snapshot.history`：event 一行 kind+时间；round 一行「第 N 轮」+ 正文摘要。无 `admin.goal.history`。`complete` 可清除。删 pause/resume 两步 hack 与 `block`+condition。

- [ ] **步骤 5：跑测试、commit**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/goalElapsed.test.ts src/features/chat/input/GoalPill.test.tsx src/features/chat/input/editor/MessageEditor.test.tsx src/features/chat/input/SessionGoalDrawer.test.tsx
```

```powershell
git add "electron-agent/src/features/chat/input/goalElapsed.ts" "electron-agent/src/features/chat/input/goalElapsed.test.ts" "electron-agent/src/features/chat/input/GoalPill.tsx" "electron-agent/src/features/chat/input/GoalPill.test.tsx" "electron-agent/src/features/chat/input/editor/MessageEditor.tsx" "electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx" "electron-agent/src/features/chat/input/SessionGoalDrawer.tsx" "electron-agent/src/features/chat/input/SessionGoalDrawer.test.tsx"
git commit -m @"
feat(chat): Goal 条改走扩展投影与 /goal

"@
```

---

### 任务 13：加宽 `CHAT_CONTENT_WIDTH`

**文件：**
- 修改：`electron-agent/src/features/chat/chatStyles.ts`
- 创建：`electron-agent/src/features/chat/chatStyles.test.ts`

- [ ] **步骤 1：失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { CHAT_CONTENT_WIDTH } from './chatStyles';

describe('CHAT_CONTENT_WIDTH', () => {
  it('matches the Codex-aligned content column expression', () => {
    expect(CHAT_CONTENT_WIDTH).toBe('min(100%, 1120px, max(760px, 86%))');
  });
});
```

- [ ] **步骤 2–4：改常量与注释**

```ts
/**
 * 对话内容列宽度：按容器百分比伸缩，不用 vw。
 *   - 86%：主体比例，两侧留白接近 Codex；
 *   - 下限 760px：容器 ≤883px 时 86% 失效，走固定下限（窄于旧 61.8%/620：≤760px 由 100% 铺满）；
 *   - 上限 1120px：再宽只增加留白；
 *   - min 的 100%：比 760px 更窄时铺满。
 * 消息列与输入区共用同一表达式。
 */
export const CHAT_CONTENT_WIDTH = 'min(100%, 1120px, max(760px, 86%))';
```

不改 `paddingInline`，不改引用方式。

- [ ] **步骤 5：Commit**

```powershell
git add "electron-agent/src/features/chat/chatStyles.ts" "electron-agent/src/features/chat/chatStyles.test.ts"
git commit -m @"
feat(chat): 加宽会话正文列

"@
```

---

### 任务 14：拆除 AgentData Goal 存储与 RPC

**文件：**
- 删除：`electron-agent/electron/agentData/goalStore.ts`、`goalStore.test.ts`、`goalContracts.ts`、`runtime.goal.test.ts`
- 修改：`electron-agent/electron/agentData/storage.ts`、`storage.test.ts`
- 修改：`electron-agent/electron/agentData/runtime.ts`
- 修改：`electron-agent/electron/app/agentDataService.ts`、`agentDataService.test.ts`
- 修改：`electron-agent/electron/ipc/register.ts`、`commandCoverage.test.ts`
- 修改：`electron-agent/src/lib/agentData.ts`、`agentData.test.ts`

- [ ] **步骤 1：失败测试先写拆除断言**

`storage.test.ts`：migrate 之后

```ts
expect(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'goal_%'").all()).toHaveLength(0);
```

旧文件若已建表：`migrate()` 里 `DROP TABLE IF EXISTS goal_turn_leases; DROP TABLE IF EXISTS goal_events; DROP TABLE IF EXISTS goal_snapshots;`，并删对应 index 的 `CREATE`。Memory / Wiki / permission 表断言仍在。

`commandCoverage.test.ts`：数组去掉全部 `agentData_goal_*`。另加：

```ts
await expect(invoke({}, { command: 'agentData_goal_get', args: { sessionId: 's', workspace: '/repo' } })).rejects.toThrow();
```

`agentData.test.ts`：删除 `goals.*` 用例；`expect(agentDataApi.goals).toBeUndefined()`。

`runtime.ts`：删除 `goalMethod`、`onGoalEvent`、`this.goals`。project/admin 路由不再认 `goal.*` / `admin.goal.*`。保留 memory/wiki/codegraph/任务/审批。

- [ ] **步骤 2：跑红（旧测试仍期望 Goal 表 / IPC）**

- [ ] **步骤 3：删实现与引用，改测试到绿**

`agentDataService` 去掉全部 `goal*` / `bindGoalSession` / `onGoalEvent`。

- [ ] **步骤 4：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/agentData/storage.test.ts electron/ipc/commandCoverage.test.ts src/lib/agentData.test.ts electron/app/agentDataService.test.ts electron/agentData/runtime.ts
```

`runtime` 无单独 test 文件则跑仍存在的 `electron/agentData/*.test.ts`。再跑一条 Memory 回归（现有 memory 测试文件名以仓库为准，例如 `runtime.memory.test.ts` 或 wiki 测试）。

- [ ] **步骤 5：Commit（只 add 本任务文件）**

```powershell
git commit -m @"
refactor(agent-data): 拆除 Goal 表与 RPC

"@
```

---

### 任务 15：拆除 Coordinator / GoalHost / 迁移

**文件：**
- 删除：`goalCoordinator.ts`、`goalCoordinator.test.ts`、`goalJudge.ts`、`goalJudge.test.ts`、`goalHost.ts`、`goalHost.test.ts`、`createGoalHandle.ts`
- 修改：`electron-agent/electron/main.ts`
- 修改：`electron-agent/src/lib/pi.ts`（删除 `onGoalStatus` / `goal://status` 若无发射）
- 修改：`electron-agent/src/features/extensionUi/ExtensionUiHost.tsx`（去掉 `onGoalStatus`）
- 修改：`electron-agent/electron/app/piRuntimeService.ts`、`piRuntimeService.test.ts`

- [ ] **步骤 1：`piRuntimeService.test.ts` 先改构造**

去掉 `GoalHostPort`、`emptyGoalHost()`、所有 `migrateLegacyGoal` / `bindGoalSession` / `unbindGoalSession` / `source: 'goal'` / `PI_GOAL_WORKER` 用例。删除「Goal session ≠ 可见 session」类测试。保留交互 session、fork、prompt 回归。构造函数不再传 `goalHost`。

`workerEnv`：删除 `PI_GOAL_WORKER`；`PI_HUMAN_ORIGIN_TOKEN` 可留（其它扩展若仍读），Goal 工具已不读它。

删除 `readLegacyGoalEntry`、`migrateLegacyGoal` 私方法。

`main.ts`：删除 `GoalCoordinator`、`GoalHost`、`createGoalHandle`、`onGoalEvent`、`migrateLegacyGoal`、`admin.goal.*`。

- [ ] **步骤 2：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/piRuntimeService.test.ts
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit
```

- [ ] **步骤 3：Commit**

```powershell
git commit -m @"
refactor(runtime): 拆除 Goal worker 与 Coordinator

"@
```

---

### 任务 16：删除 `PI_GOAL_WORKER` 回退

**文件：**
- 修改：`extensions/_shared/desktop-control.ts`、`desktop-control.test.ts`
- 修改：`extensions/_shared/workspace-isolation.test.ts`（若仍设 `PI_GOAL_WORKER`）

- [ ] **步骤 1：改测试**

`resolveToolOrigin`：无 ALS 且 `PI_IS_SUBAGENT=1` → `subagent`；`PI_GOAL_WORKER=1` → **`main`**（不再是 `goal`）。删「无 ALS 时 PI_GOAL_WORKER=1 → goal」用例。

- [ ] **步骤 2：实现：删 `desktop-control.ts` 里 env 回退两行**

`workspace-context.ts` 的 ALS `origin: "goal"` 类型可留（宿主若仍传）；不要从 env 伪造。

- [ ] **步骤 3：**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run _shared/desktop-control.test.ts _shared/workspace-context.test.ts _shared/workspace-isolation.test.ts
```

- [ ] **步骤 4：Commit**

```powershell
git add "extensions/_shared/desktop-control.ts" "extensions/_shared/desktop-control.test.ts" "extensions/_shared/workspace-isolation.test.ts"
git commit -m @"
refactor(origin): 不再用 Goal worker 环境变量回退

"@
```

---

### 任务 17：架构文档与残留引用

**文件：**
- 修改：`docs/architecture.md`「会话 Goal」整节
- 全库检索：`admin.goal`、`agentData_goal_`、`GoalCoordinator`、`createGoalHandle`、`PI_GOAL_WORKER`、`begin_judging`、`request_goal_completion`、`MemoryClient`+`goal.`

- [ ] **步骤 1：把 architecture 该节换成：**

Goal 绑在当前 Pi 会话。权威源是 JSONL 里 `customType: "goal"` 的带 `kind` 事件，扩展折叠为快照；续跑正文是 `customType: "goal-round"`。完成由本会话工作模型 `update_goal(complete|blocked)` 自报，没有独立裁判，没有 AgentData Goal 表 / Coordinator / Goal worker。重开默认 `disarmed`。`goal.autoContinueOnOpen === "true"` 且阶段 `active` 时武装。旧 AgentData Goal 不迁移。

- [ ] **步骤 2：检索残留，能删的删，文档里过期链接改指本规格。不要改 `docs/superpowers/specs/2026-09-06-session-goal-design.md` 历史正文，只在文首已有「被取代」处保持。**

- [ ] **步骤 3：tauri**

`tauri-agent` 的 `GoalPill` / `goalStore` / `ExtensionUiHost` **不升级**。确认它**没有** import 已删的 `agentData_goal_*`（当前没有）。若本次改了共享类型导致 tauri `tsc` 红，只改 import 断口，不改条 UI。

```powershell
cd "D:\OneDrive\Project Files\Pi\tauri-agent"; npx tsc --noEmit
```

红了再最小切断。

- [ ] **步骤 4：Commit**

```powershell
git add "docs/architecture.md"
git commit -m @"
docs(architecture): Goal 改回会话事件流

"@
```

---

## 规格覆盖自检

| 规格 | 任务 |
| --- | --- |
| §2.1 存储、`goal` vs `goal-round`、折叠忽略规则、单写者、clear 后空投影 | 1、8 |
| §2.2 阶段 / activation / `goal.autoContinueOnOpen` 序列化 | 3、4、6、7、10 |
| §2.3 快照字段 | 1、9 |
| §2.4 事件载荷与合法转换 | 1、4、5 |
| §3.1 `/goal` 解析表、回执、complete 后直建、条上只武装不写 resume | 2、4、12 |
| §3.1 执行性命令、toast、`command-input` | 11 |
| §3.2 三工具、权限、`blockedReason`、`GOAL_TOOL_RESUME_PAUSED`、pending 在 settle 后失效 | 5、6 |
| §3.3 完成审计提示词 | 6 |
| §4 `agent_settled` 重入、aborted/error（经 `agent_end` 捕获 `stopReason`）、达上限 notify 去重、`goal-round` details、与 steer 并发可接受 | 6 |
| §4 `autoContinueOnOpen` session_start 武装且空闲立刻重入；fork 新进程先 disarmed | 7 |
| §5 条视觉、灯、经过时间、aria、complete 留下、无 judging/error、历史两类条目 | 8、12 |
| §5 `CHAT_CONTENT_WIDTH` | 13 |
| §6 拆除 AgentData Goal / Coordinator / GoalHost / migrate / MemoryClient / `PI_GOAL_WORKER` | 14、15、16 |
| §6 `appendEntry` 写失败不伪造回执 | 4（实现约束，无测试可伪造成功） |
| §6 不升级 tauri 条，只防挂死 | 17 |
| §7 测试清单 | 各任务；主进程 Memory/Wiki 回归在任务 14 |
| §8 非目标（不进内核、不 Cordis、无裁判、无 token 预算、不迁数据、无快捷键、单写者） | 未立项，不要做 |

### 占位符扫描

无「待定 / TODO / 类似任务 N / 补充验证」。设置序列化、续跑钩子、`stopReason` 捕获与读取时机、pending 清除顺序、条动作入口均已写死。

### 类型一致性

- 事件 `kind` 八种与折叠器、`parse` 无关（parse 是命令面）。
- 工具字段 `blockedReason`（不是 `blocked_reason`）。
- 快照 `roundsStarted`（前端不再用 `roundsUsed`）。
- 配置键 `goal.autoContinueOnOpen`，读取只认 `"true"`。
- 错误码：`GOAL_TOOL_ORIGIN` / `GOAL_TOOL_HUMAN` / `GOAL_TOOL_ROUND` / `GOAL_TOOL_RESUME_PAUSED` / `GOAL_TOOL_BLOCKED` / `VERSION_CONFLICT` / `INVALID_PARAMS`。
- `setStatus` 信封：`schemaVersion: 1` + `sessionId` + `snapshot` + `history`。
- `AgentSettledEvent` 只有 `type`：`stopReason` 只能来自 `agent_end.messages`（按 `role === "assistant"` 收窄），进程内捕获后由 `agent_settled` 消费并清空。不要给 `agent_settled` 的 handler 形参编 `messages` 字段。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-09-13-goal-on-session.md`。两种执行方式：

**1. 子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。

**2. 内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
