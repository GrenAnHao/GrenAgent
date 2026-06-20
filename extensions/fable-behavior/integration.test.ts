import { describe, expect, it } from "vitest";
import agentMode from "../agent-mode/index.js";
import diagramHint, { DIAGRAM_HINT } from "../diagram-hint/index.js";
import fableBehavior from "./index.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function makeSidecarPi() {
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers[event] = handlers[event] ?? [];
      handlers[event].push(handler);
    },
    registerTool: () => {},
    registerCommand: () => {},
    appendEntry: () => {},
    sendMessage: () => {},
    setActiveTools: () => {},
    getActiveTools: () => [],
    ui: { setStatus: () => {}, notify: () => {} },
  } as never;
  return { pi, handlers };
}

const planCtx = {
  sessionManager: {
    getEntries: () => [{ type: "custom", customType: "agent-mode", data: { mode: "plan" } }],
    getBranch: () => [],
  },
  ui: { setStatus: () => {} },
};

describe("sidecar injection coexistence", () => {
  it("fable-behavior, diagram-hint, and agent-mode inject distinct hidden messages in plan mode", async () => {
    const { pi, handlers } = makeSidecarPi();
    diagramHint(pi);
    fableBehavior(pi);
    agentMode(pi);

    const beforeStart = handlers["before_agent_start"] ?? [];
    expect(beforeStart.length).toBe(3);

    const sessionStart = handlers["session_start"]?.[0];
    if (sessionStart) await sessionStart({}, planCtx);

    const results = await Promise.all(beforeStart.map((h) => h({}, planCtx)));
    const messages = results
      .map((r) => (r as { message?: { customType?: string; content?: string; display?: boolean } })?.message)
      .filter((m) => m?.content);

    expect(messages.length).toBeGreaterThanOrEqual(2);

    const fable = messages.find((m) => m?.customType === "fable-behavior");
    expect(fable?.display).toBe(false);
    expect(fable?.content).toContain("[Fable Behavior]");
    expect(fable?.content).toContain("Ground in the environment");

    const diagram = messages.find((m) => m?.customType === "diagram-hint");
    expect(diagram?.content).toBe(DIAGRAM_HINT);

    const mode = messages.find((m) => m?.customType === "agent-mode-context");
    if (mode) expect(mode.content).toContain("PLAN MODE");
  });
});
