// extensions/jobs/notice.test.ts
import { describe, expect, it } from "vitest";
import { formatJobNotice } from "./notice.js";
import type { JobSnapshot } from "./types.js";

const snap = (over: Partial<JobSnapshot>): JobSnapshot => ({
  id: "subagent-1", kind: "subagent", label: "do x", owner: "s1", workspace: "/ws",
  status: "completed", startedAt: 0, finishedAt: 1, reported: false, outputLimitBytes: 64, stream: false, ...over,
});

describe("formatJobNotice", () => {
  it("first line names id, kind, label, status", () => {
    for (const status of ["completed", "failed", "killed"] as const) {
      expect(formatJobNotice(snap({ status })).split("\n")[0]).toBe(`Background job subagent-1 (subagent: do x) finished ${status}.`);
    }
  });
  it("final-output job appends output", () => {
    expect(formatJobNotice(snap({ output: "answer" }))).toBe("Background job subagent-1 (subagent: do x) finished completed.\nanswer");
  });
  it("failed job with error but no output appends the error", () => {
    expect(formatJobNotice(snap({ status: "failed", error: "boom" }))).toContain("\nboom");
  });
  it("truncates output beyond outputLimitBytes with a marker", () => {
    const text = formatJobNotice(snap({ output: "x".repeat(200) }));
    expect(text.endsWith("\n[notice truncated]")).toBe(true);
    expect(Buffer.byteLength(text.split("\n")[1] ?? "", "utf8")).toBeLessThanOrEqual(64);
  });
  it("stream job has only the first line", () => {
    expect(formatJobNotice(snap({ stream: true, output: "ignored" })).split("\n")).toHaveLength(1);
  });
});
