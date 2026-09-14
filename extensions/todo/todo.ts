export type { Todo, TodoState, TodoStatus } from "../_shared/todo-model.js";
export { emptyTodoState, normalizeTodos } from "../_shared/todo-model.js";

import {
  emptyTodoState,
  isPositiveInt,
  isTodoStatus,
  normalizeTodos,
  type Todo,
  type TodoState,
  type TodoStatus,
} from "../_shared/todo-model.js";

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
