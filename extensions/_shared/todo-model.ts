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
