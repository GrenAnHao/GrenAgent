# A1 Todo 任务清单 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 为 GrenAgent/Pi 增加 todo（任务清单）扩展：LLM 可调用 `todo` 工具 list/add/toggle/clear，状态随 session 分支持久化（存于 tool result `details`，不写外部文件），并在对话流内用 React 卡片显示勾选状态与完成进度。

**架构：** 新增 `extensions/todo/`（纯逻辑 `todo.ts`，无副作用、可单测 + 入口 `index.ts` 用 `pi.registerTool` 注册 `todo` 工具，并用 `session_start`/`session_tree` 从 `ctx.sessionManager.getBranch()` 重建内存状态）→ 注册进 `extensions/index.ts` 的 `allExtensions` 编入 sidecar；前端 `extensionCards.tsx` 新增 `TodoCard`、`toolUtils.ts` 加图标。**不照搬**官方 `todo.ts` 的 TUI 渲染（`renderCall`/`renderResult`）与 `/todos` TUI overlay 命令 —— GrenAgent UI 一律走 React。

**技术栈：** TypeScript、typebox、`@earendil-works/pi-ai`（`StringEnum`）、Pi `ExtensionAPI`、React、`@lobehub/ui`、lucide-react、vitest。

**父 spec：** `docs/superpowers/specs/2026-06-13-grenagent-subproject-a-extensions-safety-design.md`（§4.4 模块 1：todo）

**A0 经验沿用：**
- extensions 子包**未安装 vitest**（非 workspace），纯函数测试用 tauri-agent 已装的 vitest 二进制在该目录下跑：`& "<repo>/tauri-agent/node_modules/.bin/vitest.CMD" run`（vitest 以 cwd 为 root、走默认 node 环境）。
- 状态持久化与官方 `todo.ts` 一致：写入 tool result 的 `details`，`session_start`/`session_tree` 时从分支重建，从而支持 `/tree` fork 后状态正确。
- 工具结果 `details` 会随 `tool_execution_end` 事件到达前端；前端卡片用 `getDetails(result)` 读取（现有 `kb_search`/`memory_*` 卡片即如此）。

---

## 文件结构

- 创建 `extensions/todo/todo.ts` — 纯函数：`applyTodo`（list/add/toggle/clear）、`reconstructFromEntries`、`emptyTodoState`；类型 `Todo`/`TodoState`/`TodoInput`/`TodoResult`/`TodoDetails`
- 创建 `extensions/todo/index.ts` — extension 入口：`registerTool("todo")` + `session_start`/`session_tree` 重建内存状态
- 创建 `extensions/todo/todo.test.ts` — 纯函数单测
- 创建 `extensions/todo/package.json` — `pi-todo`（含 vitest，对齐 `extensions/safety`）
- 修改 `extensions/index.ts` — 注册 `todo` 到 `allExtensions`
- 修改 `tauri-agent/src/features/tools/toolUtils.ts` — `toolMeta` 增加 `todo` 图标
- 修改 `tauri-agent/src/features/tools/extensionCards.tsx` — 新增 `TodoCard` 并注册到 `EXTENSION_CARD_RENDERERS`
- 修改 `tauri-agent/src/features/tools/extensionCards.test.tsx` — `TodoCard` 渲染测试
- 重建 sidecar 验证（`tauri-agent/scripts/build-sidecar.mjs`）

---

## 任务 1：todo 纯逻辑 + 单测

**文件：**
- 创建：`extensions/todo/package.json`
- 测试：`extensions/todo/todo.test.ts`
- 创建：`extensions/todo/todo.ts`

- [x] **步骤 1：写 package.json**（对齐 `extensions/safety`）

```json
{
  "name": "pi-todo",
  "version": "0.1.0",
  "description": "Branch-aware todo list tool for the Pi coding agent (state stored in session tool-result details).",
  "private": true,
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "todo"],
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
    "vitest": "^4.1.8"
  }
}
```

- [x] **步骤 2：写失败测试** `extensions/todo/todo.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { applyTodo, emptyTodoState, reconstructFromEntries } from "./todo.js";

describe("applyTodo", () => {
  it("add appends a todo and bumps nextId", () => {
    const r = applyTodo(emptyTodoState(), { action: "add", text: "write tests" });
    expect(r.state.todos).toEqual([{ id: 1, text: "write tests", done: false }]);
    expect(r.state.nextId).toBe(2);
    expect(r.error).toBeUndefined();
  });
  it("add without text returns an error and keeps state", () => {
    const r = applyTodo(emptyTodoState(), { action: "add" });
    expect(r.error).toBe("text required");
    expect(r.state.todos).toEqual([]);
  });
  it("toggle flips done", () => {
    const s1 = applyTodo(emptyTodoState(), { action: "add", text: "a" }).state;
    const r = applyTodo(s1, { action: "toggle", id: 1 });
    expect(r.state.todos[0].done).toBe(true);
  });
  it("toggle with missing id errors", () => {
    const r = applyTodo(emptyTodoState(), { action: "toggle", id: 9 });
    expect(r.error).toContain("not found");
  });
  it("clear empties and resets nextId", () => {
    const s1 = applyTodo(emptyTodoState(), { action: "add", text: "a" }).state;
    const r = applyTodo(s1, { action: "clear" });
    expect(r.state).toEqual({ todos: [], nextId: 1 });
  });
  it("list does not mutate state", () => {
    const s1 = applyTodo(emptyTodoState(), { action: "add", text: "a" }).state;
    const r = applyTodo(s1, { action: "list" });
    expect(r.state).toBe(s1);
    expect(r.message).toContain("#1");
  });
});

describe("reconstructFromEntries", () => {
  it("applies the latest todo toolResult details", () => {
    const entries = [
      { type: "message", message: { role: "toolResult", toolName: "todo", details: { todos: [{ id: 1, text: "a", done: false }], nextId: 2 } } },
      { type: "message", message: { role: "toolResult", toolName: "todo", details: { todos: [{ id: 1, text: "a", done: true }], nextId: 2 } } },
    ];
    const s = reconstructFromEntries(entries);
    expect(s.todos[0].done).toBe(true);
    expect(s.nextId).toBe(2);
  });
  it("ignores non-todo and non-message entries", () => {
    const entries = [
      { type: "message", message: { role: "assistant" } },
      { type: "compaction" },
      { type: "message", message: { role: "toolResult", toolName: "bash", details: { foo: 1 } } },
    ];
    expect(reconstructFromEntries(entries)).toEqual(emptyTodoState());
  });
});
```

- [x] **步骤 3：运行确认失败** — `cd extensions/todo && & "../../tauri-agent/node_modules/.bin/vitest.CMD" run` → FAIL（模块不存在）

- [x] **步骤 4：实现** `extensions/todo/todo.ts`

```ts
export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

export interface TodoState {
  todos: Todo[];
  nextId: number;
}

export interface TodoInput {
  action: "list" | "add" | "toggle" | "clear";
  text?: string;
  id?: number;
}

export interface TodoResult {
  state: TodoState;
  message: string;
  error?: string;
}

/** 写入 tool result 的 details 形状（前端 TodoCard 读取）。 */
export interface TodoDetails {
  action: TodoInput["action"];
  todos: Todo[];
  nextId: number;
  error?: string;
}

export const emptyTodoState = (): TodoState => ({ todos: [], nextId: 1 });

export function applyTodo(state: TodoState, input: TodoInput): TodoResult {
  switch (input.action) {
    case "list":
      return {
        state,
        message: state.todos.length
          ? state.todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
          : "No todos",
      };
    case "add": {
      if (!input.text) return { state, message: "Error: text required for add", error: "text required" };
      const todo: Todo = { id: state.nextId, text: input.text, done: false };
      return {
        state: { todos: [...state.todos, todo], nextId: state.nextId + 1 },
        message: `Added todo #${todo.id}: ${todo.text}`,
      };
    }
    case "toggle": {
      if (input.id === undefined) return { state, message: "Error: id required for toggle", error: "id required" };
      if (!state.todos.some((t) => t.id === input.id)) {
        return { state, message: `Todo #${input.id} not found`, error: `#${input.id} not found` };
      }
      const todos = state.todos.map((t) => (t.id === input.id ? { ...t, done: !t.done } : t));
      const toggled = todos.find((t) => t.id === input.id) as Todo;
      return {
        state: { ...state, todos },
        message: `Todo #${toggled.id} ${toggled.done ? "completed" : "uncompleted"}`,
      };
    }
    case "clear":
      return { state: emptyTodoState(), message: `Cleared ${state.todos.length} todos` };
  }
}

/** 重建分支状态：扫描 session 条目，取最后一条 todo toolResult 的 details。 */
interface BranchEntryLike {
  type: string;
  message?: { role?: string; toolName?: string; details?: unknown };
}

export function reconstructFromEntries(entries: readonly BranchEntryLike[]): TodoState {
  let state = emptyTodoState();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "toolResult" || msg.toolName !== "todo") continue;
    const d = msg.details as { todos?: Todo[]; nextId?: number } | undefined;
    if (d && Array.isArray(d.todos) && typeof d.nextId === "number") {
      state = { todos: d.todos, nextId: d.nextId };
    }
  }
  return state;
}
```

- [x] **步骤 5：运行确认通过** — `cd extensions/todo && & "../../tauri-agent/node_modules/.bin/vitest.CMD" run` → PASS（8 测试）

- [x] **步骤 6：Commit**

```bash
git add extensions/todo/todo.ts extensions/todo/todo.test.ts extensions/todo/package.json
git commit -m "feat(todo): branch-aware todo state reducer + reconstruction (A1)"
```

---

## 任务 2：todo extension 入口

**文件：**
- 创建：`extensions/todo/index.ts`

- [x] **步骤 1：实现** `extensions/todo/index.ts`

```ts
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyTodo, emptyTodoState, reconstructFromEntries, type TodoDetails, type TodoState } from "./todo.js";

const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "toggle", "clear"] as const),
  text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
  id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

export default function (pi: ExtensionAPI) {
  let state: TodoState = emptyTodoState();

  const reconstruct = (ctx: ExtensionContext) => {
    // getBranch() 返回 SessionEntry[]；reconstructFromEntries 只读取 type/message 子集。
    state = reconstructFromEntries(ctx.sessionManager.getBranch() as never);
  };
  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage a todo list. Actions: list, add (text), toggle (id), clear. Use to track multi-step work.",
    promptGuidelines: [
      "Maintain a todo list with the todo tool for multi-step tasks: add steps, toggle them done as you finish.",
    ],
    parameters: TodoParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = applyTodo(state, params);
      state = result.state;
      const details: TodoDetails = {
        action: params.action,
        todos: result.state.todos,
        nextId: result.state.nextId,
        error: result.error,
      };
      return { content: [{ type: "text", text: result.message }], details };
    },
  });
}
```

> 注（已核对官方类型 `types.d.ts`）：`registerTool` 的 `execute` 返回 `{ content, details }`，`details` 随 `tool_execution_end` 事件透传前端。`ctx.sessionManager.getBranch()` 返回 `SessionEntry[]`；本扩展只读 `type`/`message.role`/`message.toolName`/`message.details`，用 `as never` 桥接到纯函数的最小结构类型（bun build 仅 transpile，不做类型检查；逻辑已由任务 1 单测覆盖）。`StringEnum` 从 `@earendil-works/pi-ai` 导入（与官方 `todo.ts` 一致）。

- [x] **步骤 2：Commit**

```bash
git add extensions/todo/index.ts
git commit -m "feat(todo): register todo tool with branch-state reconstruction (A1)"
```

---

## 任务 3：注册并重建 sidecar

**文件：**
- 修改：`extensions/index.ts`

- [x] **步骤 1：注册 todo**（import 按字母序插入，导出与数组追加在 safety 之后；顺序不影响 todo）

```ts
import safety from "./safety/index.js";
import todo from "./todo/index.js";
import tts from "./tts/index.js";
// ...
export {
  safety,
  todo,
  knowledgeRag,
  // ...其余不变
};

export const allExtensions = [
  safety,
  todo,
  knowledgeRag,
  longTermMemory,
  webFetch,
  imageGen,
  codeReview,
  multiAgent,
  tts,
  imGateway,
];
```

> 实现前先读 `extensions/index.ts` 当前内容，按其确切 import/export/数组形态对齐（A0 已把 `safety` 放数组首位）。

- [x] **步骤 2：重建 sidecar**（先确认无 GrenAgent 进程占用 exe）

运行：`cd tauri-agent && node scripts/build-sidecar.mjs`
预期：末尾打印 `GrenAgent sidecar ready: ...pi-x86_64-pc-windows-msvc.exe`，bun 编译无 "Could not resolve"。

- [x] **步骤 3：Commit**

```bash
git add extensions/index.ts
git commit -m "feat(todo): register todo extension into sidecar bundle (A1)"
```

---

## 任务 4：前端 TodoCard + 图标

**文件：**
- 修改：`tauri-agent/src/features/tools/toolUtils.ts`
- 修改：`tauri-agent/src/features/tools/extensionCards.tsx`
- 测试：`tauri-agent/src/features/tools/extensionCards.test.tsx`

- [x] **步骤 1：toolUtils 加图标** — `toolMeta` 在 extension tools 段加一行，并在顶部 lucide import 增加 `ListChecks`

```ts
// import 段（与现有 lucide-react import 合并）：增加 ListChecks
// toolMeta 内，"// —— extension tools ——" 段追加：
  if (name === 'todo') return { icon: ListChecks };
```

- [x] **步骤 2：写失败测试** — 在 `extensionCards.test.tsx` 末尾追加（沿用该文件现有 render/getByText 模式）

```tsx
it('renders todo progress and items', () => {
  const result = {
    content: [{ type: 'text', text: 'Added todo #1: write tests' }],
    details: {
      action: 'add',
      nextId: 3,
      todos: [
        { id: 1, text: 'write tests', done: true },
        { id: 2, text: 'ship it', done: false },
      ],
    },
  };
  render(<>{renderExtensionCard({ toolName: 'todo', args: { action: 'add' }, result, status: 'done' })}</>);
  expect(screen.getByTestId('card-todo')).toBeTruthy();
  expect(screen.getByText('1/2 完成')).toBeTruthy();
  expect(screen.getByText(/write tests/)).toBeTruthy();
  expect(screen.getByText(/ship it/)).toBeTruthy();
});
```

> 实现前先读 `extensionCards.test.tsx` 顶部，复用其已有的 import（`render`/`screen`、`renderExtensionCard`）。若该文件用了独立 import，则只追加这条 `it(...)`，不要重复 import。

- [x] **步骤 3：运行确认失败** — `cd tauri-agent && & "node_modules/.bin/vitest.CMD" run src/features/tools/extensionCards.test.tsx` → FAIL（无 card-todo）

- [x] **步骤 4：实现 TodoCard** — `extensionCards.tsx`

顶部 lucide import 增加 `CheckSquare, ListChecks, Square`。在 `SpeakCard` 之后、`EXTENSION_CARD_RENDERERS` 之前插入：

```tsx
const TodoCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  const todos = Array.isArray(d?.todos)
    ? (d!.todos as Array<{ id?: unknown; text?: unknown; done?: unknown }>)
    : [];
  const done = todos.filter((t) => t.done).length;
  return (
    <Flexbox gap={6} data-testid="card-todo">
      <Flexbox horizontal align="center" gap={6}>
        <Icon icon={ListChecks} size={14} />
        <span style={{ fontSize: 12 }}>{todos.length ? `${done}/${todos.length} 完成` : '暂无待办'}</span>
      </Flexbox>
      {todos.length > 0 && (
        <Flexbox gap={2}>
          {todos.map((t, i) => (
            <Flexbox horizontal align="center" gap={6} key={i}>
              <Icon icon={t.done ? CheckSquare : Square} size={13} />
              <span
                style={{
                  fontSize: 12,
                  ...(t.done ? { color: 'var(--gren-fg-muted, #9aa1ac)', textDecoration: 'line-through' } : {}),
                }}
              >
                #{asString(t.id)} {asString(t.text)}
              </span>
            </Flexbox>
          ))}
        </Flexbox>
      )}
    </Flexbox>
  );
};
```

并在 `EXTENSION_CARD_RENDERERS` 中注册：

```tsx
const EXTENSION_CARD_RENDERERS: Record<string, FC<ExtensionCardProps>> = {
  kb_search: KbSearchCard,
  kb_add: KbAddCard,
  memory_save: MemoryCard,
  memory_recall: MemoryCard,
  generate_image: GenerateImageCard,
  spawn_agent: SpawnAgentCard,
  fetch_url: FetchUrlCard,
  speak: SpeakCard,
  todo: TodoCard,
};
```

- [x] **步骤 5：运行确认通过 + 类型检查**

运行：`cd tauri-agent && & "node_modules/.bin/vitest.CMD" run src/features/tools/extensionCards.test.tsx && & "node_modules/.bin/tsc.CMD" --noEmit`
预期：测试 PASS，tsc 退出 0

- [x] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/tools/toolUtils.ts tauri-agent/src/features/tools/extensionCards.tsx tauri-agent/src/features/tools/extensionCards.test.tsx
git commit -m "feat(todo): TodoCard with checklist + progress in chat stream (A1)"
```

---

## 自检

**规格覆盖度（对照 spec §4.4）：**
- `todo` 工具（增/改/删/列）→ 任务 1（`applyTodo`）+ 任务 2（`registerTool`）✅
- 状态存 tool result `details`，`session_start` 时从 `getBranch()` 重建（支持 fork）→ 任务 2（`reconstruct`）+ 任务 1（`reconstructFromEntries` 单测）✅
- 对话内 `TodoCard`（勾选/进度）→ 任务 4 ✅
- 右面板可选 todo 视图（复用 `RightPanel`）→ ⚠️ **本计划未含**（YAGNI；卡片已满足 spec 的「对话内显示」最小需求，右面板视图留作后续增强，需要时再追加任务）
- `/todos` 命令 → 故意省略（官方为 TUI overlay；GrenAgent 用卡片，命令无 React 承载，非必要）

**占位符扫描：** 两处「实现前先读」均指向具体现存文件用于对齐 import/形态，非功能占位；所有代码块可直接落地。

**类型一致性：** `Todo`/`TodoState`/`TodoInput`/`TodoResult`/`TodoDetails` 在 `todo.ts` 定义，`index.ts` 与测试一致引用；`details.todos`/`details.nextId` 在 `index.ts` 写入、`TodoCard` 与 `reconstructFromEntries` 读取，键名一致；前端 `getDetails`/`asString` 复用 `toolUtils`/`extensionCards` 现有导出。

**测试可跑性（A0 已验证）：** extensions 子包无 vitest，用 `tauri-agent/node_modules/.bin/vitest.CMD` 在 `extensions/todo` 下跑；前端测试用 `tauri-agent` 自带 vitest + jsdom + `@lobehub/ui` inline。
