import { describe, expect, it } from "vitest";
import { interpolateHeaderPlaceholders } from "./header-placeholders.js";

describe("interpolateHeaderPlaceholders", () => {
  it("把请求头值里的 {sessionId} 换成当前会话 ID", () => {
    const headers = { "x-opencode-session": "{sessionId}", "User-Agent": "pi-agent/1.0" };
    interpolateHeaderPlaceholders(headers, { sessionId: "01abc" });
    expect(headers).toEqual({
      "x-opencode-session": "01abc",
      "User-Agent": "pi-agent/1.0",
    });
  });

  it("同一值里出现多次也全部替换", () => {
    const headers = { "X-Trace": "conv-{sessionId}/{sessionId}" };
    interpolateHeaderPlaceholders(headers, { sessionId: "s1" });
    expect(headers["X-Trace"]).toBe("conv-s1/s1");
  });

  it("没有会话 ID 时保持占位符，避免发出空头", () => {
    const headers = { "x-opencode-session": "{sessionId}" };
    interpolateHeaderPlaceholders(headers, { sessionId: "  " });
    expect(headers["x-opencode-session"]).toBe("{sessionId}");
  });

  it("跳过非字符串（null 表示删头）", () => {
    const headers: Record<string, string | null> = { keep: "a", drop: null };
    interpolateHeaderPlaceholders(headers, { sessionId: "s1" });
    expect(headers).toEqual({ keep: "a", drop: null });
  });
});
