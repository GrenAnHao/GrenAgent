# A2 Plan Mode（只读规划模式）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 为 GrenAgent/Pi 增加只读规划模式：`/plan` 切换进入只读探索（只 read/grep/find/ls/fetch_url + 白名单 bash），引导 agent 在 `Plan:` 段输出编号步骤；选择「执行计划」后恢复完整工具并按步骤执行、用 `[DONE:n]` 追踪进度；模式状态在 GrenAgent header 显示徽章（📋 Plan / ▶ 完成数/总数）。

**架构：** 新增 `extensions/plan-mode/`（复用官方纯函数 `utils.ts` 可单测 + 入口 `index.ts` 状态机：`setActiveTools` 切换只读白名单、`tool_call` 拦截写类/危险 bash、`before_agent_start` 注入模式上下文、`turn_end`/`agent_end` 追踪步骤、`session_start` 恢复、`ctx.ui.setStatus` 反映模式）→ 注册进 `allExtensions` 编入 sidecar；前端新增 `planModeStore`（zustand），扩展 `ExtensionUiHost` 消费 `setStatus`（更新 store、不弹模态），`MainColumnHeader` 显示模式徽章。`agent_end` 的「执行/留下」选择复用 A0 已建的 `ExtensionUiHost` select 弹窗。

**技术栈：** TypeScript、Pi `ExtensionAPI`（`setActiveTools`/`getActiveTools`/`appendEntry`/`sendMessage`/`ctx.ui.select`/`ctx.ui.setStatus`）、React、zustand、@lobehub/ui、vitest。

**父 spec：** `docs/superpowers/specs/2026-06-13-grenagent-subproject-a-extensions-safety-design.md`（§4.5 模块 2：plan-mode）

**对官方 `examples/extensions/plan-mode` 的关键修正：**
1. **工具恢复**：官方退出/执行时 `setActiveTools(["read","bash","edit","write"])` 会丢失 GrenAgent 的 todo/kb_search/memory 等扩展工具。本计划在进入 plan 前用 `pi.getActiveTools()` **存档**，退出时 `setActiveTools(savedTools)` **还原**。
2. **去 TUI 依赖**：去掉 `registerShortcut`（pi-tui `Key`）、`setWidget`、`/todos` 命令（与 A1 的 todo 概念区分）；UI 走 React。
3. **简化选择**：`agent_end` 的选择仅「执行计划 / 留在规划模式」（去掉 `Refine` 以免依赖 `ctx.ui.editor`；用户要细化直接在输入框补充）。

**A0/A1 经验沿用：** extensions 子包无 vitest，用 `tauri-agent/node_modules/.bin/vitest.CMD` 在该目录跑；前端用 tauri-agent 自带 vitest + jsdom。

---

## 文件结构

- 创建 `extensions/plan-mode/utils.ts` — 纯函数：`isSafeCommand`、`extractTodoItems`、`extractDoneSteps`、`markCompletedSteps`、`cleanStepText`、类型 `TodoItem`（搬运官方，可单测）
- 创建 `extensions/plan-mode/utils.test.ts` — 纯函数单测
- 创建 `extensions/plan-mode/index.ts` — extension 入口：状态机 + 工具切换 + 拦截 + 上下文注入 + 步骤追踪 + setStatus
- 创建 `extensions/plan-mode/package.json` — `pi-plan-mode`
- 修改 `extensions/index.ts` — 注册 `planMode` 到 `allExtensions`
- 创建 `tauri-agent/src/stores/planModeStore.ts` — zustand：`{ status?: string; setStatus }`
- 创建 `tauri-agent/src/stores/planModeStore.test.ts`
- 修改 `tauri-agent/src/features/extensionUi/ExtensionUiHost.tsx` — 消费 `setStatus`（plan-mode → store，不弹模态）；交互类（confirm/select/input）维持弹窗
- 修改 `tauri-agent/src/features/extensionUi/ExtensionUiHost.test.tsx` — 增加 setStatus 用例 + 回归
- 修改 `tauri-agent/src/features/layout/MainColumnHeader.tsx` — 显示 `PlanModeBadge`
- 修改 `tauri-agent/src/features/layout/ModuleRail.test.tsx` 无关；新增 `MainColumnHeader.test.tsx`（徽章渲染）
- 重建 sidecar 验证

---

## 任务 1：plan-mode 纯函数 + 单测

**文件：**
- 创建：`extensions/plan-mode/package.json`
- 测试：`extensions/plan-mode/utils.test.ts`
- 创建：`extensions/plan-mode/utils.ts`

- [x] **步骤 1：写 package.json**

```json
{
  "name": "pi-plan-mode",
  "version": "0.1.0",
  "description": "Read-only plan mode for the Pi coding agent (tool gating + numbered plan/step tracking).",
  "private": true,
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "plan-mode"],
  "license": "MIT",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-agent-core": "*",
    "vitest": "^4.1.8"
  }
}
```

- [x] **步骤 2：写失败测试** `extensions/plan-mode/utils.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { extractDoneSteps, extractTodoItems, isSafeCommand, markCompletedSteps } from "./utils.js";

describe("isSafeCommand", () => {
  it("allows read-only commands", () => {
    expect(isSafeCommand("cat file.ts")).toBe(true);
    expect(isSafeCommand("git status")).toBe(true);
    expect(isSafeCommand("ls -la")).toBe(true);
  });
  it("blocks destructive commands", () => {
    expect(isSafeCommand("rm -rf x")).toBe(false);
    expect(isSafeCommand("git commit -m x")).toBe(false);
    expect(isSafeCommand("npm install")).toBe(false);
    expect(isSafeCommand("echo hi > f")).toBe(false);
  });
  it("blocks commands not on the safe allowlist", () => {
    expect(isSafeCommand("some-random-binary")).toBe(false);
  });
});

describe("extractTodoItems", () => {
  it("parses numbered steps under a Plan: header", () => {
    const md = "Here is my plan.\n\nPlan:\n1. Read the config loader\n2. Add a validation step\n3. Write the tests\n";
    const items = extractTodoItems(md);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ step: 1, completed: false });
    expect(items[1].text.toLowerCase()).toContain("validation");
  });
  it("returns empty when there is no Plan: header", () => {
    expect(extractTodoItems("no plan here\n1. nope")).toEqual([]);
  });
});

describe("markCompletedSteps", () => {
  it("marks steps referenced by [DONE:n]", () => {
    const items = extractTodoItems("Plan:\n1. First step here\n2. Second step here\n");
    const n = markCompletedSteps("Did it. [DONE:1]", items);
    expect(n).toBe(1);
    expect(items[0].completed).toBe(true);
    expect(items[1].completed).toBe(false);
  });
  it("extractDoneSteps reads multiple markers", () => {
    expect(extractDoneSteps("[DONE:1] ... [DONE:3]")).toEqual([1, 3]);
  });
});
```

- [x] **步骤 3：运行确认失败** — `cd extensions/plan-mode && & "../../tauri-agent/node_modules/.bin/vitest.CMD" run` → FAIL（模块不存在）

- [x] **步骤 4：实现** `extensions/plan-mode/utils.ts`（搬运官方 `examples/extensions/plan-mode/utils.ts`，逐字复制其内容）

```ts
// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i,
  /\bchmod\b/i, /\bchown\b/i, /\bchgrp\b/i, /\bln\b/i, /\btee\b/i, /\btruncate\b/i,
  /\bdd\b/i, /\bshred\b/i, /(^|[^<])>(?!>)/, />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i, /\bsu\b/i, /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
  /\breboot\b/i, /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
  /^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/, /^\s*grep\b/,
  /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*echo\b/, /^\s*printf\b/, /^\s*wc\b/,
  /^\s*sort\b/, /^\s*uniq\b/, /^\s*diff\b/, /^\s*file\b/, /^\s*stat\b/, /^\s*du\b/,
  /^\s*df\b/, /^\s*tree\b/, /^\s*which\b/, /^\s*whereis\b/, /^\s*type\b/, /^\s*env\b/,
  /^\s*printenv\b/, /^\s*uname\b/, /^\s*whoami\b/, /^\s*id\b/, /^\s*date\b/, /^\s*cal\b/,
  /^\s*uptime\b/, /^\s*ps\b/, /^\s*top\b/, /^\s*htop\b/, /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i, /^\s*python\s+--version/i,
  /^\s*curl\s/i, /^\s*wget\s+-O\s*-/i, /^\s*jq\b/, /^\s*sed\s+-n/i, /^\s*awk\b/,
  /^\s*rg\b/, /^\s*fd\b/, /^\s*bat\b/, /^\s*eza\b/,
];

export function isSafeCommand(command: string): boolean {
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
  const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
  return !isDestructive && isSafe;
}

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (cleaned.length > 50) cleaned = `${cleaned.slice(0, 47)}...`;
  return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
  const items: TodoItem[] = [];
  const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  if (!headerMatch) return items;
  const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
  const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;
  for (const match of planSection.matchAll(numberedPattern)) {
    const text = match[2].trim().replace(/\*{1,2}$/, "").trim();
    if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3) items.push({ step: items.length + 1, text: cleaned, completed: false });
    }
  }
  return items;
}

export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
  const doneSteps = extractDoneSteps(text);
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item) item.completed = true;
  }
  return doneSteps.length;
}
```

- [x] **步骤 5：运行确认通过** — `cd extensions/plan-mode && & "../../tauri-agent/node_modules/.bin/vitest.CMD" run` → PASS

- [x] **步骤 6：Commit**

```bash
git add extensions/plan-mode/utils.ts extensions/plan-mode/utils.test.ts extensions/plan-mode/package.json
git commit -m "feat(plan-mode): safe-command + plan/step extraction pure functions (A2)"
```

---

## 任务 2：plan-mode extension 入口

**文件：**
- 创建：`extensions/plan-mode/index.ts`

- [x] **步骤 1：实现** `extensions/plan-mode/index.ts`

```ts
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.js";

// 进入规划模式时仅保留这些只读工具。
const PLAN_MODE_TOOLS = ["read", "grep", "find", "ls", "bash", "fetch_url"];

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}
function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  let planModeEnabled = false;
  let executionMode = false;
  let todoItems: TodoItem[] = [];
  // 进入 plan 前的完整工具集，退出时还原（避免丢失 todo/kb/memory 等扩展工具）。
  let savedTools: string[] | undefined;

  const updateStatus = (ctx: ExtensionContext) => {
    if (executionMode && todoItems.length > 0) {
      const done = todoItems.filter((t) => t.completed).length;
      ctx.ui.setStatus("plan-mode", `▶ ${done}/${todoItems.length}`);
    } else if (planModeEnabled) {
      ctx.ui.setStatus("plan-mode", "📋 Plan");
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
    }
  };

  const persistState = () => {
    pi.appendEntry("plan-mode", { enabled: planModeEnabled, todos: todoItems, executing: executionMode, savedTools });
  };

  const enterPlan = (ctx: ExtensionContext) => {
    savedTools = pi.getActiveTools();
    planModeEnabled = true;
    executionMode = false;
    todoItems = [];
    pi.setActiveTools(PLAN_MODE_TOOLS);
    ctx.ui.notify(`已进入规划模式（只读）：${PLAN_MODE_TOOLS.join(", ")}`, "info");
    updateStatus(ctx);
    persistState();
  };

  const restoreTools = () => {
    if (savedTools) pi.setActiveTools(savedTools);
  };

  pi.registerCommand("plan", {
    description: "切换规划模式（只读探索）",
    handler: async (_args, ctx) => {
      if (planModeEnabled) {
        planModeEnabled = false;
        restoreTools();
        ctx.ui.notify("已退出规划模式，恢复完整工具。", "info");
        updateStatus(ctx);
        persistState();
      } else {
        enterPlan(ctx);
      }
    },
  });

  pi.on("tool_call", async (event) => {
    if (!planModeEnabled) return undefined;
    if (event.toolName === "bash") {
      const command = String(event.input?.command ?? "");
      if (!isSafeCommand(command)) {
        return { block: true, reason: `规划模式：命令未在只读白名单内，已阻止。先用 /plan 退出规划模式。\n命令：${command}` };
      }
      return undefined;
    }
    if (event.toolName === "write" || event.toolName === "edit") {
      return { block: true, reason: "规划模式：禁止写入/编辑。先用 /plan 退出规划模式。" };
    }
    return undefined;
  });

  pi.on("before_agent_start", async () => {
    if (planModeEnabled) {
      return {
        message: {
          customType: "plan-mode-context",
          content: `[PLAN MODE ACTIVE]
你处于只读规划模式。只能使用 read/grep/find/ls/fetch_url 与白名单只读 bash；不能 edit/write。
请勿尝试修改，仅在 "Plan:" 标题下输出编号步骤：

Plan:
1. 第一步描述
2. 第二步描述
...`,
          display: false,
        },
      };
    }
    if (executionMode && todoItems.length > 0) {
      const remaining = todoItems.filter((t) => !t.completed).map((t) => `${t.step}. ${t.text}`).join("\n");
      return {
        message: {
          customType: "plan-execution-context",
          content: `[EXECUTING PLAN - 完整工具已恢复]
剩余步骤：
${remaining}
按顺序执行；每完成一步在回复中加 [DONE:n] 标记。`,
          display: false,
        },
      };
    }
    return undefined;
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;
    if (markCompletedSteps(getTextContent(event.message), todoItems) > 0) {
      updateStatus(ctx);
      persistState();
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (executionMode && todoItems.length > 0) {
      if (todoItems.every((t) => t.completed)) {
        pi.sendMessage({ customType: "plan-complete", content: "**计划完成！** ✓", display: true }, { triggerTurn: false });
        executionMode = false;
        todoItems = [];
        restoreTools();
        updateStatus(ctx);
        persistState();
      }
      return;
    }
    if (!planModeEnabled || !ctx.hasUI) return;

    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (lastAssistant) {
      const extracted = extractTodoItems(getTextContent(lastAssistant));
      if (extracted.length > 0) todoItems = extracted;
    }
    if (todoItems.length > 0) {
      const list = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
      pi.sendMessage({ customType: "plan-steps", content: `**计划步骤（${todoItems.length}）：**\n\n${list}`, display: true }, { triggerTurn: false });
    }

    const choice = await ctx.ui.select("规划完成 — 下一步？", ["执行计划", "留在规划模式"]);
    if (choice === "执行计划") {
      planModeEnabled = false;
      executionMode = todoItems.length > 0;
      restoreTools();
      updateStatus(ctx);
      persistState();
      const first = todoItems[0]?.text;
      pi.sendMessage(
        { customType: "plan-execute", content: first ? `执行计划，从第一步开始：${first}` : "执行你刚制定的计划。", display: true },
        { triggerTurn: true },
      );
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>;
    const entry = entries.filter((e) => e.type === "custom" && e.customType === "plan-mode").pop();
    const data = entry?.data as { enabled?: boolean; todos?: TodoItem[]; executing?: boolean; savedTools?: string[] } | undefined;
    if (data) {
      planModeEnabled = data.enabled ?? false;
      todoItems = data.todos ?? [];
      executionMode = data.executing ?? false;
      savedTools = data.savedTools;
    }
    if (planModeEnabled) pi.setActiveTools(PLAN_MODE_TOOLS);
    updateStatus(ctx);
  });
}
```

> 注（已核对官方类型 `types.d.ts`）：`pi.getActiveTools()`/`setActiveTools(string[])`、`pi.appendEntry(customType, data)`、`pi.sendMessage({customType,content,display},{triggerTurn})`、`ctx.ui.setStatus(key, text|undefined)`、`ctx.ui.select`/`notify` 均为官方 API。`getEntries()` 返回 `SessionEntry[]`，自定义条目为 `{ type:"custom", customType, data }`，用结构化断言读取。`setStatus` 是单向请求（无 response），前端任务 4 消费。

- [x] **步骤 2：Commit**

```bash
git add extensions/plan-mode/index.ts
git commit -m "feat(plan-mode): tool-gating state machine + plan/exec context + status (A2)"
```

---

## 任务 3：注册并重建 sidecar

**文件：**
- 修改：`extensions/index.ts`

- [x] **步骤 1：注册 planMode**（import 按字母序；导出与数组放 `todo` 之后）

```ts
import planMode from "./plan-mode/index.js";
// import 段：置于 multiAgent 与 safety 之间（字母序 p）。
// export 段与 allExtensions 段：在 safety, todo 之后追加 planMode。
```

实现时先读 `extensions/index.ts` 当前内容，按确切形态对齐：
- `import planMode from "./plan-mode/index.js";`（放在 `import multiAgent ...` 之后、`import safety ...` 之前）
- `export { safety, todo, planMode, knowledgeRag, ... }`
- `allExtensions = [safety, todo, planMode, knowledgeRag, ...]`

- [x] **步骤 2：重建 sidecar**（先确认无 GrenAgent 进程占用 exe）

运行：`cd tauri-agent && node scripts/build-sidecar.mjs`
预期：`GrenAgent sidecar ready: ...`，bun 无 "Could not resolve"。

- [x] **步骤 3：Commit**

```bash
git add extensions/index.ts
git commit -m "feat(plan-mode): register plan-mode extension into sidecar bundle (A2)"
```

---

## 任务 4：前端 planModeStore + ExtensionUiHost 消费 setStatus

**文件：**
- 创建：`tauri-agent/src/stores/planModeStore.ts`
- 测试：`tauri-agent/src/stores/planModeStore.test.ts`
- 修改：`tauri-agent/src/features/extensionUi/ExtensionUiHost.tsx`
- 测试：`tauri-agent/src/features/extensionUi/ExtensionUiHost.test.tsx`

- [x] **步骤 1：写 store** `tauri-agent/src/stores/planModeStore.ts`

```ts
import { create } from 'zustand';

interface PlanModeState {
  /** 当前模式徽章文本（如 "📋 Plan" / "▶ 2/5"）；undefined 表示非规划模式。 */
  status?: string;
  setStatus: (status?: string) => void;
}

export const usePlanModeStore = create<PlanModeState>((set) => ({
  status: undefined,
  setStatus: (status) => set({ status }),
}));
```

- [x] **步骤 2：写 store 测试** `tauri-agent/src/stores/planModeStore.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { usePlanModeStore } from './planModeStore';

beforeEach(() => usePlanModeStore.setState({ status: undefined }));

describe('planModeStore', () => {
  it('sets and clears status', () => {
    usePlanModeStore.getState().setStatus('📋 Plan');
    expect(usePlanModeStore.getState().status).toBe('📋 Plan');
    usePlanModeStore.getState().setStatus(undefined);
    expect(usePlanModeStore.getState().status).toBeUndefined();
  });
});
```

- [x] **步骤 3：改 ExtensionUiHost** — 消费 `setStatus`（plan-mode → store，不弹模态）；仅 confirm/select/input 弹窗

替换 `useEffect` 内的回调，并在顶部 import store：

```tsx
import { usePlanModeStore } from '../../stores/planModeStore';
// ...
  useEffect(() => {
    let un: undefined | (() => void);
    void onPiUiRequest((e) => {
      const method = e.request.method;
      if (method === 'setStatus') {
        const r = e.request as { statusKey?: unknown; statusText?: unknown };
        if (r.statusKey === 'plan-mode') {
          usePlanModeStore.getState().setStatus(typeof r.statusText === 'string' ? r.statusText : undefined);
        }
        return; // 单向状态，不弹模态
      }
      if (method === 'confirm' || method === 'select' || method === 'input') {
        setItem(e);
      }
      // 其他 method（notify/setWidget/setTitle/editor）MVP 忽略
    }).then((fn) => {
      un = fn;
    });
    return () => un?.();
  }, []);
```

> 注：原实现是 `onPiUiRequest((e) => setItem(e))` —— 无条件弹窗。改为按 method 分流：交互类弹窗、setStatus 入 store、其余忽略。A0 的 confirm/select 行为不变（回归测试覆盖）。

- [x] **步骤 4：加 setStatus 测试** — 在 `ExtensionUiHost.test.tsx` 增加用例（mock store + 验证不弹模态）

在文件顶部 mock 段追加 store mock，并加一条测试：

```tsx
// 顶部：与现有 vi.mock('../../lib/pi', ...) 并列
vi.mock('../../stores/planModeStore', () => ({
  usePlanModeStore: { getState: () => ({ setStatus }) },
}));
// 其中 setStatus 用 vi.hoisted：
// const { respond, setStatus } = vi.hoisted(() => ({ respond: vi.fn(() => Promise.resolve()), setStatus: vi.fn() }));

it('routes setStatus(plan-mode) to the store without opening a modal', () => {
  render(<ExtensionUiHost />);
  emit({ workspace: '/ws', request: { id: 's1', method: 'setStatus', statusKey: 'plan-mode', statusText: '📋 Plan' } });
  expect(setStatus).toHaveBeenCalledWith('📋 Plan');
  expect(screen.queryByText('📋 Plan')).toBeNull(); // 不渲染模态
});
```

> 实现时把现有 `const { respond } = vi.hoisted(...)` 扩展为同时提供 `setStatus`（见上方注释），保证 hoist 顺序正确。

- [x] **步骤 5：运行确认通过 + 类型检查**

运行：`cd tauri-agent && & "node_modules/.bin/vitest.CMD" run src/features/extensionUi/ExtensionUiHost.test.tsx src/stores/planModeStore.test.tsx && & "node_modules/.bin/tsc.CMD" --noEmit`
预期：测试 PASS，tsc 退出 0

- [x] **步骤 6：Commit**

```bash
git add tauri-agent/src/stores/planModeStore.ts tauri-agent/src/stores/planModeStore.test.ts tauri-agent/src/features/extensionUi/ExtensionUiHost.tsx tauri-agent/src/features/extensionUi/ExtensionUiHost.test.tsx
git commit -m "feat(plan-mode): planModeStore + ExtensionUiHost setStatus routing (A2)"
```

---

## 任务 5：MainColumnHeader 模式徽章

**文件：**
- 修改：`tauri-agent/src/features/layout/MainColumnHeader.tsx`
- 测试：`tauri-agent/src/features/layout/MainColumnHeader.test.tsx`

- [x] **步骤 1：写失败测试** `MainColumnHeader.test.tsx`

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePlanModeStore } from '../../stores/planModeStore';
import { MainColumnHeader } from './MainColumnHeader';

beforeEach(() => usePlanModeStore.setState({ status: undefined }));
afterEach(cleanup);

describe('MainColumnHeader plan-mode badge', () => {
  it('hides badge when status is undefined', () => {
    render(<MainColumnHeader />);
    expect(screen.queryByTestId('plan-mode-badge')).toBeNull();
  });
  it('shows badge text when status is set', () => {
    usePlanModeStore.setState({ status: '📋 Plan' });
    render(<MainColumnHeader />);
    expect(screen.getByTestId('plan-mode-badge').textContent).toContain('📋 Plan');
  });
});
```

- [x] **步骤 2：运行确认失败** — `cd tauri-agent && & "node_modules/.bin/vitest.CMD" run src/features/layout/MainColumnHeader.test.tsx` → FAIL（无 badge）

- [x] **步骤 3：实现** — 在 `MainColumnHeader.tsx` 加 `PlanModeBadge` 并放入 header `left`

```tsx
import { usePlanModeStore } from '../../stores/planModeStore';

const PlanModeBadge = memo(function PlanModeBadge() {
  const status = usePlanModeStore((s) => s.status);
  if (!status) return null;
  return (
    <span
      data-testid="plan-mode-badge"
      style={{
        fontSize: 12,
        padding: '2px 8px',
        borderRadius: 4,
        background: 'var(--gren-accent-soft, rgba(120,140,255,0.15))',
        color: 'var(--gren-fg, inherit)',
        whiteSpace: 'nowrap',
      }}
    >
      {status}
    </span>
  );
});
```

并把 header 的 `left` 改为同时含侧栏按钮与徽章：

```tsx
export const MainColumnHeader = memo(function MainColumnHeader() {
  return (
    <PanelHeader
      left={
        <>
          <SidebarToggleButton />
          <PlanModeBadge />
        </>
      }
      actions={
        <>
          <MainHeaderActions />
        </>
      }
    />
  );
});
```

- [x] **步骤 4：运行确认通过 + 类型检查**

运行：`cd tauri-agent && & "node_modules/.bin/vitest.CMD" run src/features/layout/MainColumnHeader.test.tsx && & "node_modules/.bin/tsc.CMD" --noEmit`
预期：测试 PASS，tsc 退出 0

- [x] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/layout/MainColumnHeader.tsx tauri-agent/src/features/layout/MainColumnHeader.test.tsx
git commit -m "feat(plan-mode): plan/exec mode badge in main column header (A2)"
```

---

## 自检

**规格覆盖度（对照 spec §4.5）：**
- `/plan` 进入只读规划 → 任务 2（`registerCommand("plan")` + `enterPlan`）✅
- `setActiveTools` 切只读白名单（read/grep/find/ls/fetch_url）→ 任务 2（`PLAN_MODE_TOOLS`）✅
- 拦截写类工具 → 任务 2（`tool_call` block write/edit + 非白名单 bash）✅
- plan→act 切换 → 任务 2（`agent_end` 选择「执行计划」→ 恢复工具 + 执行上下文）✅
- 步骤追踪 → 任务 1（`extractTodoItems`/`markCompletedSteps`）+ 任务 2（`turn_end`/`agent_end`）✅
- header 模式指示（Plan/Act）→ 任务 4（setStatus→store）+ 任务 5（徽章）✅
- 切换按钮 → ⚠️ **MVP 未含**（靠输入框 `/plan`；按钮留作增强）
- 步骤卡片 → ⚠️ **MVP 未含**（plan 步骤经 `sendMessage`/agent 文本呈现 + 徽章进度；专门卡片留作增强）

**占位符扫描：** 任务 3 与任务 4 的「实现时先读/扩展 hoisted」均指向具体现存文件用于对齐，附确切代码；其余代码块可直接落地。

**类型一致性：** `TodoItem` 在 `utils.ts` 定义、`index.ts` 引用一致；`usePlanModeStore` 在任务 4 定义，任务 4（ExtensionUiHost）与任务 5（header）一致引用；`setStatus` 的 `statusKey/statusText` 字段名与 pi RPC `RpcExtensionUIRequest`（`rpc-types.ts`）一致。

**回归：** 任务 4 改 `ExtensionUiHost` 的 ui-request 分流，A0 的 confirm/select 测试需仍通过（步骤 5 一并跑）。

**重要修正复述：** 退出/执行计划时用 `savedTools = getActiveTools()` 还原工具集，避免官方示例把工具砍成 4 个、丢失 todo/kb/memory。
