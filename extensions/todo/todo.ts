export type { Todo, TodoState, TodoStatus } from "../_shared/todo-model.js";
export { emptyTodoState, normalizeTodos } from "../_shared/todo-model.js";

import {
  closeFinishedTodos,
  coerceTodoStatus,
  emptyTodoState,
  isPositiveInt,
  normalizeTodos,
  type Todo,
  type TodoState,
  type TodoStatus,
} from "../_shared/todo-model.js";

export interface TodoWriteInput {
  todos: Array<{ id?: number; text: string; status: string }>;
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
    if (!coerceTodoStatus(row.status)) return { state, message: "Error: invalid status", error: "invalid status" };
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
    return { id, text, status: coerceTodoStatus(row.status) as TodoStatus };
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

interface TodoContextMessage {
  role?: string;
  toolName?: string;
  stopReason?: string;
  isError?: boolean;
  content?: unknown;
  details?: unknown;
}

/**
 * 本轮正常 stop 且没有 pending 时，把进行中收成 completed。
 * 下一轮用户消息已经出现，且清单已经做完时，改成空列表。
 */
export function closeTodosInContext<T extends TodoContextMessage>(messages: readonly T[]): T[] | undefined {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "toolResult" || message.toolName !== "todo" || message.isError === true) continue;
    if (typeof message.details !== "object" || message.details === null) continue;
    if ("error" in message.details && (message.details as { error?: unknown }).error != null) continue;
    index = i;
    break;
  }
  if (index < 0) return undefined;

  let stopAfterTodo: string | undefined;
  for (let i = messages.length - 1; i > index; i--) {
    if (messages[i]?.role !== "assistant") continue;
    stopAfterTodo = messages[i]?.stopReason;
    break;
  }
  const current = messages[index];
  const normalized = normalizeTodos(current.details);
  if (!normalized) return undefined;
  const laterUser = messages.slice(index + 1).some((message) => message?.role === "user");
  const noPending = normalized.todos.length > 0 && !normalized.todos.some((todo) => todo.status === "pending");
  const allCompleted = noPending && normalized.todos.every((todo) => todo.status === "completed");
  if (laterUser && (allCompleted || (noPending && stopAfterTodo === "stop"))) {
    return replaceTodoMessage(messages, index, current, [], normalized.nextId);
  }
  if (stopAfterTodo !== "stop") return undefined;
  const closed = closeFinishedTodos(normalized.todos);
  if (!closed) return undefined;
  return replaceTodoMessage(messages, index, current, closed, normalized.nextId);
}

function replaceTodoMessage<T extends TodoContextMessage>(
  messages: readonly T[],
  index: number,
  current: T,
  todos: Todo[],
  nextId: number,
): T[] {
  const text = countMessage(todos);
  const content = Array.isArray(current.content)
    ? current.content.map((part, partIndex) => {
        if (partIndex !== 0 || typeof part !== "object" || part === null) return part;
        if ((part as { type?: unknown }).type !== "text") return part;
        return { ...part, text };
      })
    : current.content;
  const next = messages.slice();
  next[index] = {
    ...current,
    content,
    details: { ...(current.details as object), todos, nextId },
  };
  return next;
}
