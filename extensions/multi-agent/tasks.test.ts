import { describe, expect, it } from "vitest";
import { closedChainSteps, closedParallelTasks, closedTopLevelString, normalizeTasks, spawnHasWork } from "./tasks.js";

describe("normalizeTasks", () => {
  it("single task", () => {
    expect(normalizeTasks({ task: "do x", model: "m" })).toEqual([{ task: "do x", model: "m", agent: undefined }]);
  });
  it("parallel string + object tasks (object agent overrides call agent)", () => {
    expect(normalizeTasks({ agent: "base", tasks: ["a", { task: "b", agent: "spec", model: "m" }] })).toEqual([
      { task: "a", agent: "base" },
      { task: "b", model: "m", agent: "spec" },
    ]);
  });
  it("ignores empty/whitespace tasks", () => {
    expect(normalizeTasks({ task: "   ", tasks: ["", "  ok  "] })).toEqual([{ task: "ok", agent: undefined }]);
  });
  it("chain is NOT folded into the normalized task list", () => {
    expect(normalizeTasks({ chain: [{ task: "s1" }, { task: "s2" }] })).toEqual([]);
  });
});

describe("spawnHasWork", () => {
  it("task / tasks count as work", () => {
    expect(spawnHasWork({ task: "x" })).toBe(true);
    expect(spawnHasWork({ tasks: ["x"] })).toBe(true);
  });
  // Regression: chain-only calls used to be rejected with "provide task or tasks"
  // because the guard ran normalizeTasks() (which ignores chain) before the chain branch.
  it("chain-only counts as work (the regression that broke chain)", () => {
    expect(spawnHasWork({ chain: [{ task: "s1" }, { task: "s2" }] })).toBe(true);
  });
  it("truly empty params are not work", () => {
    expect(spawnHasWork({})).toBe(false);
    expect(spawnHasWork({ tasks: [], chain: [] })).toBe(false);
  });
});

describe("closedParallelTasks", () => {
  it("ignores an unclosed task string and keeps the closed ones", () => {
    expect(closedParallelTasks('{"tasks":["review server","review desk')).toEqual([{ task: "review server" }]);
  });

  it("waits for an object to close before taking its task and model", () => {
    const partial = '{"tasks":[{"task":"review server","model":"a/b"';
    expect(closedParallelTasks(partial)).toEqual([]);
    expect(closedParallelTasks(`${partial}}]`)).toEqual([{ task: "review server", model: "a/b" }]);
  });

  it("does not treat the word tasks inside a string as the array", () => {
    expect(closedParallelTasks('{"task":"tasks: later","tasks":["real"]}')).toEqual([{ task: "real" }]);
  });

  it("keeps a closed title and waits for the object to close", () => {
    const partial = '{"tasks":[{"title":"审服务端","task":"请完整审查服务端"';
    expect(closedParallelTasks(partial)).toEqual([]);
    expect(closedParallelTasks(`${partial}}]`)).toEqual([
      { task: "请完整审查服务端", model: undefined, agent: undefined, title: "审服务端" },
    ]);
  });
});

describe("closedChainSteps", () => {
  it("returns only closed steps, including title", () => {
    const raw = '{"chain":[{"title":"第一步","task":"做甲"},{"title":"第二';
    expect(closedChainSteps(raw)).toEqual([
      { task: "做甲", model: undefined, agent: undefined, title: "第一步" },
    ]);
  });
});

describe("closedTopLevelString", () => {
  it("reads a closed top-level title and ignores nested titles", () => {
    expect(closedTopLevelString('{"title":"审服务端","task":"全文"}', "title")).toBe("审服务端");
    expect(closedTopLevelString('{"tasks":[{"title":"嵌套"}],"title":"顶层"}', "title")).toBe("顶层");
    expect(closedTopLevelString('{"tasks":[{"title":"嵌套"}]}', "title")).toBeUndefined();
  });

  it("returns null while the top-level title string is still open", () => {
    expect(closedTopLevelString('{"title":"审', "title")).toBeNull();
  });
});
