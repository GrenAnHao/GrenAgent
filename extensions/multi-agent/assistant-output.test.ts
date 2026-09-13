import { describe, expect, it } from "vitest";
import { extractAssistantOutput } from "./assistant-output.js";

describe("extractAssistantOutput", () => {
  it("returns last non-empty assistant message", () => {
    const r = extractAssistantOutput([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop" },
      { role: "assistant", content: [], stopReason: "stop" },
      { role: "assistant", content: [{ type: "text", text: "final answer" }], stopReason: "stop" },
    ]);
    expect(r.output).toBe("final answer");
    expect(r.stopReason).toBe("completed");
  });

  it("falls back to streaming delta when assistant content empty", () => {
    const r = extractAssistantOutput([], { streamingDelta: "partial stream" });
    expect(r.output).toBe("partial stream");
    expect(r.stopReason).toBe("completed");
  });

  it("returns empty output with error when nothing available", () => {
    const r = extractAssistantOutput([{ role: "assistant", content: [] }]);
    expect(r.output).toBe("");
    expect(r.stopReason).toBe("error");
  });

  it("maps aborted signal", () => {
    const r = extractAssistantOutput([], { aborted: true });
    expect(r.stopReason).toBe("aborted");
  });

  it("skips empty usage-only assistant messages", () => {
    const r = extractAssistantOutput([
      { role: "assistant", content: [{ type: "text", text: "keep me" }], stopReason: "stop" },
      { role: "assistant", content: [], usage: { input: 3, output: 0 }, stopReason: "stop" },
    ] as Array<{ role: string; content: unknown; stopReason?: string; usage?: unknown }>);
    expect(r.output).toBe("keep me");
  });

  it("never treats a session header object as output", () => {
    const r = extractAssistantOutput([
      { type: "session", id: "x", cwd: "/ws", version: 3 } as unknown as { role?: string; content?: unknown },
    ]);
    expect(r.output).toBe("");
    expect(r.stopReason).toBe("error");
  });
});
