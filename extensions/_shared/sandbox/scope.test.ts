import { describe, expect, it } from "vitest";
import { resolvePreset } from "./resolvePreset.js";

describe("sandbox public surface", () => {
  it("index.ts 不导出 runner 内部符号", async () => {
    const mod = await import("./index.js");
    for (const internal of [
      "bwrapArgv",
      "seatbeltProfile",
      "seatbeltArgv",
      "windowsHelperArgv",
      "windowsConfined",
      "capabilitySid",
      "windowsAclStamps",
    ]) {
      expect(Object.keys(mod)).not.toContain(internal);
    }
  });

  it("策略类型里没有网络强制字段（规格 5 才做）", () => {
    const policy = resolvePreset({ approval: "auto", agentMode: "agent", workspaceRoot: "/w", sessionId: "s" });
    expect(Object.keys(policy).sort()).toEqual(["mode", "network", "sessionId", "workspaceRoot"]);
    expect(policy.network).toBe("enabled");
  });
});
