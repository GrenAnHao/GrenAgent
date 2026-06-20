import { afterEach, describe, expect, it } from "vitest";
import fableBehavior from "./index.js";
import { buildFableBehaviorPrompt } from "./loader.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function makePi() {
  const handlers: Record<string, Handler> = {};
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers[event] = handler;
    },
    registerTool: () => {},
    registerCommand: () => {},
  } as never;
  return { pi, handlers };
}

const ctxWithMode = (mode: string) => ({
  sessionManager: {
    getEntries: () => [{ type: "custom", customType: "agent-mode", data: { mode } }],
  },
});

afterEach(() => {
  delete process.env.FABLE_BEHAVIOR;
  delete process.env.FABLE_BEHAVIOR_TIER2;
  delete process.env.FABLE_BEHAVIOR_TIER2_P1;
  delete process.env.FABLE_BEHAVIOR_TIER3_GUIDELINES;
  delete process.env.FABLE_BEHAVIOR_TIER3_TOOL;
});

describe("fable-behavior extension", () => {
  it("injects non-empty before_agent_start message with display:false", async () => {
    const { pi, handlers } = makePi();
    fableBehavior(pi);
    const res = (await handlers["before_agent_start"]({}, ctxWithMode("agent"))) as
      | { message?: { content?: string; display?: boolean; customType?: string } }
      | undefined;
    expect(res?.message?.content?.length).toBeGreaterThan(200);
    expect(res?.message?.content).toContain("[Fable Behavior]");
    expect(res?.message?.display).toBe(false);
    expect(res?.message?.customType).toBe("fable-behavior");
  });

  it("applies plan mode slice from session agent-mode entry", async () => {
    const { pi, handlers } = makePi();
    fableBehavior(pi);
    const res = (await handlers["before_agent_start"]({}, ctxWithMode("plan"))) as
      | { message?: { content?: string } }
      | undefined;
    expect(res?.message?.content?.toLowerCase()).toMatch(/explore|read-only|plan/);
  });

  it("FABLE_BEHAVIOR=0 skips injection", async () => {
    process.env.FABLE_BEHAVIOR = "0";
    const { pi, handlers } = makePi();
    fableBehavior(pi);
    const res = await handlers["before_agent_start"]({}, ctxWithMode("agent"));
    expect(res).toBeUndefined();
  });

  it("FABLE_BEHAVIOR_TIER2=0 omits tier2 modules", async () => {
    process.env.FABLE_BEHAVIOR_TIER2 = "0";
    const { pi, handlers } = makePi();
    fableBehavior(pi);
    const res = (await handlers["before_agent_start"]({}, ctxWithMode("agent"))) as
      | { message?: { content?: string } }
      | undefined;
    const content = res?.message?.content ?? "";
    expect(content).toContain("## Coding harness");
    expect(content).not.toContain("Tool discipline");
  });

  it("FABLE_BEHAVIOR_TIER2_P1=0 omits extended tier2", async () => {
    process.env.FABLE_BEHAVIOR_TIER2_P1 = "0";
    const { pi, handlers } = makePi();
    fableBehavior(pi);
    const res = (await handlers["before_agent_start"]({}, ctxWithMode("agent"))) as
      | { message?: { content?: string } }
      | undefined;
    const content = res?.message?.content ?? "";
    expect(content).toContain("Tool discipline");
    expect(content).not.toContain("Delegation");
  });

  it("registers fable_behavior_ref by default", () => {
    const tools: string[] = [];
    const pi = {
      on: () => {},
      registerTool: (t: { name: string }) => tools.push(t.name),
      registerCommand: () => {},
    } as never;
    fableBehavior(pi);
    expect(tools).toContain("fable_behavior_ref");
  });

  it("FABLE_BEHAVIOR_TIER3_TOOL=0 skips ref tool", () => {
    process.env.FABLE_BEHAVIOR_TIER3_TOOL = "0";
    const tools: string[] = [];
    const pi = {
      on: () => {},
      registerTool: (t: { name: string }) => tools.push(t.name),
      registerCommand: () => {},
    } as never;
    fableBehavior(pi);
    expect(tools).not.toContain("fable_behavior_ref");
  });
});

describe("buildFableBehaviorPrompt snapshot", () => {
  it("stable header and tier1 markers", () => {
    const p = buildFableBehaviorPrompt({ date: "2026-06-20" });
    expect(p.slice(0, 80)).toMatch(/^\[Fable Behavior\]/);
    expect(p).toContain("Current date: 2026-06-20");
  });
});
