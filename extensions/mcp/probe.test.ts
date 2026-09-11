import { describe, expect, it } from "vitest";
import { killProbeChild, probeServer } from "./probe";

describe("probeServer", () => {
  it("returns ok:false for an unspawnable stdio command", async () => {
    const r = await probeServer(
      { name: "x", transport: "stdio", command: "this_binary_does_not_exist_zzz", args: [] },
      4000,
    );
    expect(r.ok).toBe(false);
    expect(r.toolNames).toEqual([]);
    expect(typeof r.error).toBe("string");
  }, 15000);

  it("killProbeChild 对已退出 pid 不抛", () => {
    expect(() => killProbeChild(2_147_000_000)).not.toThrow();
  });
});
