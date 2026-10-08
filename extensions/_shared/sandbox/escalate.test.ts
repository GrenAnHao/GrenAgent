import { describe, expect, it } from "vitest";
import { isStrictWidening } from "./escalate.js";

describe("isStrictWidening", () => {
  it("allows the two legal widenings", () => {
    expect(isStrictWidening("read-only", "workspace-write")).toBe(true);
    expect(isStrictWidening("read-only", "danger-full-access")).toBe(true);
    expect(isStrictWidening("workspace-write", "danger-full-access")).toBe(true);
  });
  it("rejects narrow, equal, or unknown jumps", () => {
    expect(isStrictWidening("workspace-write", "read-only")).toBe(false);
    expect(isStrictWidening("read-only", "read-only")).toBe(false);
    expect(isStrictWidening("danger-full-access", "workspace-write")).toBe(false);
  });
});
