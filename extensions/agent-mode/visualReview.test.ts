import { describe, expect, it, vi } from "vitest";
vi.mock("../_shared/runtime-config.js", () => ({ getConfig: () => undefined, watchConfig: () => () => {} }));
import factory from "./index.ts";
import visualCompanion from "../visual-companion/index.ts";
import { getVisualReview, publishVisualReview } from "../visual-companion/reviewRegistry.ts";

function askTool() {
  const tools = new Map<string, any>();
  const sendMessage = vi.fn();
  factory({ on: () => () => {}, registerCommand: () => {}, registerTool: (tool: { name: string }) => tools.set(tool.name, tool), sendMessage } as never);
  return { ask: tools.get("ask_user")!, sendMessage };
}

describe("ask_user visual review", () => {
  it("runs a deterministic redo → second preview → approval loop and consecutive redo rounds", async () => {
    const { ask } = askTool();
    const tools = new Map<string, any>();
    const sendMessage = vi.fn();
    visualCompanion({ on: () => () => {}, registerTool: (tool: { name: string }) => tools.set(tool.name, tool), sendMessage } as never);
    const shown = tools.get("show_visual")!;
    const status = vi.fn();
    const owner = "loop-session";
    const outcomes = ["redo", "redo", "approved"] as const;
    const previews: string[] = [];
    const results: Array<{ details: { review: { outcome: string; previewId: string } }; content: Array<{ text: string }> }> = [];
    for (const [round, outcome] of outcomes.entries()) {
      const ctx = { hasUI: true, cwd: "/workspace", sessionManager: { getSessionFile: () => owner }, ui: { setStatus: status, input: vi.fn(async (payload: string) => {
        const request = JSON.parse(payload).data;
        expect(request.visualReview.previewId).toBe(previews[round]);
        expect(request.questions[0].options.map(({ id }: { id: string }) => id)).toEqual(["approve", "redo"]);
        expect(request.questions[0].allowCustom).toBe(false);
        expect(request.questions[1].allowCustom).toBe(true);
        expect(request.allowExtra).toBe(true);
        expect(request.allowExtraImages).toBe(true);
        return JSON.stringify({ __askUserAnswer: 1, text: `[我的选择] 第${round + 1}轮：${outcome}`, review: { previewId: previews[round], outcome } });
      }) } };
      const published = await shown.execute(`show-${round}`, { html: `<p>第${round + 1}版</p>`, mode: "inline" }, undefined, undefined, ctx);
      const previewId = published.details.previewId;
      expect(previews).not.toContain(previewId);
      previews.push(previewId);
      expect(JSON.parse(status.mock.lastCall![1]).previewId).toBe(previewId);
      const answer = await ask.execute(`review-${round}`, { visualReview: { previewId }, questions: [{ question: "选择哪个方案？", options: [{ label: "方案 A" }, { label: "方案 B" }] }] }, undefined, undefined, ctx);
      results.push(answer);
      expect(answer.details.review).toEqual({ previewId, requestId: `review-${round}`, outcome });
      expect(getVisualReview(previewId)?.outcome).toBe(outcome);
      if (outcome === "redo") expect(answer.content[0].text).toContain("重新调用 show_visual");
      else expect(answer.content[0].text).toContain("仅当前 previewId 获得批准");
    }
    expect(results.map((result) => result.details.review.outcome)).toEqual(["redo", "redo", "approved"]);
    expect(previews.slice(0, 2).every((id) => getVisualReview(id)?.outcome !== "approved")).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });
  it("keeps choice, supplement and image but settles from stable ID rather than label", async () => {
    const record = publishVisualReview("live-review");
    const { ask } = askTool();
    const input = vi.fn(async (payload: string) => {
      const data = JSON.parse(payload).data;
      expect(data.questions[0].options.map((option: { id: string }) => option.id)).toEqual(["approve", "redo"]);
      expect(data.questions[0].allowCustom).toBe(false);
      expect(data.questions[1].allowCustom).toBe(true);
      return JSON.stringify({ __askUserAnswer: 1, text: "[我的选择]\n1. 评审：无关标签\n补充说明：调整排版", images: [{ mimeType: "image/png", data: "abc" }], review: { previewId: record.previewId, outcome: "redo" } });
    });
    const result = await ask.execute("call-review", { visualReview: { previewId: record.previewId }, questions: [{ question: "哪个配色？", options: [{ label: "蓝色" }] }], allowExtra: true }, undefined, undefined, {
      hasUI: true, sessionManager: { getSessionFile: () => "live-review" }, ui: { input },
    });
    expect(result.details.review).toEqual({ previewId: record.previewId, requestId: "call-review", outcome: "redo" });
    expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: "abc" });
    expect(result.content[0].text).toContain("补充说明：调整排版");
    expect(getVisualReview(record.previewId)?.outcome).toBe("redo");
  });

  it("dismisses an outstanding card when a newer output replaces it", async () => {
    const { ask } = askTool();
    const old = publishVisualReview("replace-owner");
    const input = vi.fn((_payload: string, _placeholder: unknown, options: { signal: AbortSignal }) => new Promise<undefined>((resolve) => {
      options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    }));
    const waiting = ask.execute("old-ask", { visualReview: { previewId: old.previewId }, questions: [] }, undefined, undefined, {
      hasUI: true, sessionManager: { getSessionFile: () => "replace-owner" }, ui: { input },
    });
    await vi.waitFor(() => expect(input).toHaveBeenCalled());
    const next = publishVisualReview("replace-owner");
    expect((await waiting).details.review.outcome).toBe("superseded");
    expect(getVisualReview(next.previewId)?.outcome).toBe("pending");
  });

  it("never approves cancellation or a missing interactive UI", async () => {
    const { ask } = askTool();
    const cancelled = publishVisualReview("cancel-review");
    const cancel = await ask.execute("cancel-ask", { visualReview: { previewId: cancelled.previewId }, questions: [] }, undefined, undefined, {
      hasUI: true, sessionManager: { getSessionFile: () => "cancel-review" }, ui: { input: async () => undefined },
    });
    expect(cancel.details.review.outcome).toBe("cancelled");
    const headless = publishVisualReview("headless-review");
    const noUi = await ask.execute("no-ui-ask", { visualReview: { previewId: headless.previewId }, questions: [] }, undefined, undefined, {
      hasUI: false, sessionManager: { getSessionFile: () => "headless-review" },
    });
    expect(noUi.details.review.outcome).toBe("cancelled");
    expect(getVisualReview(headless.previewId)?.outcome).not.toBe("approved");
  });
});
