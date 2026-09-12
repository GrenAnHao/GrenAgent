import { describe, expect, it } from "vitest";
import { buildGoalRoundPrompt } from "./prompt.js";
import { GOAL_BLOCKED_MIN_ROUNDS } from "./types.js";

describe("buildGoalRoundPrompt", () => {
  it("includes the current condition and workspace completion-audit rules", () => {
    const condition = "把登录页做到能跑通测试";
    const text = buildGoalRoundPrompt({ condition, round: 4, maxRounds: 16 });

    expect(text).toContain(condition);
    expect(text).toMatch(/工作区/);
    expect(text).toMatch(/核/);
    expect(text).toMatch(/记忆/);
    expect(text).toContain("complete");
    expect(text).toContain("blocked");
    expect(text.includes("3") || text.includes(String(GOAL_BLOCKED_MIN_ROUNDS))).toBe(true);
  });
});
