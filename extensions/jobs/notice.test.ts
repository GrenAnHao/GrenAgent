// extensions/jobs/notice.test.ts
import { describe, expect, it } from "vitest";
import { formatJobNotice } from "./notice.js";
import type { JobSnapshot } from "./types.js";

const snap = (over: Partial<JobSnapshot>): JobSnapshot => ({
  id: "subagent-1", kind: "subagent", label: "do x", owner: "s1", workspace: "/ws",
  status: "completed", startedAt: 0, finishedAt: 1, reported: false, outputLimitBytes: 64, stream: false,
  ring: { total: 0, earliest: 0 }, ...over,
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
  it("empty output does not hide the error", () => {
    expect(formatJobNotice(snap({ status: "killed", output: "", error: "idle timeout: no activity for 300s" })))
      .toBe("Background job subagent-1 (subagent: do x) finished killed.\nidle timeout: no activity for 300s");
  });
  it("truncates output beyond outputLimitBytes with a marker", () => {
    const text = formatJobNotice(snap({ output: "x".repeat(200) }));
    expect(text.endsWith("\n[notice truncated]")).toBe(true);
    expect(Buffer.byteLength(text.split("\n")[1] ?? "", "utf8")).toBeLessThanOrEqual(64);
  });
  it("stream job: head, DSH status line with the terminal detail, then the job_output hint; no output inline", () => {
    const text = formatJobNotice(snap({ id: "bash-1", kind: "bash", label: "npm test", stream: true, detail: "exit code: 1", output: "ignored" }));
    expect(text).toBe(
      "Background job bash-1 (bash: npm test) finished completed.\n[status: completed, exit code: 1]\nRead its output with job_output.",
    );
  });
});
