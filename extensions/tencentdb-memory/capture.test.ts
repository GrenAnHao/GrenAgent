import { describe, expect, it } from "vitest";

import { captureFingerprint, selectUncaptured } from "./capture.js";

describe("selectUncaptured", () => {
  it("captures only user and assistant messages after the cursor", () => {
    const messages = [
      { role: "user", content: "旧问题" },
      { role: "assistant", content: "旧回答" },
      { role: "user", content: [{ type: "text", text: "本轮问题" }] },
      { role: "toolResult", content: "工具输出" },
      { role: "assistant", content: "本轮回答" },
    ];

    expect(selectUncaptured(messages, 2).map((message) => message.content)).toEqual(["本轮问题", "本轮回答"]);
  });

  it("produces a stable fingerprint for the same captured batch", () => {
    const batch = selectUncaptured(
      [
        { role: "user", content: "问题" },
        { role: "assistant", content: "回答" },
      ],
      0,
    );

    expect(captureFingerprint(batch)).toBe(captureFingerprint(batch));
    expect(captureFingerprint(batch)).not.toBe(captureFingerprint([{ role: "user", content: "另一个问题" }]));
  });
});
