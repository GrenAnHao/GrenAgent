import { describe, expect, it } from "vitest";
import { assertWritableRootsDisjoint, capabilitySid } from "./sids.js";

describe("capabilitySid", () => {
  it("yields the same S-1-4 SID after cwd-style case and trailing-separator folding", () => {
    const mixed = "C:\\Work\\Repo";
    const folded = "c:/work/repo/";
    const again = "C:/Work/Repo\\";
    const a = capabilitySid("workspace", mixed);
    const b = capabilitySid("workspace", folded);
    const c = capabilitySid("workspace", again);
    expect(a).toMatch(/^S-1-4-\d+-\d+-\d+-\d+$/);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("domain-separates workspace and temp SIDs with distinct kind salts", () => {
    const root = "C:/work/repo";
    const workspace = capabilitySid("workspace", root);
    const temp = capabilitySid("temp", root);
    expect(workspace).toMatch(/^S-1-4-/);
    expect(temp).toMatch(/^S-1-4-/);
    expect(workspace).not.toBe(temp);
  });
});

describe("assertWritableRootsDisjoint", () => {
  it("throws when roots are equal or nested after normalization", () => {
    expect(() => assertWritableRootsDisjoint("C:\\work\\repo", "c:/work/repo/")).toThrow();
    expect(() => assertWritableRootsDisjoint("C:/work/repo", "C:/work/repo/tmp")).toThrow();
    expect(() => assertWritableRootsDisjoint("C:/work/repo/tmp", "C:/work/repo")).toThrow();
  });

  it("allows sibling roots that do not contain each other", () => {
    expect(() => assertWritableRootsDisjoint("C:/work/repo", "C:/tmp/pi-sandbox")).not.toThrow();
    expect(() => assertWritableRootsDisjoint("C:/work", "C:/workout")).not.toThrow();
  });
});
