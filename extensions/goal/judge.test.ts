import { describe, expect, it } from "vitest";
import { flattenTranscript, judge, parseVerdict } from "./judge.js";
import type { AskFn } from "./llm.js";

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
  it("requires missing to be a complete string array for failures", () => {
    for (const raw of [
      '{"verdict":"fail","reason":"missing"}',
      '{"verdict":"fail","reason":"missing","missing":null}',
      '{"verdict":"fail","reason":"missing","missing":["ok",3]}',
    ]) {
      expect(parseVerdict(raw).kind).toBe("error");
    }
    expect(parseVerdict('{"verdict":"fail","reason":"missing","missing":["tests"]}')).toEqual({
      kind: "fail", reason: "missing", missing: ["tests"],
    });
  });
  it("legacy judge wrapper is fail-closed", async () => {
    const malformed: AskFn = async () => "not json";
    expect(await judge(malformed, [], "c")).toEqual({ ok: false, reason: "裁判输出无法解析" });
    const unavailable: AskFn = async () => { throw new Error("offline"); };
    expect(await judge(unavailable, [], "c")).toEqual({ ok: false, reason: "裁判调用失败" });
  });
});
