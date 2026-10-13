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

  it("non-continuable completion does not invite follow-up messages", () => {
    expect(formatSettlementNotice({ childId: "sa-w", stopReason: "completed", output: "OK", continuable: false }).content).toBe(
      "Background subagent sa-w finished. It cannot receive further messages.\nIts closing message:\nOK",
    );
  });

  it("diagnostic goes on its own line, only for non-completed results", () => {
    expect(
      formatSettlementNotice({ childId: "sa-w", stopReason: "error", output: "", diagnostic: "idle timeout" }).content,
    ).toBe("Background subagent sa-w failed before it finished.\nIt left no closing message.\nDiagnostic: idle timeout");
    expect(
      formatSettlementNotice({ childId: "sa-w", stopReason: "completed", output: "OK", diagnostic: "ignored" }).content,
    ).not.toContain("Diagnostic");
  });
});
