import { describe, expect, it, vi, afterEach } from "vitest";
import { registerGoalTools } from "./tools.js";

type Def = { name: string; execute: (...args: any[]) => Promise<any> };
function setup(request: ReturnType<typeof vi.fn>) {
  const defs: Def[] = [];
  registerGoalTools({ registerTool: (d: Def) => defs.push(d) } as never, { request } as never);
  const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "session-a" } } as any;
  return { defs, ctx };
}

afterEach(() => {
  delete process.env.PI_IS_SUBAGENT;
  delete process.env.PI_SYSTEM_WORKER;
  delete process.env.PI_GOAL_WORKER;
  delete process.env.PI_TURN_ORIGIN;
  delete process.env.PI_INPUT_ORIGIN;
  delete process.env.PI_GOAL_ORIGIN;
  delete process.env.PI_HUMAN_ORIGIN_TOKEN;
});

describe("goal tools", () => {
  it("registers the four AgentData-backed tools", () => {
    const { defs } = setup(vi.fn());
    expect(defs.map((d) => d.name)).toEqual(["get_goal", "create_goal", "update_goal", "request_goal_completion"]);
  });

  it("injects session and workspace from context, ignoring model scope fields", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const { defs, ctx } = setup(request);
    await defs[0].execute("id", { sessionId: "forged", workspace: "/evil" }, undefined, undefined, ctx);
    expect(request).toHaveBeenCalledWith("goal.get", { sessionId: "session-a", workspace: "/repo" });
  });

  it("forbids create from automatic workers", async () => {
    process.env.PI_GOAL_WORKER = "1";
    const request = vi.fn();
    const { defs, ctx } = setup(request);
    await expect(defs[1].execute("id", { condition: "x", continuousIntentEvidence: "直到完成" }, undefined, undefined, ctx)).rejects.toThrow("GOAL_CREATE_FORBIDDEN");
    expect(request).not.toHaveBeenCalled();
  });

  it("requires a trusted human origin token for create", async () => {
    const request = vi.fn().mockResolvedValue({ goalId: "g", sessionId: "session-a", workspace: "/repo", revision: 1 });
    const { defs, ctx } = setup(request);
    await expect(defs[1].execute("id", { condition: "x", continuousIntentEvidence: "直到完成" }, undefined, undefined, ctx)).rejects.toThrow("GOAL_CREATE_FORBIDDEN");
    process.env.PI_TURN_ORIGIN = "human";
    await defs[1].execute("id", { condition: "x", continuousIntentEvidence: "直到完成" }, undefined, undefined, ctx);
    expect(request).toHaveBeenCalledWith("goal.create", expect.objectContaining({ sessionId: "session-a", workspace: "/repo", continuousIntentEvidence: "直到完成" }));
  });

  it("sends update CAS with current context scope and goal reference", async () => {
    const request = vi.fn().mockResolvedValue({ goalId: "g", sessionId: "session-a", workspace: "/repo", revision: 2 });
    const { defs, ctx } = setup(request);
    await defs[2].execute("id", { goalId: "g", revision: 1, action: "block", summary: "waiting" }, undefined, undefined, ctx);
    expect(request).toHaveBeenCalledWith("goal.update", expect.objectContaining({ sessionId: "session-a", workspace: "/repo", goalId: "g", revision: 1, action: "block" }));
  });

  it.each([
    ["missing goalId", { sessionId: "session-a", workspace: "/repo", revision: 1 }],
    ["empty goalId", { goalId: "", sessionId: "session-a", workspace: "/repo", revision: 1 }],
    ["blank goalId", { goalId: "   ", sessionId: "session-a", workspace: "/repo", revision: 1 }],
    ["missing revision", { goalId: "g", sessionId: "session-a", workspace: "/repo" }],
    ["zero revision", { goalId: "g", sessionId: "session-a", workspace: "/repo", revision: 0 }],
    ["fractional revision", { goalId: "g", sessionId: "session-a", workspace: "/repo", revision: 1.5 }],
    ["string revision", { goalId: "g", sessionId: "session-a", workspace: "/repo", revision: "1" }],
  ])("rejects malformed non-empty get response: %s", async (_name, snapshot) => {
    const request = vi.fn().mockResolvedValue(snapshot);
    const { defs, ctx } = setup(request);
    await expect(defs[0].execute("id", {}, undefined, undefined, ctx)).rejects.toThrow("INVALID_GOAL_RESPONSE");
  });

  it.each([
    ["missing goalId", { sessionId: "session-a", workspace: "/repo", revision: 1 }],
    ["blank goalId", { goalId: "   ", sessionId: "session-a", workspace: "/repo", revision: 1 }],
    ["missing revision", { goalId: "g", sessionId: "session-a", workspace: "/repo" }],
    ["zero revision", { goalId: "g", sessionId: "session-a", workspace: "/repo", revision: 0 }],
  ])("rejects malformed create response: %s", async (_name, snapshot) => {
    process.env.PI_TURN_ORIGIN = "human";
    const request = vi.fn().mockResolvedValue(snapshot);
    const { defs, ctx } = setup(request);
    await expect(defs[1].execute("id", { condition: "x", continuousIntentEvidence: "直到完成" }, undefined, undefined, ctx)).rejects.toThrow("INVALID_GOAL_RESPONSE");
  });

  it("rejects a create response whose initial revision is not one", async () => {
    process.env.PI_TURN_ORIGIN = "human";
    const request = vi.fn().mockResolvedValue({ goalId: "g", sessionId: "session-a", workspace: "/repo", revision: 2 });
    const { defs, ctx } = setup(request);
    await expect(defs[1].execute("id", { condition: "x", continuousIntentEvidence: "直到完成" }, undefined, undefined, ctx)).rejects.toThrow("INVALID_GOAL_RESPONSE");
  });
});
