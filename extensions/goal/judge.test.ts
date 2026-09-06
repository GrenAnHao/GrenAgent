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
  it("non-strict JSON → error", () => {
    expect(parseVerdict('```json\n{"verdict":"not_ok","reason":"tests missing"}\n```').verdict).toBe("error");
  });
  it("text fallback → error", () => {
    expect(parseVerdict("Honestly this is not ok yet.").verdict).toBe("error");
  });
  it("unparseable → explicit error", () => {
    expect(parseVerdict("hmm maybe?").verdict).toBe("error");
  });
  it("never marks malformed verdict as pass", () => {
    expect(parseVerdict("hmm maybe?").verdict).toBe("error");
  });
  it("requires a supported verdict and non-empty reason", () => {
    expect(parseVerdict('{"verdict":"maybe","reason":"no"}').verdict).toBe("error");
    expect(parseVerdict('{"verdict":"ok","reason":""}').verdict).toBe("error");
    expect(parseVerdict('{"verdict":"ok"}').verdict).toBe("error");
  });
});
