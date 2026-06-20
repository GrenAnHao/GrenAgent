import { describe, expect, it } from "vitest";
import { buildFableBehaviorPrompt, estimatePromptTokens, readTier3Module, resolveAgentModeFromEntries } from "./loader.js";

describe("buildFableBehaviorPrompt", () => {
  it("includes tier1 harness rules", () => {
    const p = buildFableBehaviorPrompt({ tier2: false, tier3Guidelines: false, date: "2026-06-20" });
    expect(p).toContain("[Fable Behavior]");
    expect(p).toContain("read` at least once before editing");
    expect(p).toContain("Current date: 2026-06-20");
  });

  it("includes tier2 when enabled", () => {
    const p = buildFableBehaviorPrompt({ tier2: true, tier3Guidelines: false });
    expect(p).toContain("Tool discipline");
    expect(p).toContain("Ask User");
    expect(p).toContain("Grep and glob strategy");
    expect(p).toContain("MCP collaboration");
    expect(p).toContain("Verify baseline");
    expect(p).toContain("Terminal and sidecar harness");
    expect(p).toContain("Conventions first");
  });

  it("adds debug mode slice with evidence loop", () => {
    const p = buildFableBehaviorPrompt({ tier2: false, tier3Guidelines: false, mode: "debug" });
    expect(p).toContain("Hypothesize");
    expect(p).toContain("debug_log");
  });

  it("readTier3Module returns citing-code body", () => {
    const text = readTier3Module("citing-code");
    expect(text).toContain("startLine:endLine:filepath");
    expect(readTier3Module("nope")).toBeUndefined();
  });

  it("adds ask mode slice", () => {
    const p = buildFableBehaviorPrompt({ tier2: false, tier3Guidelines: false, mode: "ask" });
    expect(p.toLowerCase()).toContain("read-only");
  });

  it("adds plan mode slice with three phases", () => {
    const p = buildFableBehaviorPrompt({ tier2: false, tier3Guidelines: false, mode: "plan" });
    expect(p).toContain("Ground in the environment");
    expect(p).toContain("decision-complete");
  });

  it("adds agent mode slice for ask_user", () => {
    const p = buildFableBehaviorPrompt({ tier2: false, tier3Guidelines: false, mode: "agent" });
    expect(p).toContain("ask_user");
  });

  it("adds tier3 summary when enabled", () => {
    const p = buildFableBehaviorPrompt({ tier2: false, tier3Guidelines: true });
    expect(p).toContain("Quick reference");
    expect(p).toContain("Copyright");
  });

  it("tier2P1=false omits extended tier2 modules", () => {
    const p = buildFableBehaviorPrompt({ tier2: true, tier2P1: false, tier3Guidelines: false });
    expect(p).toContain("Tool discipline");
    expect(p).not.toContain("Delegation");
    expect(p).not.toContain("Terminal and sidecar harness");
  });

  it("token budget stays under 4k for default agent mode", () => {
    expect(estimatePromptTokens({ tier2: true, tier2P1: true, tier3Guidelines: true, mode: "agent" })).toBeLessThan(4000);
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
