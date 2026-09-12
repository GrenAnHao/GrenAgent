import { describe, expect, it } from "vitest";
import { isStrictWidening, justifyOk } from "./escalate.js";

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

describe("justifyOk", () => {
  it("accepts trimmed length of at least 20", () => {
    expect(justifyOk("12345678901234567890")).toBe(true);
    expect(justifyOk("  12345678901234567890  ")).toBe(true);
  });
  it("rejects trimmed length of 19", () => {
    expect(justifyOk("1234567890123456789")).toBe(false);
    expect(justifyOk("  1234567890123456789  ")).toBe(false);
  });
});
