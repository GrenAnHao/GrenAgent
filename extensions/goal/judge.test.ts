import { describe, expect, it } from "vitest";
import { flattenTranscript, parseVerdict } from "./judge.js";

describe("flattenTranscript", () => {
  it("joins string and block content as role: text", () => {
    expect(
      flattenTranscript([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "yo" }, { type: "thinking", text: "x" }] },
      ]),
    ).toBe("user: hi\nassistant: yo");
  });
});

describe("parseVerdict", () => {
  it("ok verdict → pass", () => {
    expect(parseVerdict('{"verdict":"ok","reason":"done"}')).toEqual({ kind: "pass", reason: "done" });
  });
  it("non-strict JSON → error", () => {
    expect(parseVerdict('```json\n{"verdict":"not_ok","reason":"tests missing"}\n```').kind).toBe("error");
  });
  it("text fallback → error", () => {
    expect(parseVerdict("Honestly this is not ok yet.").kind).toBe("error");
  });
  it("unparseable → explicit error", () => {
    expect(parseVerdict("hmm maybe?").kind).toBe("error");
  });
  it("never marks malformed verdict as pass", () => {
    expect(parseVerdict("hmm maybe?").kind).toBe("error");
  });
  it("requires a supported verdict and non-empty reason", () => {
    for (const raw of ['{"verdict":"maybe","reason":"no"}', '{"verdict":"ok","reason":""}', '{"verdict":"ok"}', 'null', '[]', '{"reason":"x"}']) {
      expect(parseVerdict(raw).kind).toBe("error");
    }
  });
});
