# 输入框 Dock 与全高滚动条 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 主对话列滚动条铺满整列高度；任务 / 目标 / 排队钉在输入框上方的 dock；对话流 todo 改为一行「更新任务清单」；`todo` 工具改为三态整表覆盖。

**架构：** Virtua 仍是唯一滚动容器，列表 `inset:0`，座椅绝对贴底，`padding-bottom` 等于座椅高度。两端共用 `extensions/_shared/todo-model.ts`（规范化 + 摘要）。渲染侧用 Vite alias 引用同一份。Dock 从 store 消息倒序取最后一次成功 todo 快照。

**技术栈：** TypeScript、React、antd-style、@lobehub/ui、lucide-react、virtua、TypeBox、vitest + testing-library。

**上游规格：** `docs/superpowers/specs/2026-09-15-composer-dock-scrollbar-design.md`

---

## 动工前必读

- **不要隔离 worktree**，在当前仓库原地做。工作区很脏：每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。
- **按编号顺序执行，不要跳序。** 任务 1–2 是扩展纯函数，不碰 UI。任务 3 才让渲染进程看见新模型。任务 6 的列几何依赖任务 4–5 的 dock 已经能撑高座椅。
- Windows 提交用 PowerShell here-string，不要 bash `EOF` heredoc。
- 禁止 emoji。图标用 `@lobehub/ui` 的 `Icon` + `lucide-react`。
- **不要改** 子代理面板、pi core、询问卡关闭规则、`/` / `@` pop、审批回传、Goal 命令平面。
- **成功判据两侧不同源：** 扩展 reconstruct 看 session entry 的 `isError !== true` 且无 `details.error`；渲染 dock 看 `status === 'done'` 且无 `details.error`。不要在一处笼统写「跳过 isError」。
- **扩展 `execute` 的返回值没有 `isError` 字段。** `AgentToolResult<T>`（`pi-agent-core/dist/types.d.ts:317`）只有 `content` / `details` / `usage` / `addedToolNames` / `terminate`；`isError` 只存在于 `AfterToolCallResult`（:62）这个 hook 覆盖类型上。写 `return { content, details, isError: true }` 是 TS 多余属性错误。todo 的错误信号只有 `details.error`（外加 content 文本前缀 `"Error: "`，与现状一致）。
- `todo` **不是**流式工具：`execute` 不调 `onUpdate`。dock 只在成功结果到达时更新。
- **座椅留白是列表里的一行，不是滚动容器上的 CSS `padding-bottom`。** 见任务 6 步骤 3，原因写在那一步，别自作主张改回 padding。
- 渲染侧 import 共享模型必须走 `@extensions/_shared/todo-model`（任务 3 加 alias）。扩展侧继续相对路径 `../_shared/todo-model.js`。
- UI 以 vitest 为准，不要求点 Electron 真窗。
- `ResizeObserver` 在 `src/test/setup.ts` 是空 stub，**不要**指望它在 jsdom 里回调。座椅高度测试：把 `paddingBottom` 当 props 断言样式；几何接线用 spy / 手动触发。滚轮用纯函数测边界。

**测试命令：**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run <本任务列出的测试>
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run <本任务列出的测试>
```

**提交：**

```powershell
git add <本任务文件>
git commit -m @"
feat(chat): <本任务一句话>

"@
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `extensions/_shared/todo-model.ts` | `Todo` / `TodoState` / `normalizeTodos` / `todoSummary` / `emptyTodoState` |
| `extensions/_shared/todo-model.test.ts` | 两端共用的规范化与摘要 |
| `electron-agent/src/features/chat/input/latestTodos.ts` | 从 `ChatMessage[]` 倒序取最后一次成功快照 |
| `electron-agent/src/features/chat/input/latestTodos.test.ts` | 渲染侧成功判据 |
| `electron-agent/src/features/chat/input/TodoDock.tsx` | 任务条 UI（折叠 / 展开 / 空不渲染） |
| `electron-agent/src/features/chat/input/TodoDock.test.tsx` | 任务条验收 |
| `electron-agent/src/features/chat/input/dockCard.ts` | 三条 dock 共用的条形卡片样式 |
| `electron-agent/src/features/chat/input/todoRow.ts` | `ConvRow` 的 args / meta 文案 |
| `electron-agent/src/features/chat/input/todoRow.test.ts` | 清空 / 完成数 / +N |
| `electron-agent/src/features/chat/composerWheel.ts` | 草稿是否转发滚轮、槽宽计算 |
| `electron-agent/src/features/chat/composerWheel.test.ts` | 边缘 / 非边缘 / 槽宽 |

修改：

| 文件 | 职责 |
| --- | --- |
| `extensions/todo/todo.ts` | `applyTodo` 整表覆盖；`reconstructFromEntries` 走 `normalizeTodos` |
| `extensions/todo/todo.test.ts` | 覆盖 / 清空 / 非法 id / reconstruct 跳过失败 |
| `extensions/todo/index.ts` | TypeBox 参数、描述、`execute` |
| `electron-agent/electron.vite.config.ts` | renderer `resolve.alias` `@extensions` |
| `electron-agent/vitest.config.ts` | renderer project 同一条 alias |
| `electron-agent/tsconfig.json` | `paths` `@extensions/*` |
| `electron-agent/src/features/tools/ToolExecution.tsx` | 拆开 `todo \|\| generate_image`；todo 走 `ConvRow` |
| `electron-agent/src/features/tools/ToolExecution.test.tsx` | 「更新任务清单」一行 |
| `electron-agent/src/features/tools/extensionCards.tsx` | 删除 `TodoCard` 与 `todo` 注册 |
| `electron-agent/src/features/tools/extensionCards.test.tsx` | 删除两条 `card-todo` |
| `electron-agent/src/features/chat/input/editor/MessageEditor.tsx` | dock 叠层；删除 `goalSlot`；`styles.body` 加 `data-composer-draft` |
| `electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx` | GoalPill 在 surface 外 |
| `electron-agent/src/features/chat/input/SteerQueue.tsx` | 套 dock 卡片；删自带 `margin-bottom` |
| `electron-agent/src/features/chat/input/GoalPill.tsx` | 有快照时给 `styles.row` 套 dock card（Fragment 内的抽屉不包） |
| `electron-agent/src/features/chat/ChatInput.tsx` | 接收并下传 `scrollTranscript` |
| `electron-agent/src/features/chat/input/ChatInputContext.tsx` | 增加可选 `scrollTranscript` |
| `electron-agent/src/features/chat/ChatView.tsx` | 列几何：列表铺满、座椅贴底 |
| `electron-agent/src/features/chat/ChatListView.tsx` | 透传 `paddingBottom` / `scrollRef` / `onGutterChange` |
| `electron-agent/src/features/chat/ChatMessageItems.tsx` | 同上透传 |
| `electron-agent/src/features/chat/VirtualizedMessageList.tsx` | `paddingBottom`、jump 底距、`scrollBy`、量槽宽 |
| `electron-agent/src/features/chat/VirtualizedMessageList.test.tsx` | padding / jump / scrollBy |
| `electron-agent/src/features/chat/ChatView.test.tsx` | 空会话仍居中；非空出现座椅 |
| `electron-agent/src/preview.tsx` | 待办节改为任务条 + 对话流行 |

不改：`SubAgentConversation`、`ComposerPromptOverlay` 关闭规则、`groupMessages` 的 todo 合并逻辑（只靠现有测试回归）。

---

### 任务 1：共享 todo 模型

**文件：**
- 创建：`extensions/_shared/todo-model.ts`
- 测试：`extensions/_shared/todo-model.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { emptyTodoState, normalizeTodos, todoSummary } from "./todo-model.js";

describe("todoSummary", () => {
  it("counts done/total and names the single active item with no extra", () => {
    expect(todoSummary([
      { id: 1, text: "搭骨架", status: "completed" },
      { id: 2, text: "写组件", status: "in_progress" },
      { id: 3, text: "补测试", status: "pending" },
    ])).toEqual({ done: 1, total: 3, activeContent: "写组件", activeExtra: 0 });
  });

  it("reports extra active count when several items are in progress", () => {
    expect(todoSummary([
      { id: 1, text: "搭骨架", status: "completed" },
      { id: 2, text: "写组件", status: "in_progress" },
      { id: 3, text: "跑后台构建", status: "in_progress" },
      { id: 4, text: "读源码", status: "in_progress" },
      { id: 5, text: "补测试", status: "pending" },
    ])).toEqual({ done: 1, total: 5, activeContent: "写组件", activeExtra: 2 });
  });

  it("has no hint when nothing is in progress", () => {
    expect(todoSummary([{ id: 1, text: "都完了", status: "completed" }]))
      .toEqual({ done: 1, total: 1, activeContent: null, activeExtra: 0 });
  });

  it("drops hint and extra when the first in_progress text is unusable", () => {
    expect(todoSummary([
      { id: 1, text: "   ", status: "in_progress" },
      { id: 2, text: "写组件", status: "in_progress" },
    ])).toEqual({ done: 0, total: 2, activeContent: null, activeExtra: 0 });
  });

  it("is empty-safe", () => {
    expect(todoSummary([])).toEqual({ done: 0, total: 0, activeContent: null, activeExtra: 0 });
  });
});

describe("normalizeTodos", () => {
  it("keeps a valid three-state snapshot", () => {
    const n = normalizeTodos({
      todos: [{ id: 2, text: "写组件", status: "in_progress" }],
      nextId: 3,
    });
    expect(n).toEqual({
      todos: [{ id: 2, text: "写组件", status: "in_progress" }],
      nextId: 3,
    });
  });

  it("maps legacy done true/false and ignores action", () => {
    const n = normalizeTodos({
      action: "toggle",
      todos: [
        { id: 1, text: "a", done: true },
        { id: 2, text: "b", done: false },
      ],
      nextId: 3,
    });
    expect(n?.todos).toEqual([
      { id: 1, text: "a", status: "completed" },
      { id: 2, text: "b", status: "pending" },
    ]);
    expect(n?.nextId).toBe(3);
  });

  it("assigns ids without colliding when some rows already have ids", () => {
    const n = normalizeTodos({
      todos: [
        { id: 5, text: "kept", status: "pending" },
        { text: "new", status: "pending" },
      ],
    });
    expect(n?.todos.map((t) => t.id)).toEqual([5, 6]);
    expect(n?.nextId).toBe(7);
  });

  it("starts from 1 when no row has a valid id", () => {
    const n = normalizeTodos({ todos: [{ text: "a", status: "pending" }, { text: "b", status: "pending" }] });
    expect(n?.todos.map((t) => t.id)).toEqual([1, 2]);
    expect(n?.nextId).toBe(3);
  });

  it("keeps details.nextId only when it is an integer >= max(id)+1", () => {
    const bump = normalizeTodos({
      todos: [{ id: 1, text: "a", status: "pending" }],
      nextId: 9,
    });
    expect(bump?.nextId).toBe(9);
    const tooSmall = normalizeTodos({
      todos: [{ id: 4, text: "a", status: "pending" }],
      nextId: 2,
    });
    expect(tooSmall?.nextId).toBe(5);
  });

  it("returns null for malformed todos", () => {
    expect(normalizeTodos(undefined)).toBeNull();
    expect(normalizeTodos({ todos: "nope" })).toBeNull();
    expect(normalizeTodos({ todos: [null] })).toBeNull();
    expect(normalizeTodos({ todos: [{ id: 1, text: 3, status: "pending" }] })).toBeNull();
  });

  it("emptyTodoState starts at nextId 1", () => {
    expect(emptyTodoState()).toEqual({ todos: [], nextId: 1 });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run _shared/todo-model.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：编写最少实现**

`extensions/_shared/todo-model.ts`：

```ts
export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
  id: number;
  text: string;
  status: TodoStatus;
}

export interface TodoState {
  todos: Todo[];
  nextId: number;
}

export const emptyTodoState = (): TodoState => ({ todos: [], nextId: 1 });

export function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export interface TodoSummary {
  done: number;
  total: number;
  activeContent: string | null;
  activeExtra: number;
}

export function todoSummary(todos: readonly Todo[]): TodoSummary {
  const active = todos.filter((t) => t.status === "in_progress");
  const first = active[0]?.text;
  const named = typeof first === "string" && first.trim() !== "";
  return {
    done: todos.filter((t) => t.status === "completed").length,
    total: todos.length,
    activeContent: named ? first : null,
    activeExtra: named ? active.length - 1 : 0,
  };
}

function asItem(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

export function normalizeTodos(details: unknown): TodoState | null {
  if (typeof details !== "object" || details === null) return null;
  const todosRaw = (details as { todos?: unknown }).todos;
  if (!Array.isArray(todosRaw)) return null;

  const parsed: Array<{ rawId: unknown; text: string; status: TodoStatus }> = [];
  for (const row of todosRaw) {
    const item = asItem(row);
    if (!item) return null;
    if (typeof item.text !== "string") return null;
    const status: TodoStatus = isTodoStatus(item.status)
      ? item.status
      : item.done === true
        ? "completed"
        : "pending";
    parsed.push({ rawId: item.id, text: item.text, status });
  }

  const used = new Set<number>();
  for (const row of parsed) {
    if (isPositiveInt(row.rawId)) used.add(row.rawId);
  }
  let cursor = used.size > 0 ? Math.max(...used) + 1 : 1;
  const todos: Todo[] = parsed.map((row) => {
    let id: number;
    if (isPositiveInt(row.rawId)) {
      id = row.rawId;
    } else {
      while (used.has(cursor)) cursor += 1;
      id = cursor;
      used.add(id);
      cursor += 1;
    }
    return { id, text: row.text, status: row.status };
  });

  const minNext = todos.length === 0 ? 1 : Math.max(...todos.map((t) => t.id)) + 1;
  const rawNext = (details as { nextId?: unknown }).nextId;
  const nextId = typeof rawNext === "number" && Number.isInteger(rawNext) && rawNext >= minNext
    ? rawNext
    : minNext;
  return { todos, nextId };
}
```

注意：`todoSummary` 的「第一条文案不可用」按规格是看 **第一条** `in_progress` 的 text（trim 后空），即使后面有可用文案也整段 hint 丢掉。不要改成「找第一条非空」。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run _shared/todo-model.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/_shared/todo-model.ts extensions/_shared/todo-model.test.ts
git commit -m @"
feat(todo): share normalize and summary helpers

"@
```

---

### 任务 2：整表覆盖工具

**文件：**
- 修改：`extensions/todo/todo.ts`
- 修改：`extensions/todo/todo.test.ts`
- 修改：`extensions/todo/index.ts`

- [ ] **步骤 1：重写失败测试**

把 `extensions/todo/todo.test.ts` 整文件换成（不要留 add/toggle 旧用例）：

```ts
import { describe, expect, it } from "vitest";
import { applyTodo, emptyTodoState, reconstructFromEntries } from "./todo.js";

const write = (todos: Array<{ id?: number; text: string; status: "pending" | "in_progress" | "completed" }>) =>
  applyTodo(emptyTodoState(), { todos });

describe("applyTodo", () => {
  it("replaces the whole list and assigns missing ids", () => {
    const r = write([
      { text: "搭骨架", status: "completed" },
      { text: "写组件", status: "in_progress" },
    ]);
    expect(r.error).toBeUndefined();
    expect(r.state.todos).toEqual([
      { id: 1, text: "搭骨架", status: "completed" },
      { id: 2, text: "写组件", status: "in_progress" },
    ]);
    expect(r.state.nextId).toBe(3);
    expect(r.message).toBe("0 pending, 1 in progress, 1 completed");
  });

  it("rejects blank text and keeps state", () => {
    const prior = write([{ text: "keep", status: "pending" }]).state;
    const r = applyTodo(prior, { todos: [{ text: "  ", status: "pending" }] });
    expect(r.error).toBe("text required");
    expect(r.state).toBe(prior);
  });

  it("rejects duplicate ids and non-positive ids without mutating", () => {
    const prior = emptyTodoState();
    expect(applyTodo(prior, { todos: [
      { id: 1, text: "a", status: "pending" },
      { id: 1, text: "b", status: "pending" },
    ] }).error).toBe("duplicate id");
    expect(applyTodo(prior, { todos: [{ id: 0, text: "a", status: "pending" }] }).error).toBe("invalid id");
    expect(applyTodo(prior, { todos: [{ id: -1, text: "a", status: "pending" }] }).error).toBe("invalid id");
    expect(applyTodo(prior, { todos: [{ id: 1.5, text: "a", status: "pending" }] }).error).toBe("invalid id");
    expect(prior).toEqual(emptyTodoState());
  });

  it("skips occupied ids when allocating", () => {
    const r = applyTodo({ todos: [], nextId: 1 }, { todos: [
      { id: 5, text: "kept", status: "pending" },
      { text: "new", status: "pending" },
    ] });
    expect(r.state.todos.map((t) => t.id)).toEqual([5, 6]);
    expect(r.state.nextId).toBe(7);
  });

  it("clears to emptyTodoState", () => {
    const prior = write([{ text: "a", status: "pending" }]).state;
    const r = applyTodo(prior, { todos: [] });
    expect(r.state).toEqual(emptyTodoState());
    expect(r.message).toBe("0 pending, 0 in progress, 0 completed");
  });
});

describe("reconstructFromEntries", () => {
  it("uses the last successful details", () => {
    const s = reconstructFromEntries([
      { type: "message", message: { role: "toolResult", toolName: "todo", details: { todos: [{ id: 1, text: "a", done: false }], nextId: 2 } } },
      { type: "message", message: { role: "toolResult", toolName: "todo", isError: true, details: { todos: [], nextId: 1, error: "boom" } } },
      { type: "message", message: { role: "toolResult", toolName: "todo", details: { todos: [{ id: 1, text: "a", status: "completed" }], nextId: 2, error: "nope" } } },
      { type: "message", message: { role: "toolResult", toolName: "todo", details: { todos: [{ id: 1, text: "a", status: "in_progress" }], nextId: 2 } } },
    ]);
    expect(s.todos[0]).toEqual({ id: 1, text: "a", status: "in_progress" });
  });

  it("skips malformed todos and non-todo entries", () => {
    expect(reconstructFromEntries([
      { type: "message", message: { role: "assistant" } },
      { type: "compaction" },
      { type: "message", message: { role: "toolResult", toolName: "bash", details: { foo: 1 } } },
      { type: "message", message: { role: "toolResult", toolName: "todo", details: { todos: "bad" } } },
    ])).toEqual(emptyTodoState());
  });
});
```

- [ ] **步骤 2：运行确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run todo/todo.test.ts
```

预期：FAIL（旧 `applyTodo` 仍要 `action`）。

- [ ] **步骤 3：实现 `todo.ts` 与 `index.ts`**

`extensions/todo/todo.ts`：从 `../_shared/todo-model.js` 重导出类型、`emptyTodoState`、`normalizeTodos`。`applyTodo` 签名改为：

```ts
export interface TodoWriteInput {
  todos: Array<{ id?: number; text: string; status: TodoStatus }>;
}

export interface TodoResult {
  state: TodoState;
  message: string;
  error?: string;
}

export interface TodoDetails {
  todos: Todo[];
  nextId: number;
  error?: string;
}

function countMessage(todos: readonly Todo[]): string {
  const pending = todos.filter((t) => t.status === "pending").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const completed = todos.filter((t) => t.status === "completed").length;
  return `${pending} pending, ${inProgress} in progress, ${completed} completed`;
}

export function applyTodo(state: TodoState, input: TodoWriteInput): TodoResult {
  const rows = input.todos;
  if (!Array.isArray(rows)) {
    return { state, message: "Error: todos required", error: "todos required" };
  }
  if (rows.length === 0) {
    return { state: emptyTodoState(), message: countMessage([]) };
  }

  const seen = new Set<number>();
  for (const row of rows) {
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text) return { state, message: "Error: text required", error: "text required" };
    if (!isTodoStatus(row.status)) return { state, message: "Error: invalid status", error: "invalid status" };
    if (row.id !== undefined) {
      if (!isPositiveInt(row.id)) return { state, message: "Error: invalid id", error: "invalid id" };
      if (seen.has(row.id)) return { state, message: "Error: duplicate id", error: "duplicate id" };
      seen.add(row.id);
    }
  }

  const maxSeen = seen.size > 0 ? Math.max(...seen) : 0;
  let cursor = Math.max(state.nextId, maxSeen + 1);
  const todos: Todo[] = rows.map((row) => {
    const text = row.text.trim();
    let id: number;
    if (row.id !== undefined) {
      id = row.id;
    } else {
      while (seen.has(cursor)) cursor += 1;
      id = cursor;
      seen.add(id);
      cursor += 1;
    }
    return { id, text, status: row.status };
  });
  const nextId = Math.max(state.nextId, Math.max(...todos.map((t) => t.id)) + 1);
  return { state: { todos, nextId }, message: countMessage(todos) };
}

interface BranchEntryLike {
  type: string;
  message?: {
    role?: string;
    toolName?: string;
    details?: unknown;
    isError?: boolean;
  };
}

export function reconstructFromEntries(entries: readonly BranchEntryLike[]): TodoState {
  let state = emptyTodoState();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "toolResult" || msg.toolName !== "todo") continue;
    if (msg.isError === true) continue;
    const details = msg.details;
    if (typeof details === "object" && details !== null && "error" in details && (details as { error?: unknown }).error != null) {
      continue;
    }
    const next = normalizeTodos(details);
    if (next) state = next;
  }
  return state;
}
```

`index.ts`：删掉 `action` 参数。TypeBox：

```ts
const TodoParams = Type.Object({
  todos: Type.Array(Type.Object({
    id: Type.Optional(Type.Number({ description: "Existing item id; omit to allocate" })),
    text: Type.String({ description: "Todo text" }),
    status: StringEnum(["pending", "in_progress", "completed"] as const),
  })),
});
```

`description` / `promptGuidelines` 按规格：每次提交完整列表；进行中标 `in_progress`；并行可多条；完成立刻标 `completed`；琐碎单步不必建表。

`execute`：

```ts
async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
  const result = applyTodo(state, params);
  if (!result.error) state = result.state;
  const details: TodoDetails = {
    todos: result.state.todos,
    nextId: result.state.nextId,
    error: result.error,
  };
  return {
    content: [{ type: "text", text: result.message }],
    details,
  };
}
```

失败时 `state` 变量不改；`details` 里仍是旧 state（`applyTodo` 失败返回原 `state`）。

**不要**加 `isError: true`：扩展 `execute` 的返回类型是 `AgentToolResult<TDetails>`，它没有这个字段（只有 `content` / `details` / `usage` / `addedToolNames` / `terminate`），加了是 TS 多余属性错误。todo 失败对外的唯一信号就是 `details.error` + content 的 `"Error: "` 前缀——这也是 reconstruct 与渲染 dock 判失败的根据。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run todo/todo.test.ts _shared/todo-model.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/todo/todo.ts extensions/todo/todo.test.ts extensions/todo/index.ts
git commit -m @"
feat(todo): replace add/toggle with whole-list write

"@
```

---

### 任务 3：渲染 alias + 对话流一行

**文件：**
- 修改：`electron-agent/electron.vite.config.ts`
- 修改：`electron-agent/vitest.config.ts`
- 修改：`electron-agent/tsconfig.json`
- 创建：`electron-agent/src/features/chat/input/todoRow.ts`
- 测试：`electron-agent/src/features/chat/input/todoRow.test.ts`
- 修改：`electron-agent/src/features/tools/ToolExecution.tsx`
- 修改：`electron-agent/src/features/tools/ToolExecution.test.tsx`
- 修改：`electron-agent/src/features/tools/extensionCards.tsx`
- 修改：`electron-agent/src/features/tools/extensionCards.test.tsx`
- 修改：`electron-agent/src/preview.tsx`（本节只改待办展示；完整预览节可在本任务一起改掉，避免 `renderExtensionCard({ toolName: 'todo' })` 变 null）

- [ ] **步骤 1：加 alias**

`electron.vite.config.ts` 的 `renderer` 增加：

```ts
renderer: {
  root: resolve(__dirname),
  resolve: {
    alias: {
      "@extensions": resolve(__dirname, "../extensions"),
    },
  },
  build: { /* 现有 */ },
},
```

`vitest.config.ts` 的 renderer project 同样加 `resolve.alias`（与 `test` 同级，写在该 project 对象上）：

```ts
{
  resolve: {
    alias: { "@extensions": fileURLToPath(new URL("../extensions", import.meta.url)) },
  },
  test: { name: "renderer", /* 现有 include/environment/setupFiles/testTimeout/execArgv */ },
}
```

文件顶部 `import { fileURLToPath } from "node:url";`。路径必须是 `../extensions`（vitest.config 在 `electron-agent/` 下）。

`vitest.config.ts` 的 `projects` 条目类型是 `UserWorkspaceConfig extends ViteUserConfig`，所以在 project 对象上写 `resolve.alias` 与 `test` 同级是合法的（已核对 vitest 4.1.11 的类型定义），不用改成 `defineProject`。

`../extensions` 在 renderer `root`（`electron-agent/`）之外。build 无影响；`electron-vite dev` 若报 `403 Forbidden / Outside of Vite serving allow list`，在 renderer 配置里补 `server: { fs: { allow: [resolve(__dirname, "..")] } }`。

`tsconfig.json` 的 `compilerOptions` 增加：

```json
"baseUrl": ".",
"paths": { "@extensions/*": ["../extensions/*"] }
```

- [ ] **步骤 2：编写 `todoRow` 与 ToolExecution 失败测试**

`todoRow.ts` 先不存在。测试：

```ts
import { describe, expect, it } from "vitest";
import { todoRowCopy } from "./todoRow";

describe("todoRowCopy", () => {
  it("uses 已清空 when the successful list is empty", () => {
    expect(todoRowCopy({ done: 0, total: 0, activeContent: null, activeExtra: 0 }))
      .toEqual({ args: "已清空", meta: undefined });
  });

  it("joins counts and the first active name", () => {
    expect(todoRowCopy({ done: 1, total: 5, activeContent: "写组件", activeExtra: 2 }))
      .toEqual({ args: "1/5 已完成 · 写组件", meta: "+2" });
  });

  it("omits meta when extra is 0", () => {
    expect(todoRowCopy({ done: 1, total: 3, activeContent: "写组件", activeExtra: 0 }))
      .toEqual({ args: "1/3 已完成 · 写组件", meta: undefined });
  });

  it("omits the hint when nothing is in progress", () => {
    expect(todoRowCopy({ done: 1, total: 1, activeContent: null, activeExtra: 0 }))
      .toEqual({ args: "1/1 已完成", meta: undefined });
  });
});
```

`ToolExecution.test.tsx` 追加：

```ts
describe("ToolExecution todo row", () => {
  it("renders 更新任务清单 without card-todo", () => {
    wrap(
      <ToolExecution
        toolName="todo"
        args={{}}
        result={{
          details: {
            todos: [
              { id: 1, text: "搭骨架", status: "completed" },
              { id: 2, text: "写组件", status: "in_progress" },
              { id: 3, text: "跑后台构建", status: "in_progress" },
              { id: 4, text: "读源码", status: "in_progress" },
              { id: 5, text: "补测试", status: "pending" },
            ],
            nextId: 6,
          },
          content: [{ type: "text", text: "1 pending, 3 in progress, 1 completed" }],
        }}
        status="done"
      />,
    );
    expect(screen.getByText("更新任务清单")).toBeTruthy();
    expect(document.body.textContent).toContain("1/5 已完成");
    expect(document.body.textContent).toContain("写组件");
    expect(document.body.textContent).toContain("+2");
    expect(screen.queryByTestId("card-todo")).toBeNull();
  });

  it("shows 已清空 for an empty successful list", () => {
    wrap(
      <ToolExecution
        toolName="todo"
        args={{}}
        result={{ details: { todos: [], nextId: 1 }, content: [{ type: "text", text: "0 pending, 0 in progress, 0 completed" }] }}
        status="done"
      />,
    );
    expect(screen.getByText("已清空")).toBeTruthy();
  });
});
```

`extensionCards.test.tsx`：**删除**两条 todo 用例，名字要精确匹配（`extensionCards.test.tsx:73` / `:92`）：

- `it('todo shows progress and items', ...)`（:73–:86）
- `it('todo collapses to a single bar when cleared', ...)`（:92–:101）

保留 `generate_image`、`spawn_agent`、`fetch_url`、`speak` 等。这两条用例都在 `renderExtensionCard` 里断言 `card-todo`；删掉后 `renderExtensionCard` 的 `todo` 注册也要同步删（步骤 4），否则 `returns null for unknown tools` 那条不受影响，但 `todo` 会变成「注册了却没人测」的死代码。

- [ ] **步骤 3：运行确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/todoRow.test.ts src/features/tools/ToolExecution.test.tsx src/features/tools/extensionCards.test.tsx
```

预期：`todoRow` 模块不存在；ToolExecution 仍渲染 `card-todo`。

- [ ] **步骤 4：实现**

`todoRow.ts`：

```ts
import type { TodoSummary } from "@extensions/_shared/todo-model";

export function todoRowCopy(summary: TodoSummary): { args: string; meta?: string } {
  if (summary.total === 0) return { args: "已清空" };
  const head = `${summary.done}/${summary.total} 已完成`;
  const args = summary.activeContent ? `${head} · ${summary.activeContent}` : head;
  return { args, meta: summary.activeExtra > 0 ? `+${summary.activeExtra}` : undefined };
}
```

`ToolExecution.tsx`：

- 增加 `import { ListChecks } from "lucide-react"`（若尚未从 toolUtils 间接拿到；本文件目前不 import ListChecks，直接加）。
- `import { normalizeTodos, todoSummary } from "@extensions/_shared/todo-model";`
- `import { todoRowCopy } from "../chat/input/todoRow";`
- **拆开** `bareName === "todo" || bareName === "generate_image"`：

```tsx
if (bareName === "todo") {
  const details = getDetails(result);
  const normalized = details && details.error == null ? normalizeTodos(details) : null;
  const copy = normalized ? todoRowCopy(todoSummary(normalized.todos)) : null;
  return (
    <div className={cardStyles.toolRow}>
      <ConvRow
        data-testid="tool-execution"
        status={status}
        icon={ListChecks}
        name="更新任务清单"
        args={status === "error" ? (extractText(result) || copy?.args) : copy?.args}
        meta={status === "error" ? undefined : copy?.meta}
      />
    </div>
  );
}

if (bareName === "generate_image") {
  // 保留原来的 renderExtensionCard 分支
}
```

进行中尚无 details：`copy` 为 null，只显示标题（不传 args）。

`extensionCards.tsx`：删除 `TodoCard` 组件、`todoCardStyles`、`todo: TodoCard` 注册。若 `ListChecks` 只被 TodoCard 使用，删掉该 import。

`preview.tsx`：待办节改为：

```tsx
<Section title="待办（dock 条 + 对话流行）">
  <Item label="对话流 · 并行进行中">
    <ToolExecution
      toolName="todo"
      args={{}}
      result={withDetails({
        todos: [
          { id: 1, text: "搭骨架", status: "completed" },
          { id: 2, text: "写组件", status: "in_progress" },
          { id: 3, text: "跑后台构建", status: "in_progress" },
        ],
        nextId: 4,
      })}
      status="done"
    />
  </Item>
</Section>
```

并把文件顶部 `todoList` 的 `done` 字段改成 `status`，或删掉仅被旧节使用的 `todoList`。`PlanCard` 预览若仍用 `done: true` 的本地类型，不要动 PlanCard。

- [ ] **步骤 5：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/todoRow.test.ts src/features/tools/ToolExecution.test.tsx src/features/tools/extensionCards.test.tsx src/features/chat/groupMessages.test.ts
```

预期：PASS。`groupMessages` 的 todo 合并回归必须绿。

- [ ] **步骤 6：Commit**

```powershell
git add electron-agent/electron.vite.config.ts electron-agent/vitest.config.ts electron-agent/tsconfig.json electron-agent/src/features/chat/input/todoRow.ts electron-agent/src/features/chat/input/todoRow.test.ts electron-agent/src/features/tools/ToolExecution.tsx electron-agent/src/features/tools/ToolExecution.test.tsx electron-agent/src/features/tools/extensionCards.tsx electron-agent/src/features/tools/extensionCards.test.tsx electron-agent/src/preview.tsx
git commit -m @"
feat(chat): render todo as a one-line transcript row

"@
```

---

### 任务 4：任务条 dock

**文件：**
- 创建：`electron-agent/src/features/chat/input/latestTodos.ts`
- 测试：`electron-agent/src/features/chat/input/latestTodos.test.ts`
- 创建：`electron-agent/src/features/chat/input/dockCard.ts`
- 创建：`electron-agent/src/features/chat/input/TodoDock.tsx`
- 测试：`electron-agent/src/features/chat/input/TodoDock.test.tsx`

- [ ] **步骤 1：编写失败测试**

`latestTodos.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../stores/agentReducer";
import { latestTodosFromMessages } from "./latestTodos";

const tool = (over: Partial<Extract<ChatMessage, { kind: "tool" }>> & { result: unknown; status: "running" | "done" | "error" }): ChatMessage => ({
  kind: "tool",
  id: "t",
  toolCallId: "c",
  toolName: "todo",
  args: {},
  ...over,
});

describe("latestTodosFromMessages", () => {
  it("returns null when nothing succeeded", () => {
    expect(latestTodosFromMessages([])).toBeNull();
    expect(latestTodosFromMessages([
      tool({ status: "error", result: { details: { todos: [], error: "x" } } }),
    ])).toBeNull();
  });

  it("skips error status and details.error, keeps the last done snapshot", () => {
    const messages: ChatMessage[] = [
      tool({
        id: "a",
        status: "done",
        result: { details: { todos: [{ id: 1, text: "old", status: "pending" }], nextId: 2 } },
      }),
      tool({
        id: "b",
        status: "done",
        result: { details: { todos: [{ id: 1, text: "new", status: "in_progress" }], nextId: 2, error: "nope" } },
      }),
      tool({
        id: "c",
        status: "error",
        result: { details: { todos: [], nextId: 1 } },
      }),
    ];
    expect(latestTodosFromMessages(messages)).toEqual([
      { id: 1, text: "old", status: "pending" },
    ]);
  });

  it("returns empty array after a successful clear", () => {
    expect(latestTodosFromMessages([
      tool({ status: "done", result: { details: { todos: [], nextId: 1 } } }),
    ])).toEqual([]);
  });
});
```

`TodoDock.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TodoDock } from "./TodoDock";
import type { Todo } from "@extensions/_shared/todo-model";

afterEach(cleanup);

const LIST: Todo[] = [
  { id: 1, text: "搭骨架", status: "completed" },
  { id: 2, text: "写组件", status: "in_progress" },
  { id: 3, text: "补测试", status: "pending" },
];

describe("TodoDock", () => {
  it("renders nothing when empty", () => {
    const { container } = render(<TodoDock todos={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("collapses to counts without task names", () => {
    render(<TodoDock todos={LIST} />);
    expect(screen.getByTestId("todo-dock").textContent).toContain("任务");
    expect(screen.getByTestId("todo-dock").textContent).toContain("1 已完成");
    expect(screen.getByTestId("todo-dock").textContent).toContain("1 进行中");
    expect(screen.getByTestId("todo-dock").textContent).toContain("1 待处理");
    expect(screen.queryByText("写组件")).toBeNull();
  });

  it("omits zero-count segments", () => {
    render(<TodoDock todos={[{ id: 1, text: "x", status: "completed" }]} />);
    expect(screen.getByTestId("todo-dock").textContent).toContain("1 已完成");
    expect(screen.getByTestId("todo-dock").textContent).not.toContain("进行中");
    expect(screen.getByTestId("todo-dock").textContent).not.toContain("待处理");
  });

  it("expands to one row per item and allows parallel in_progress", () => {
    render(<TodoDock todos={[
      ...LIST,
      { id: 4, text: "跑后台构建", status: "in_progress" },
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    expect(screen.getByText("写组件")).toBeTruthy();
    expect(screen.getByText("跑后台构建")).toBeTruthy();
    expect(screen.getByTestId("todo-dock-list")).toHaveStyle({ maxHeight: "180px" });
  });
});
```

折叠头的 `aria-label` 用「任务」（整个 header button）。

- [ ] **步骤 2：运行确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/latestTodos.test.ts src/features/chat/input/TodoDock.test.tsx
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现**

`latestTodos.ts`：用 `getDetails`（`../../tools/toolUtils`）+ `normalizeTodos`。倒序扫描 `kind === "tool" && toolName.toLowerCase() === "todo"`。成功：`status === "done"` 且 `getDetails(result)?.error == null` 且 `normalizeTodos(details)` 非 null。返回 `todos` 数组；一次都没有则 `null`。清空成功返回 `[]`。

`dockCard.ts`：`createStaticStyles` 一条 `card`（`border: 1px solid colorBorderSecondary`、`border-radius: borderRadiusLG`、`background: colorFillTertiary`、`padding: 6px 12px`）。供 TodoDock / Goal 包裹 / SteerQueue 共用。

`TodoDock.tsx`：

- props：`{ todos: readonly Todo[] }`。`todos.length === 0` 则 `return null`。
- `useState(true)` 默认折叠。
- header `<button aria-expanded={!collapsed} aria-label="任务">`：`Icon ListChecks` + 「任务」+ `todoProgressLabel(todos)` + `ChevronUp`（折叠）/ `ChevronDown`（展开）。
- `todoProgressLabel`：三段 `N 已完成` / `N 进行中` / `N 待处理`，零段省略，`"\u2002·\u2002"` 拼接。
- 展开 `ul data-testid="todo-dock-list"`：`max-height: 180px; overflow-y: auto`。每项 `Icon`：`CircleCheck`（`colorSuccess`）/ `Loader2` + spin / `CircleDashed`（四次要色）。文案单行省略。
- 外层 `data-testid="todo-dock"` + `dockCard` 的 card class。

根组件 `TodoDockFromStore`（可写在同文件并导出）：`useAgentStore` 读 `messages`，`latestTodosFromMessages`，null 或 `[]` 则 null，否则 `<TodoDock todos={...} />`。MessageEditor 只挂 `TodoDockFromStore`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/latestTodos.test.ts src/features/chat/input/TodoDock.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/features/chat/input/latestTodos.ts electron-agent/src/features/chat/input/latestTodos.test.ts electron-agent/src/features/chat/input/dockCard.ts electron-agent/src/features/chat/input/TodoDock.tsx electron-agent/src/features/chat/input/TodoDock.test.tsx
git commit -m @"
feat(chat): dock the latest todo plan above the composer

"@
```

---

### 任务 5：Goal 与排队进入 dock

**文件：**
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.tsx`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx`
- 修改：`electron-agent/src/features/chat/input/SteerQueue.tsx`

- [ ] **步骤 1：改失败测试**

`MessageEditor.test.tsx` 把 `keeps the goal pill inside the composer surface` 换成：

```ts
it("keeps the goal pill in the dock, outside the composer surface", async () => {
  useGoalStore.getState().setSnapshot("session-a", snapshot);
  render(<MessageEditor leftActions={[]} rightActions={[]} />);

  const surface = await screen.findByTestId("composer-surface");
  const pill = await screen.findByTestId("goal-pill");
  expect(surface.contains(pill)).toBe(false);
  expect(screen.getByTestId("composer-dock").contains(pill)).toBe(true);
});
```

同文件再加：有 `steering` 时 `steer-queue` 也在 `composer-dock` 里。把 `useChatInput` mock 的 `steering` 改成 `["先改测试"]` 的那条新用例（不要破坏现有 send mock）。可以单独 `it`，在该 it 里不方便改 hoisted mock 的话：给 `useChatInput` mock 默认 `steering: []`，本用例用 `vi.mocked` 不够；更省事是默认 mock 保持 `steering: []`，SteerQueue 位置用一个小的 `SteerQueue.test.tsx` 只测「有数据时根节点带 dock card class」。若不想新文件：MessageEditor 测试里 `vi.mock("../SteerQueue")` 已经没有（当前是真组件，`steering` 来自 ChatInputContext mock）。把 mock 的 `steering` 做成 `let steering: string[] = []`，在 beforeEach 清空，本 it 设为 `["先改测试"]`。

- [ ] **步骤 2：运行确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/editor/MessageEditor.test.tsx
```

预期：FAIL，`composer-dock` 不存在，pill 仍在 surface 内。

- [ ] **步骤 3：实现**

`MessageEditor.tsx`：

1. 删除 `styles.goalSlot`。
2. 在 `zone` 里、`surface` **之前**加：

```tsx
<div data-testid="composer-dock" className={styles.dock}>
  <TodoDockFromStore />
  <div className={dockCardStyles.card}>
    <GoalPill onOpenDetails={(snapshot) => setGoalDrawerSessionId(snapshot.sessionId)} />
  </div>
  <SteerQueue />
</div>
```

Goal 无快照时 `GoalPill` 返回 null。空的 `div.card` 会留下空卡片——**不要**无条件包 card。改为 GoalPill 自己根节点套 `dockCard`（在 `GoalPill.tsx` 最外层 `styles.row` 外包一层 card，null 时整棵不渲染）。SteerQueue 在 `styles.wrap` 上合并 `dockCardStyles.card`。任务条自己已有 card。于是 MessageEditor 只渲染：

```tsx
<div data-testid="composer-dock" className={styles.dock}>
  <TodoDockFromStore />
  <GoalPill onOpenDetails={...} />
  <SteerQueue />
</div>
<SessionGoalDrawer ... />
<WorkspaceBar ... />
<PromptRequestCard />
<div ref={surfaceRef} className={styles.surface} data-testid="composer-surface">
  {/* 不再有 goalSlot */}
```

`styles.dock`：`display:flex; flex-direction:column; gap:6px; margin-bottom:6px;`，`:empty { display:none; margin:0; }`（三个孩子全 null 时 dock 不占位）。

`GoalPill.tsx`：**只给 `styles.row` 那个 div 套 card**。`GoalPill` 返回的是 Fragment（`<>{row}{maybeDrawer}</>`，见 `GoalPill.tsx:207-315`），在「最外层」包 card 会把 `SessionGoalDrawer` 一起裹进去——抽屉会被 dock 的边框底色框住。改法：`<div className={dockCardStyles.card}><div className={styles.row} data-testid="goal-pill">…</div></div>`，抽屉留在 card 外面。`data-testid="goal-pill"` 保持在 row 上不动，`GoalPill.test.tsx` 才不用改。

`SteerQueue.tsx`：`wrap` 合并 card，同时**删掉 `wrap` 自带的 `margin-bottom: 6px`**（`SteerQueue.tsx:12`）——dock 已经有 `gap: 6px`，留着会变成 12px。另外 `styles.item` 自带 `background: ${cssVar.colorFillTertiary}`（:25），套上 dock card 后是两层底色；`dockCard` 的底色若也用 `colorFillTertiary`，就把 item 的 background 去掉，只留 card 一层。

空态不变：`steering.length === 0 && followUp.length === 0` 时 `SteerQueue` 返回 null（:49），dock 靠 `:empty` 收掉。

顺序必须是：任务 → 目标 → 排队 →（dock 外）工作区栏 → 审批卡 → surface。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/editor/MessageEditor.test.tsx src/features/chat/input/GoalPill.test.tsx src/features/chat/input/TodoDock.test.tsx
```

预期：PASS。GoalPill 单测仍然找得到 `goal-pill`。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/features/chat/input/editor/MessageEditor.tsx electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx electron-agent/src/features/chat/input/GoalPill.tsx electron-agent/src/features/chat/input/SteerQueue.tsx
git commit -m @"
feat(chat): move goal and steer queue onto the composer dock

"@
```

---

### 任务 6：列几何（全高滚动 + 座椅留白）

**文件：**
- 创建：`electron-agent/src/features/chat/composerWheel.ts`（本任务只加 `scrollbarGutterPx`；转发函数留任务 7 同一文件）
- 测试：`electron-agent/src/features/chat/composerWheel.test.ts`
- 修改：`electron-agent/src/features/chat/VirtualizedMessageList.tsx`
- 修改：`electron-agent/src/features/chat/VirtualizedMessageList.test.tsx`
- 修改：`electron-agent/src/features/chat/ChatMessageItems.tsx`
- 修改：`electron-agent/src/features/chat/ChatListView.tsx`
- 修改：`electron-agent/src/features/chat/ChatView.tsx`
- 修改：`electron-agent/src/features/chat/ChatView.test.tsx`

- [ ] **步骤 1：编写失败测试**

`composerWheel.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { scrollbarGutterPx } from "./composerWheel";

describe("scrollbarGutterPx", () => {
  it("is the overflow slot", () => {
    expect(scrollbarGutterPx(400, 388)).toBe(12);
    expect(scrollbarGutterPx(400, 400)).toBe(0);
  });
});
```

`VirtualizedMessageList.test.tsx` 的 virtua mock 增加 `scrollBy`，并在挂载后主动调一次 `onScroll`（现在 mock 完全不调，jump 按钮永远不渲染）：

```ts
VList: React.forwardRef(function MockVList({ children, data, style, ...props }: any, ref: any) {
  React.useImperativeHandle(ref, () => ({
    scrollToIndex,
    scrollBy,
    scrollOffset: 0,
    viewportSize: 600,
    scrollSize: 40_000,
    findItemIndex: () => 0,
    getItemOffset: () => 0,
  }));
  React.useEffect(() => { props.onScroll?.(); }, []);
  const items = typeof children === "function" ? Array.from(data ?? [], children) : children;
  return React.createElement("div", { ...props, style, "data-testid": "virtua-list" }, items);
}),
```

`scrollBy` 与 `scrollToIndex` 一样放在 `vi.hoisted`。`onScroll` 触发后：`0 + 600 >= 40_000 - 120` 为假 → `atBottom=false`，且 24 条 > `JUMP_MIN_ITEMS(3)` → jump 按钮渲染出来。

给 mock 加 `onScroll` 是全局生效的，会影响同文件既有用例（`近距离时间轴跳转` / `大跨度时间轴跳转` / `mounts the scroll container`）。改完先跑一遍这三个，若因 `atBottom` 变 false 而红，就把 `onScroll` 调用收进一个 `let fireScroll = false` 的开关，只在新用例里打开，别去动既有断言。

新用例：

```ts
it("reserves seat padding as a trailing spacer row", () => {
  render(
    <VirtualizedMessageList
      display={longConversation()}
      renderItem={(m) => <div>{m.id}</div>}
      paddingBottom={120}
      data-testid="vlist"
    />,
  );
  expect(screen.getByTestId("seat-spacer").style.height).toBe("120px");
});

it("renders no spacer row when paddingBottom is 0", () => {
  render(
    <VirtualizedMessageList
      display={longConversation()}
      renderItem={(m) => <div>{m.id}</div>}
      data-testid="vlist"
    />,
  );
  expect(screen.queryByTestId("seat-spacer")).toBeNull();
});

it("lifts the jump button above the seat", () => {
  render(
    <VirtualizedMessageList
      display={longConversation()}
      renderItem={(m) => <div>{m.id}</div>}
      paddingBottom={120}
      data-testid="vlist"
    />,
  );
  expect(screen.getByTestId("jump-to-bottom")).toHaveStyle({ insetBlockEnd: "136px" });
});
```

注意断言的是 **spacer 行的高度**，不是 `virtua-list` 的 `style.paddingBottom`——见步骤 3，`paddingBottom` 不再落成 CSS padding。

`ChatView.test.tsx`：空会话已有 `empty-chat-prompt`。再断言空会话 **没有** `composer-seat`。找一条「有消息」的现成用例（约 385 行 `empty-chat-prompt` 为 null），断言出现 `data-testid="composer-seat"`。

- [ ] **步骤 2：运行确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/composerWheel.test.ts src/features/chat/VirtualizedMessageList.test.tsx src/features/chat/ChatView.test.tsx
```

预期：FAIL。

- [ ] **步骤 3：实现几何**

`composerWheel.ts` 先只导出：

```ts
export function scrollbarGutterPx(offsetWidth: number, clientWidth: number): number {
  const n = offsetWidth - clientWidth;
  return n > 0 ? n : 0;
}
```

`VirtualizedMessageListProps` 增加：

```ts
paddingBottom?: number;
onGutterChange?: (px: number) => void;
scrollRef?: React.Ref<TranscriptScrollHandle>;
```

```ts
export interface TranscriptScrollHandle {
  scrollBy: (deltaY: number) => void;
}
```

`paddingBottom` 默认 0。**不要**把它写成 VList 的 `style.paddingBottom`。

原因（已核对 virtua 0.49.3 `lib/index.js:343-344`）：`scrollToIndex` 的 `align:'end'` 落点是

```js
const a = () => e.p() - (t ? d.clientWidth : d.clientHeight);
l(() => i + c(...) + e.k(n) + ("end" === r ? e.R(n) - (e.p() - a()) : ...), s)
```

`e.p() - a()` 化简后就是视口元素的 **DOM `clientHeight`**。而 `clientHeight` 包含 padding，不会因 `padding-bottom` 变小。所以给滚动容器加 padding-bottom，`scrollToIndex(last, 'end')` 仍会把末条消息的底边贴在视口底边——正好压在座椅下面，规格 §1「末条消息底边在座椅顶之上」不成立。`scrollSize` 也只统计条目高度之和，不含 padding，`atBottom` 判定同样会偏。

正确做法：**把留白做成列表里的真实一行**。

- `hasFooter` 改为 `Boolean(footer) || paddingBottom > 0`（现在 `footer` 为 undefined 时根本不会追加尾行）。
- 尾行渲染 `<div data-testid="seat-spacer" style={{ height: paddingBottom }} />`。这一行**不要**套 `itemStyle`——`itemStyle` 有 `paddingBlock: 4`，会多加 8px，还会被 `CHAT_CONTENT_WIDTH` 限宽。
- 这样 `scrollToIndex(count - 1, 'end')` 把 spacer 的底边对齐视口底边，末条消息自然停在座椅顶之上；`scrollSize` 含 spacer，`atBottom` 判定也不用改。
- 有 footer（准备中占位）时，尾行同时渲染 footer 与 spacer，先后顺序无所谓，spacer 在后更直观。

jump 按钮：`data-testid="jump-to-bottom"`，底距写成 **inline style** `style={{ insetBlockEnd: paddingBottom + 16 }}`（`styles.jump` 是 `createStaticStyles`，静态样式插值不了运行时值，塞进去要么报类型错要么写死）。`styles.jump` 里那行 `inset-block-end: 16px` 删掉，避免和 inline 打架。

`useImperativeHandle(scrollRef, () => ({
  scrollBy(deltaY) {
    if (deltaY < 0) atBottomRef.current = false;
    ref.current?.scrollBy(deltaY);
  },
}))`.

量槽宽：`useLayoutEffect` + `ResizeObserver` 观察 `containerRef.current?.firstElementChild`（VList 根）。`onGutterChange?.(scrollbarGutterPx(el.offsetWidth, el.clientWidth))`。jsdom 里 stub 不回调，生产环境会调。

`ChatMessageItems` / `ChatListView` 把这三项原样往下传。

`ChatView.tsx` 非空分支改成（外层已是 column；改成相对盒子）：

```tsx
<div style={{ height: "100%", position: "relative", minHeight: 0, overflow: "hidden" }}>
  {showEmptyLayout ? (
    /* 现有居中分支，不要 composer-seat */
  ) : (
    <>
      <div style={{ position: "absolute", inset: 0 }}>
        {workspaceReady ? (
          <ChatListView
            paddingBottom={seatHeight}
            scrollRef={transcriptRef}
            onGutterChange={setGutter}
          />
        ) : (
          <ChatListSkeleton />
        )}
      </div>
      <div
        ref={seatRef}
        data-testid="composer-seat"
        style={{
          position: "absolute",
          left: 0,
          right: gutter,
          bottom: 0,
          zIndex: 3,
          background: cssVar.colorBgLayout,
        }}
      >
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: -36,
            height: 36,
            pointerEvents: "none",
            background: `linear-gradient(transparent, ${cssVar.colorBgLayout})`,
          }}
        />
        <div style={COMPOSE_COLUMN}>
          {retryIndicator}
          {compactingIndicator}
          {errorBanner}
          <motion.div layout layoutId={composeShellLayoutId(workspace)} transition={composeTransition} style={{ width: "100%" }} data-testid="chat-input-region">
            <ChatInput ... />
          </motion.div>
        </div>
      </div>
    </>
  )}
</div>
```

`useLayoutEffect` + `ResizeObserver` 观察 `seatRef`，`setSeatHeight(seat.offsetHeight)`。空会话不挂 observer、`seatHeight` 保持 0。

座椅底色先按 `cssVar.colorBgLayout` 写（antd `AliasToken` 有这个 token，`theme/index.ts:46` 也用过，类型没问题）。**但要核对：** `MainChatColumn.tsx` 没给列显式设背景，是继承 app shell。跑起来若座椅与上下出现色差缝，说明列底色其实是 `colorBgContainer`，把座椅跟着换掉即可——这条以肉眼为准，不要死守 token 名。

形变：空态 `layoutId` 仍在居中的 `chat-input-region`；非空态同一 id 在座椅里。规格验收「边框不跳宽」：两端都用 `COMPOSE_COLUMN`（`CHAT_CONTENT_WIDTH` + `marginInline: auto`）。不要为位移路径写死 pixel。

`ChatListView` props 目前无 props——给它加上上述三项。`ChatListView.test.tsx` 若按无 props 渲染，默认即可。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/composerWheel.test.ts src/features/chat/VirtualizedMessageList.test.tsx src/features/chat/ChatView.test.tsx src/features/chat/ChatListView.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/features/chat/composerWheel.ts electron-agent/src/features/chat/composerWheel.test.ts electron-agent/src/features/chat/VirtualizedMessageList.tsx electron-agent/src/features/chat/VirtualizedMessageList.test.tsx electron-agent/src/features/chat/ChatMessageItems.tsx electron-agent/src/features/chat/ChatListView.tsx electron-agent/src/features/chat/ChatListView.test.tsx electron-agent/src/features/chat/ChatView.tsx electron-agent/src/features/chat/ChatView.test.tsx
git commit -m @"
feat(chat): overlay composer seat and pad the transcript

"@
```

若 `ChatListView.test.tsx` 无改动则不要 add。

---

### 任务 7：滚轮转发

**文件：**
- 修改：`electron-agent/src/features/chat/composerWheel.ts`
- 修改：`electron-agent/src/features/chat/composerWheel.test.ts`
- 修改：`electron-agent/src/features/chat/ChatView.tsx`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.tsx`

- [ ] **步骤 1：编写失败测试**

`composerWheel.test.ts` 追加：

```ts
import { draftShouldForwardWheel } from "./composerWheel";

describe("draftShouldForwardWheel", () => {
  it("stays local while the draft can still move", () => {
    expect(draftShouldForwardWheel({ scrollTop: 40, clientHeight: 100, scrollHeight: 400, deltaY: 30 })).toBe(false);
    expect(draftShouldForwardWheel({ scrollTop: 40, clientHeight: 100, scrollHeight: 400, deltaY: -30 })).toBe(false);
  });

  it("forwards at the edges", () => {
    expect(draftShouldForwardWheel({ scrollTop: 300, clientHeight: 100, scrollHeight: 400, deltaY: 30 })).toBe(true);
    expect(draftShouldForwardWheel({ scrollTop: 0, clientHeight: 100, scrollHeight: 400, deltaY: -20 })).toBe(true);
  });

  it("forwards when the draft does not overflow", () => {
    expect(draftShouldForwardWheel({ scrollTop: 0, clientHeight: 100, scrollHeight: 100, deltaY: 20 })).toBe(true);
  });

  it("ignores deltaY 0", () => {
    expect(draftShouldForwardWheel({ scrollTop: 0, clientHeight: 100, scrollHeight: 100, deltaY: 0 })).toBe(false);
  });
});
```

判定：`deltaY === 0` → false；向上 `scrollTop <= 0` 才转发；向下 `scrollTop + clientHeight >= scrollHeight - 1` 才转发。中间不转发。

- [ ] **步骤 2：运行确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/composerWheel.test.ts
```

预期：FAIL，函数不存在。

- [ ] **步骤 3：实现接线**

```ts
export function draftShouldForwardWheel(p: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  deltaY: number;
}): boolean {
  if (p.deltaY === 0) return false;
  if (p.deltaY < 0) return p.scrollTop <= 0;
  return p.scrollTop + p.clientHeight >= p.scrollHeight - 1;
}
```

`ChatView`：座椅 `onWheel`（React 合成事件即可）：

```ts
const onSeatWheel = (e: React.WheelEvent) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest("[data-composer-draft]")) return; // 草稿自己处理
  if (t?.closest("[data-testid='composer-prompt-overlay']")) return;
  e.preventDefault();
  transcriptRef.current?.scrollBy(e.deltaY);
};
```

注意：React 的 `onWheel` 默认 passive，`preventDefault` 可能无效。座椅用 `useEffect` 在 `seatRef` 上 `addEventListener("wheel", handler, { passive: false })`，与 DSH InputBar 相同。空会话没有 seatRef 监听。

`MessageEditor` 的 `styles.body` 加 `data-composer-draft` 和 `ref={draftRef}`。draft 的监听**同样必须 `{ passive: false }`**——否则到边缘时 `preventDefault()` 无效，草稿会带着整列一起滚。用 `useEffect` 在 `draftRef` 上 `addEventListener("wheel", handler, { passive: false })`，不要图省事写 React `onWheel`。

```ts
const onWheel = (e: WheelEvent) => {
  const el = draftRef.current;
  if (!el) return;
  if (!draftShouldForwardWheel({
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    deltaY: e.deltaY,
  })) return;
  e.preventDefault();
  onTranscriptScroll?.(e.deltaY);
};
```

`onTranscriptScroll` 从 `ChatInputContext` 取。**增加可选字段 `scrollTranscript?: (deltaY: number) => void`**，可选意味着「不传即不转发」，不要额外再传一个 no-op 函数。`ChatView` 不直接渲染 `MessageEditor`，所以链路是：`ChatView` 把 `transcriptRef` 的 `scrollBy` 作为新 prop 传给 `ChatInput`，`ChatInput` 写进 context，`MessageEditor` 读出来用。

空会话没有座椅、没有 `ChatInput` 之外的注入，`scrollTranscript` 为 undefined，草稿的 wheel 走到 `?.` 就停，不转发。

座椅的 wheel 监听已经在 seat 上，draft 在 seat 内部、事件会冒泡上去，所以 seat 的 handler 里必须有 `t?.closest("[data-composer-draft]")` 那道分支（步骤 3 已写），否则边缘时会被转发两次。

`/` `@` 询问卡是 portal，不在 seat 里，座椅监听本来就打不到它们。它们自己滚动时不必转发。不要在 overlay 上加转发。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/composerWheel.test.ts src/features/chat/input/ComposerPromptOverlay.test.tsx src/features/chat/input/editor/MessageEditor.test.tsx src/features/chat/ChatView.test.tsx
```

预期：PASS。Overlay 测试仍绿（pop 不进 padding——padding 由座椅高度决定，overlay portal 不在 seat 里）。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/features/chat/composerWheel.ts electron-agent/src/features/chat/composerWheel.test.ts electron-agent/src/features/chat/ChatView.tsx electron-agent/src/features/chat/ChatInput.tsx electron-agent/src/features/chat/input/ChatInputContext.tsx electron-agent/src/features/chat/input/editor/MessageEditor.tsx
git commit -m @"
feat(chat): forward composer-seat wheel to the transcript

"@
```

只 add 实际改过的文件。若 `ChatInput.tsx` / context 未改到则不要列。

---

### 任务 8：回归与预览收尾

**文件：**
- 修改：任务 3 若 preview 已改则本任务只跑回归；否则改 `electron-agent/src/preview.tsx`
- 已有测试：`groupMessages`、`GoalPill`、`extensionCards`、`ChatView`、`TodoDock`、`ToolExecution`

- [ ] **步骤 1：跑相关测试包**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run _shared/todo-model.test.ts todo/todo.test.ts
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat src/features/tools/ToolExecution.test.tsx src/features/tools/extensionCards.test.tsx src/features/chat/input
```

预期：全部 PASS。若失败，修在本任务，不要开新范围。

确认清单（对照规格 §8，缺哪条补哪条测试，不要口头声称）：

- 对话流无 `card-todo`，有「更新任务清单」
- `generate_image` 仍是独立卡（现有 extensionCards 用例）
- 空会话有 `empty-chat-prompt`、无 `composer-seat`
- 非空有 `composer-seat`
- GoalPill 在 surface 外
- 任务条空 DOM / 折叠无任务名 / 180px
- reconstruct 跳过 isError / details.error
- jump `insetBlockEnd` 随 paddingBottom

- [ ] **步骤 2：Commit（仅当本任务还有文件变更）**

```powershell
git add <实际改动>
git commit -m @"
test(chat): cover composer dock and full-height scrollbar

"@
```

无文件变更则不要空 commit。

---

## 自检

### 规格覆盖

| 规格 | 任务 |
| --- | --- |
| §3 列表 `inset:0`、座椅贴底、留白、36px 渐隐 | 6（留白走尾行 spacer，不是 CSS padding） |
| §3 槽宽 = VList 根 `offsetWidth-clientWidth`；覆盖式 right=0 | 6 `scrollbarGutterPx` + `onGutterChange` |
| §3 内层 `CHAT_CONTENT_WIDTH` 与消息列同中线 | 6 COMPOSE_COLUMN |
| §3 jump = paddingBottom+16 | 6 inline style |
| §3 空会话居中、无座椅 | 6 ChatView 分支 |
| §3 layoutId 不写死位移 | 6 保留 layoutId |
| §3 MiniMap 不动 | 未改 ChatMiniMap |
| §4 叠层顺序任务→目标→排队→工作区→审批→surface | 5 |
| §4.1 任务条折叠/计数/180px/并行 in_progress | 4 |
| §4.2 Goal 搬出 surface，完成态仍显示，删 goalSlot | 5 |
| §4.3 SteerQueue 不折叠、套 card | 5 |
| §5.1 整表覆盖、非法 id、空数组清空 | 2 |
| §5.2 / §7 扩展侧 isError + details.error | 2 reconstruct |
| §5.3 `_shared/todo-model` + alias | 1 + 3 |
| §5.3 非流式、渲染侧 status===done | 4 latestTodos |
| §5.4 ConvRow 一行、拆 generate_image、删 TodoCard | 3 |
| §5.4 groupMessages 不变 | 3 回归 |
| §6 滚轮：外壳转发、草稿边缘、pop 不转发、空不转发 | 7 |
| §6 判定 `styles.body` 不是 contenteditable | 7 `data-composer-draft` |
| §8 测试表 | 各任务 + 8 |
| 非目标：子代理 / 假滚动条 / 持久折叠 / 并行开关 | 未做 |

### 占位符

无 TODO / 待定 /「类似任务 N」。

### 类型一致性

- `Todo` / `TodoState` / `todoSummary` / `normalizeTodos` 只定义在 `_shared/todo-model.ts`。
- `TranscriptScrollHandle.scrollBy(deltaY: number)` 任务 6 定义，任务 7 调用。
- `paddingBottom` 单位 px 数字。只用于两处：尾行 spacer 的 `style.height`、jump 按钮的 `insetBlockEnd`。**不进 VList 的 style。**
- 扩展 `execute` 的返回值严格是 `AgentToolResult<TodoDetails>`：`content` + `details`，没有 `isError`。
- 渲染成功判据始终 `status === "done"`，扩展始终 `isError !== true`。
- `TodoDockFromStore` 与 `TodoDock` 同文件；MessageEditor 只挂 FromStore。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-09-15-composer-dock-scrollbar.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
