import { describe, expect, it } from "vitest";
import { formatGoalReceipt, goalStatusSentence } from "./receipt.js";
import type { GoalSnapshot } from "./types.js";

const base: GoalSnapshot = {
  goalId: "g", revision: 2, condition: "写完", status: "active",
  roundsStarted: 3, maxRounds: 256, createdAt: "t", updatedAt: "t",
};

describe("goalStatusSentence", () => {
  it("uses activation only for active", () => {
    expect(goalStatusSentence({ ...base, activation: "armed" })).toBe("执行中的目标");
    expect(goalStatusSentence({ ...base, activation: "disarmed" })).toBe("未运行的目标");
    expect(goalStatusSentence({ ...base, status: "paused" })).toBe("已暂停的目标");
    expect(goalStatusSentence({ ...base, status: "blocked", blockedReason: { code: "model-reported", message: "缺密钥" } })).toBe("受阻的目标");
    expect(goalStatusSentence({ ...base, status: "complete" })).toBe("已完成的目标");
  });
});

describe("formatGoalReceipt", () => {
  it("omits goalId and revision and includes blocked reason", () => {
    const text = formatGoalReceipt({
      ...base,
      status: "blocked",
      activation: "disarmed",
      blockedReason: { code: "model-reported", message: "缺密钥" },
    });
    expect(text).toContain("受阻的目标");
    expect(text).toContain("写完");
    expect(text).toContain("3/256");
    expect(text).toContain("disarmed");
    expect(text).toContain("缺密钥");
    expect(text).not.toContain("goalId");
    expect(text).not.toMatch(/\bg\b/);
    expect(text).not.toContain("revision");
  });
});
