import { describe, expect, it } from "vitest";
import { buildFableBehaviorPrompt, estimatePromptTokens, readTier3Module, resolveAgentModeFromEntries } from "./loader.js";

describe("buildFableBehaviorPrompt", () => {
  it("defaults to the behavior kernel without tool manuals or tier-3 summaries", () => {
    const p = buildFableBehaviorPrompt({ date: "2026-06-20" });
    expect(p).toContain("[Fable Behavior]");
    expect(p).toContain("GrenAgent");
    expect(p).toContain("Autonomy");
    expect(p).not.toContain("Refusal");
    expect(p).toContain("index check");
    expect(p).toContain("Current date: 2026-06-20");
    expect(p).not.toContain("Tool discipline");
    expect(p).not.toContain("Grep and glob strategy");
    expect(p).not.toContain("MCP collaboration");
    expect(p).not.toContain("Delegation");
    expect(p).not.toContain("Quick reference");
    expect(p).not.toMatch(/expert coding agent|Your job is to help the user/i);
    expect(p).not.toContain("ask_user");
    expect(p).not.toContain("## Agent mode");
    expect(p).not.toContain("mermaid");
    expect(p).not.toMatch(/`grep`|`find`|`ls`/);
  });

  it("keeps opt-in tool manuals when tier2 is explicitly enabled", () => {
    const p = buildFableBehaviorPrompt({ tier2: true, tier2P1: true, tier3Guidelines: false });
    expect(p).toContain("Tool discipline");
    expect(p).toContain("Grep and glob strategy");
    expect(p).toContain("Delegation");
  });

  it("adds debug mode slice with hypothesis-first evidence steps", () => {
    const p = buildFableBehaviorPrompt({ mode: "debug" });
    expect(p).toContain("Hypothesize");
    expect(p).toContain("debug_log");
  });

  it("readTier3Module returns citing-code body", () => {
    const text = readTier3Module("citing-code");
    expect(text).toContain("startLine:endLine:filepath");
    expect(readTier3Module("nope")).toBeUndefined();
  });

  it("adds ask mode slice", () => {
    const p = buildFableBehaviorPrompt({ mode: "ask" });
    expect(p.toLowerCase()).toContain("read-only");
  });

  it("adds plan mode slice with three phases", () => {
    const p = buildFableBehaviorPrompt({ mode: "plan" });
    expect(p).toContain("Explore the repo first");
    expect(p).toContain("decision-complete");
  });

  it("does not restack ask_user on the default agent kernel", () => {
    const p = buildFableBehaviorPrompt({ mode: "agent" });
    expect(p).not.toContain("ask_user");
    expect(p).not.toContain("## Agent mode");
  });

  it("legacy brainstorm does not inject a mode slice", () => {
    expect(buildFableBehaviorPrompt({ mode: "brainstorm" as never })).toBe(buildFableBehaviorPrompt({ mode: "agent" }));
  });

  it("adds tier3 summary only when explicitly enabled", () => {
    const p = buildFableBehaviorPrompt({ tier3Guidelines: true });
    expect(p).toContain("Quick reference");
    expect(p).toContain("Copyright");
  });

  it("tier2 without P1 omits extended manuals", () => {
    const p = buildFableBehaviorPrompt({ tier2: true, tier2P1: false });
    expect(p).toContain("Tool discipline");
    expect(p).not.toContain("Delegation");
    expect(p).not.toContain("Terminal and runtime harness");
  });

  it("token budget stays under 1.5k for the default kernel", () => {
    expect(estimatePromptTokens({ mode: "agent" })).toBeLessThan(1500);
  });
});

describe("resolveAgentModeFromEntries", () => {
  it("reads agent-mode session entry", () => {
    const mode = resolveAgentModeFromEntries([
      { type: "custom", customType: "agent-mode", data: { mode: "plan" } },
    ]);
    expect(mode).toBe("plan");
  });

  it("defaults to agent", () => {
    expect(resolveAgentModeFromEntries([])).toBe("agent");
  });
});

describe("resolveAgentModeFromEntries — removed brainstorm", () => {
  it.each(["agent-mode", "session-controls"])("restores Agent when latest %s entry was brainstorm", (customType) => {
    const entries = [
      { type: "custom", customType: "agent-mode", data: { mode: "plan" } },
      { type: "custom", customType, data: { mode: "brainstorm" } },
    ];
    expect(resolveAgentModeFromEntries(entries)).toBe("agent");
  });

  it("falls back to agent for unknown mode", () => {
    const entries = [
      { type: "custom", customType: "agent-mode", data: { mode: "unknown" } },
    ];
    expect(resolveAgentModeFromEntries(entries)).toBe("agent");
  });
});

describe("resolveAgentModeFromEntries — ultra", () => {
  it("recognizes ultra from the agent-mode entry", () => {
    expect(resolveAgentModeFromEntries([
      { type: "custom", customType: "agent-mode", data: { mode: "ultra" } },
    ])).toBe("ultra");
  });

  it("recognizes ultra from a host-written session-controls entry", () => {
    expect(resolveAgentModeFromEntries([
      { type: "custom", customType: "session-controls", data: { mode: "ultra" } },
    ])).toBe("ultra");
  });

  it("takes the latest known entry across both sources", () => {
    expect(resolveAgentModeFromEntries([
      { type: "custom", customType: "agent-mode", data: { mode: "ultra" } },
      { type: "custom", customType: "session-controls", data: { mode: "plan" } },
    ])).toBe("plan");
    expect(resolveAgentModeFromEntries([
      { type: "custom", customType: "session-controls", data: { mode: "plan" } },
      { type: "custom", customType: "agent-mode", data: { mode: "ultra" } },
    ])).toBe("ultra");
  });

  it("falls back to agent when the only entries are stale/unknown", () => {
    expect(resolveAgentModeFromEntries([
      { type: "custom", customType: "agent-mode", data: { mode: "hyper" } },
    ])).toBe("agent");
  });
});

describe("buildFableBehaviorPrompt — ultra", () => {
  it("adds an ultra mode slice that defers scheduling rules to the runtime", () => {
    const p = buildFableBehaviorPrompt({ mode: "ultra" });
    expect(p).toContain("Ultra");
    expect(p).toMatch(/spawn_agent|sub-agent/i);
  });
});
