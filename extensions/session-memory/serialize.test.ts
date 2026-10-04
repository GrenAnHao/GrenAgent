import { describe, expect, it } from "vitest";
import { serializeForSummary } from "./serialize.js";

describe("serializeForSummary", () => {
  it("按 Pi 的格式序列化，工具结果截到 2000 字符，自定义消息按用户消息处理", () => {
    const text = serializeForSummary([
      { role: "user", content: "fix the bug", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(3000) }],
        isError: false,
        timestamp: 3,
      },
      { role: "custom", customType: "note", content: "hidden context", display: false, timestamp: 4 },
    ]);
    expect(text).toContain("[User]: fix the bug");
    expect(text).toContain("[Assistant]: reading");
    expect(text).toContain('[Assistant tool calls]: read(path="a.ts")');
    expect(text).toContain("[Tool result]: ");
    expect(text).toContain("[... 1000 more characters truncated]");
    expect(text).toContain("[User]: hidden context");
  });
});
