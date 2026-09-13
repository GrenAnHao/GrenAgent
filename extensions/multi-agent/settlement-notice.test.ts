import { describe, expect, it } from "vitest";
import { formatSettlementNotice } from "./settlement-notice.js";

describe("formatSettlementNotice", () => {
  it("completed with closing message", () => {
    const n = formatSettlementNotice({
      childId: "sa-abc",
      stopReason: "completed",
      output: "done here",
    });
    expect(n.summary).toBe(
      "Background subagent sa-abc finished and will do no further work unless you send it more.",
    );
    expect(n.content).toBe(
      "Background subagent sa-abc finished and will do no further work unless you send it more.\nIts closing message:\ndone here",
    );
  });

  it("aborted", () => {
    expect(formatSettlementNotice({ childId: "sa-x", stopReason: "aborted", output: "" }).summary).toBe(
      "Background subagent sa-x was stopped before it finished.",
    );
  });

  it("error with no output", () => {
    const n = formatSettlementNotice({ childId: "sa-x", stopReason: "error", output: "" });
    expect(n.content).toContain("It left no closing message.");
    expect(n.summary).toBe("Background subagent sa-x failed before it finished.");
  });
});
