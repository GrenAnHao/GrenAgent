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
