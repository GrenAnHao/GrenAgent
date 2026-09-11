import { describe, expect, it } from "vitest";
import { SANDBOX_DENIAL_EXIT } from "../types.js";
import { capabilitySid } from "./sids.js";
import { windowsConfined, windowsHelperArgv } from "./runner.js";

const helperPath = "C:/tools/pi-sandbox-win.exe";
const workspaceRoot = "C:/work/repo";
const tempDir = "C:/tmp/pi-sandbox-s1";
const caller = ["bash.exe", "-c", "true"];

function hasSeq(argv: string[], seq: string[]): boolean {
  return argv.some((_, i) => seq.every((token, j) => argv[i + j] === token));
}

describe("windowsHelperArgv", () => {
  it("workspace-write starts with the helper, capability SIDs, then caller argv", () => {
    const policy = { mode: "workspace-write" as const, workspaceRoot };
    const argv = windowsHelperArgv(policy, caller, helperPath, tempDir);
    expect(argv[0]).toBe(helperPath);
    expect(hasSeq(argv, ["--workspace-sid", capabilitySid("workspace", workspaceRoot)])).toBe(true);
    expect(hasSeq(argv, ["--temp-sid", capabilitySid("temp", tempDir)])).toBe(true);
    const sep = argv.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(argv.slice(sep + 1)).toEqual(caller);

    const confined = windowsConfined(
      { ...policy, network: "enabled" },
      caller,
      helperPath,
      tempDir,
    );
    expect(confined.argv).toEqual(argv);
    expect(confined.enforcement).toBe("partial");
    expect(confined.denialExitCodes).toContain(SANDBOX_DENIAL_EXIT);
    expect(confined.denialSignatures).toEqual(
      expect.arrayContaining(["access is denied", "拒绝访问"]),
    );
    expect(confined.runnerFailureRules).toEqual([
      {
        kind: "runner-launch-failed",
        exitCodes: [163],
        signatures: ["pi-sandbox-win:"],
      },
    ]);
  });

  it("read-only omits capability SIDs and still appends caller argv after --", () => {
    const policy = { mode: "read-only" as const, workspaceRoot };
    const argv = windowsHelperArgv(policy, caller, helperPath, tempDir);
    expect(argv[0]).toBe(helperPath);
    expect(argv).not.toContain("--workspace-sid");
    expect(argv).not.toContain("--temp-sid");
    const sep = argv.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(argv.slice(sep + 1)).toEqual(caller);

    const confined = windowsConfined(
      { ...policy, network: "enabled" },
      caller,
      helperPath,
      tempDir,
    );
    expect(confined.enforcement).toBe("partial");
    expect(confined.denialExitCodes).toContain(SANDBOX_DENIAL_EXIT);
  });
});
