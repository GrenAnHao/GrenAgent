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

/** 模型常把完成写成 done。未知值返回 null，由调用方决定拒绝还是回退。 */
export function coerceTodoStatus(value: unknown): TodoStatus | null {
  if (typeof value !== "string") return null;
  const status = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (status === "completed" || status === "complete" || status === "done" || status === "finished") return "completed";
  if (status === "in_progress" || status === "doing" || status === "running" || status === "active" || status === "started") {
    return "in_progress";
  }
  if (status === "pending" || status === "todo" || status === "open") return "pending";
  return null;
}

/**
 * 回合已正常结束，且没有待处理项时，剩下的进行中就是已经做完、却没被标完成的尾巴。
 * 仍有 pending，或没有 in_progress 时不改。
 */
export function closeFinishedTodos(todos: readonly Todo[]): Todo[] | null {
  if (!todos.some((todo) => todo.status === "in_progress")) return null;
  if (todos.some((todo) => todo.status === "pending")) return null;
  return todos.map((todo) => (todo.status === "in_progress" ? { ...todo, status: "completed" } : todo));
}

export interface TodoTranscriptMessage {
  role?: unknown;
  toolName?: unknown;
  stopReason?: unknown;
  isError?: unknown;
  details?: unknown;
}

function transcriptToolName(message: TodoTranscriptMessage): string {
  return typeof message.toolName === "string" ? message.toolName.toLowerCase() : "";
}

/** 最近一次成功 todo 是否已经做完：全是 completed，或正常 stop 后只剩进行中尾巴。 */
export function todoListFinishedInTranscript(messages: readonly TodoTranscriptMessage[]): boolean {
  let index = -1;
  let todos: Todo[] | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "toolResult" || transcriptToolName(message) !== "todo" || message.isError === true) continue;
    if (typeof message.details !== "object" || message.details === null) continue;
    if ("error" in message.details && (message.details as { error?: unknown }).error != null) continue;
    const normalized = normalizeTodos(message.details);
    if (!normalized) continue;
    index = i;
    todos = normalized.todos;
    break;
  }
  if (!todos || todos.length === 0 || index < 0) return false;
  if (todos.some((todo) => todo.status === "pending")) return false;
  if (todos.every((todo) => todo.status === "completed")) return true;
  for (let i = messages.length - 1; i > index; i--) {
    if (messages[i]?.role !== "assistant") continue;
    return messages[i]?.stopReason === "stop";
  }
  return false;
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
    const status: TodoStatus = coerceTodoStatus(item.status)
      ?? (item.done === true ? "completed" : "pending");
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
