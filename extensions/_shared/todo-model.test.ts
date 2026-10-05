import { describe, expect, it } from "vitest";
import { closeFinishedTodos, emptyTodoState, normalizeTodos, todoListFinishedInTranscript, todoSummary } from "./todo-model.js";

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

  it("maps status done onto completed", () => {
    const n = normalizeTodos({
      todos: [
        { id: 1, text: "注册", status: "done" },
        { id: 2, text: "还在写", status: "in progress" },
      ],
      nextId: 3,
    });
    expect(n?.todos).toEqual([
      { id: 1, text: "注册", status: "completed" },
      { id: 2, text: "还在写", status: "in_progress" },
    ]);
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

describe("closeFinishedTodos", () => {
  const list = [
    { id: 1, text: "已完成", status: "completed" as const },
    { id: 2, text: "收尾", status: "in_progress" as const },
  ];

  it("closes leftover in_progress when nothing is pending", () => {
    expect(closeFinishedTodos(list)).toEqual([
      { id: 1, text: "已完成", status: "completed" },
      { id: 2, text: "收尾", status: "completed" },
    ]);
  });

  it("leaves the list alone while a pending item remains", () => {
    expect(closeFinishedTodos([...list, { id: 3, text: "还没做", status: "pending" }])).toBeNull();
  });

  it("leaves an already closed list alone", () => {
    expect(closeFinishedTodos([{ id: 1, text: "已完成", status: "completed" }])).toBeNull();
  });
});

describe("todoListFinishedInTranscript", () => {
  const done = {
    role: "toolResult",
    toolName: "todo",
    details: { todos: [{ id: 1, text: "注册", status: "completed" }], nextId: 2 },
  };
  const tail = {
    role: "toolResult",
    toolName: "todo",
    details: { todos: [{ id: 1, text: "注册", status: "in_progress" }], nextId: 2 },
  };

  it("is finished when every item is completed", () => {
    expect(todoListFinishedInTranscript([done])).toBe(true);
  });

  it("is finished when a normal stop follows an in_progress tail with nothing pending", () => {
    expect(todoListFinishedInTranscript([tail, { role: "assistant", stopReason: "stop" }])).toBe(true);
  });

  it("stays unfinished while pending remains or the turn was aborted", () => {
    expect(todoListFinishedInTranscript([
      { role: "toolResult", toolName: "todo", details: { todos: [{ id: 1, text: "还没做", status: "pending" }], nextId: 2 } },
      { role: "assistant", stopReason: "stop" },
    ])).toBe(false);
    expect(todoListFinishedInTranscript([tail, { role: "assistant", stopReason: "aborted" }])).toBe(false);
  });
});
