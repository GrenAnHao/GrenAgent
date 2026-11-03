import { beforeEach, describe, expect, it } from "vitest";
import { setSessionPlan, __resetPlanStateForTest, isExecutingMode, planBlocksModeSwitch } from "./planState.js";
import type { Plan } from "./plan.js";

function plan(status: Plan["status"]): Plan {
  return {
    id: "p1",
    title: "t",
    goal: "g",
    steps: [{ text: "a", done: false }],
    risks: [],
    status,
    rev: 1,
    createdAt: 1,
    updatedAt: 1,
    updatedBy: "model",
  };
}

beforeEach(() => __resetPlanStateForTest());

describe("isExecutingMode", () => {
  it("treats ultra like agent/debug: full toolset, needs a confirmed plan", () => {
    for (const mode of ["agent", "debug", "ultra"] as const) {
      expect(isExecutingMode(mode)).toBe(true);
    }
    expect(isExecutingMode("ask")).toBe(false);
    expect(isExecutingMode("plan")).toBe(false);
  });
});

describe("planBlocksModeSwitch", () => {
  it("blocks switching into ultra while the plan is unconfirmed", () => {
    setSessionPlan("s1", plan("ready"));
    expect(planBlocksModeSwitch("s1", "ultra")).toBe(true);
    expect(planBlocksModeSwitch("s1", "agent")).toBe(true);
    expect(planBlocksModeSwitch("s1", "ask")).toBe(false);
    expect(planBlocksModeSwitch("s1", "plan")).toBe(false);
  });

  it("does not block once the plan is confirmed and executing", () => {
    setSessionPlan("s1", plan("executing"));
    expect(planBlocksModeSwitch("s1", "ultra")).toBe(false);
  });

  it("does not block when the session has no plan", () => {
    expect(planBlocksModeSwitch("s1", "ultra")).toBe(false);
    expect(planBlocksModeSwitch(undefined, "ultra")).toBe(false);
  });
});
