import { describe, expect, it } from "vitest";
import {
  appendTranscriptTail,
  LIVE_TRANSCRIPT_TAIL,
  slimTranscriptJsonLine,
  transcriptLineFromEvent,
} from "./transcript-tail.js";

describe("transcript tail", () => {
  it("keeps a long partial stream inside the live tail and drops snapshots", () => {
    let transcript = "";
    let snapshotBytes = 0;
    for (let i = 1; i <= 200; i++) {
      const partial = "x".repeat(i * 500);
      snapshotBytes += partial.length;
      transcript = appendTranscriptTail(
        transcript,
        transcriptLineFromEvent({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: partial }], usage: { total: i } },
          assistantMessageEvent: {
            type: "text_delta",
            delta: "y",
            partial: { content: [{ type: "text", text: partial }] },
          },
        }),
      );
      expect(transcript.length).toBeLessThanOrEqual(LIVE_TRANSCRIPT_TAIL);
    }
    expect(snapshotBytes).toBeGreaterThan(LIVE_TRANSCRIPT_TAIL * 10);
    expect(transcript).not.toContain('"partial"');
    expect(transcript).not.toContain('"content"');
    const lines = transcript.split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]!) as {
      message?: unknown;
      usage?: { total?: number };
      assistantMessageEvent?: { delta?: string };
    };
    expect(last.message).toBeUndefined();
    expect(last.usage?.total).toBe(200);
    expect(last.assistantMessageEvent?.delta).toBe("y");
  });

  it("keeps message_end and tool boundaries, and copies toolcall id without partial", () => {
    const end = transcriptLineFromEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });
    expect(end).toContain("message_end");
    expect(end).toContain("done");

    const start = slimTranscriptJsonLine(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        partial: { content: [{ type: "toolCall", id: "call_1", name: "read" }] },
      },
    }));
    const parsed = JSON.parse(start) as { assistantMessageEvent: Record<string, unknown> };
    expect(parsed.assistantMessageEvent.id).toBe("call_1");
    expect(parsed.assistantMessageEvent.toolName).toBe("read");
    expect(parsed.assistantMessageEvent.partial).toBeUndefined();

    const tool = slimTranscriptJsonLine(JSON.stringify({ type: "tool_execution_start", toolName: "read" }));
    expect(JSON.parse(tool)).toEqual({ type: "tool_execution_start", toolName: "read" });
  });
});
