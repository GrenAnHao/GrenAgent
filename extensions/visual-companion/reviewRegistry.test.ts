import { describe, expect, it, vi } from "vitest";
import { bindVisualReview, getVisualReview, onVisualReviewSuperseded, publishVisualReview, restoreVisualReviews, settleVisualReview } from "./reviewRegistry.ts";

describe("visual publication identity", () => {
  it("supersedes only the same owner's earlier preview", () => {
    const a = publishVisualReview("session-a");
    const b = publishVisualReview("session-b");
    const next = publishVisualReview("session-a");
    expect(a.previewId).not.toBe(next.previewId);
    expect(getVisualReview(a.previewId)?.outcome).toBe("superseded");
    expect(getVisualReview(b.previewId)?.outcome).toBe("pending");
    expect(getVisualReview(next.previewId)?.outcome).toBe("pending");
  });

  it("requires the original owner, preview and request for a single settlement", () => {
    const record = publishVisualReview("owner-c");
    bindVisualReview("owner-c", record.previewId, "ask-1");
    expect(() => settleVisualReview("owner-other", record.previewId, "ask-1", "approved")).toThrow("STALE");
    expect(() => settleVisualReview("owner-c", record.previewId, "ask-2", "approved")).toThrow("STALE");
    expect(settleVisualReview("owner-c", record.previewId, "ask-1", "redo").outcome).toBe("redo");
    expect(settleVisualReview("owner-c", record.previewId, "ask-1", "approved").outcome).toBe("redo");
  });

  it("does not replay old results over a live waiting preview", () => {
    const current = publishVisualReview("owner-replay");
    bindVisualReview("owner-replay", current.previewId, "ask-live");
    const dismiss = vi.fn();
    const unsubscribe = onVisualReviewSuperseded(current.previewId, dismiss);
    restoreVisualReviews("owner-replay", [
      { toolName: "show_visual", details: { previewId: "replay-old" } },
      { toolName: "ask_user", details: { review: { previewId: "replay-old", requestId: "old-ask", outcome: "redo" } } },
      { toolName: "show_visual", details: { previewId: current.previewId } },
    ]);
    expect(dismiss).not.toHaveBeenCalled();
    expect(getVisualReview(current.previewId)).toMatchObject({ outcome: "pending", requestId: "ask-live" });
    expect(getVisualReview("replay-old")).toBeUndefined();
    unsubscribe();
  });

  it("restores the version chain from persisted result details", () => {
    restoreVisualReviews("owner-d", [
      { toolName: "show_visual", details: { previewId: "d-1" } },
      { toolName: "ask_user", details: { review: { previewId: "d-1", requestId: "ask-1", outcome: "redo" } } },
      { toolName: "show_visual", details: { previewId: "d-2" } },
    ]);
    expect(getVisualReview("d-1")?.outcome).toBe("redo");
    expect(getVisualReview("d-2")?.outcome).toBe("pending");
  });
});
