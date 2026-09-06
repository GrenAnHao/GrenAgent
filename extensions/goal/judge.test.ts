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
    expect(parseVerdict('{"verdict":"ok","reason":"done"}')).toEqual({ verdict: "pass", reason: "done" });
  });
  it("fenced not_ok verdict → fail", () => {
    expect(parseVerdict('```json\n{"verdict":"not_ok","reason":"tests missing"}\n```')).toEqual({ verdict: "fail", reason: "tests missing" });
  });
  it("text 'not ok' fallback → fail", () => {
    expect(parseVerdict("Honestly this is not ok yet.").verdict).toBe("fail");
  });
  it("unparseable → explicit error", () => {
    expect(parseVerdict("hmm maybe?").verdict).toBe("error");
  });
  it("never marks malformed verdict as pass", () => {
    expect(parseVerdict("hmm maybe?").verdict).toBe("error");
  });
});
