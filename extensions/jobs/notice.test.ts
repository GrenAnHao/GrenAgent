// extensions/jobs/notice.test.ts
import { describe, expect, it } from "vitest";
import { formatJobNotice } from "./notice.js";
import type { JobSnapshot } from "./types.js";

const snap = (over: Partial<JobSnapshot>): JobSnapshot => ({
  id: "bash-1", kind: "bash", label: "npm test", owner: "s1", workspace: "/ws",
  status: "completed", startedAt: 0, finishedAt: 1, reported: false, outputLimitBytes: 64,
  ring: { total: 0, earliest: 0 }, ...over,
});

describe("formatJobNotice", () => {
  it("first line names id, kind, label, status", () => {
    for (const status of ["completed", "failed", "killed"] as const) {
      expect(formatJobNotice(snap({ status })).split("\n")[0]).toBe(`Background job bash-1 (bash: npm test) finished ${status}.`);
    }
  });
  it("head, DSH status line with the terminal detail, then the job_output hint; no output inline", () => {
    const text = formatJobNotice(snap({ detail: "exit code: 1" }));
    expect(text).toBe(
      "Background job bash-1 (bash: npm test) finished completed.\n[status: completed, exit code: 1]\nRead its output with job_output.",
    );
  });
});
