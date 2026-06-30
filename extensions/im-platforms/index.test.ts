import { describe, expect, it, vi } from "vitest";

// index.ts pulls in the (heavy) sub-agent runner at import time; stub it so we can
// unit-test the pure capability-floor helper in isolation.
vi.mock("../multi-agent/runner.js", () => ({ spawnPiAgent: vi.fn() }));

import { restrictedDenyTools } from "./index.js";

describe("restrictedDenyTools (H1 capability floor)", () => {
  it("denies built-in bash (not approval-policy dependent)", () => {
    expect(restrictedDenyTools()).toContain("bash");
  });

  it("denies host write / debug-exec / github bypass tools", () => {
    const deny = restrictedDenyTools();
    for (const tool of ["ast_edit", "hl_edit", "dap_launch", "dap_evaluate", "github"]) {
      expect(deny).toContain(tool);
    }
  });

  it("denies all code execution (restricted visitors are chat + read only)", () => {
    const deny = restrictedDenyTools();
    for (const tool of ["py_run", "js_run", "py_reset", "js_reset"]) {
      expect(deny).toContain(tool);
    }
  });

  it("returns a de-duplicated list", () => {
    const deny = restrictedDenyTools();
    expect(deny.length).toBe(new Set(deny).size);
  });
});
