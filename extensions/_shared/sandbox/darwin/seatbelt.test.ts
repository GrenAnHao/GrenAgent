import { describe, expect, it } from "vitest";
import { seatbeltArgv, seatbeltProfile } from "./seatbelt.js";

const caller = ["bash", "-c", "true"];
const tempDir = "/tmp/pi-sandbox-s1";
const workspaceRoot = "/home/user/project";

const REQUIRED = [
  "(version 1)",
  "(deny default)",
  "(allow file-read*)",
  "(allow process-exec)",
  "(allow process-fork)",
  "(allow sysctl-read)",
  "(allow signal (target same-sandbox))",
  '(allow mach-lookup (global-name "com.apple.system.logger"))',
];

function writeAllow(root: string): string {
  return `(allow file-write* (subpath "${root}"))`;
}

describe("seatbeltProfile", () => {
  it("includes deny default, required literals, and the temp write path", () => {
    const profile = seatbeltProfile({ mode: "read-only", workspaceRoot }, tempDir);
    for (const literal of REQUIRED) {
      expect(profile).toContain(literal);
    }
    expect(profile).toContain(writeAllow(tempDir));
    expect(writeAllow(tempDir)).toMatch(/subpath "\//);
  });

  it("read-only does not allow workspace file-write", () => {
    const profile = seatbeltProfile({ mode: "read-only", workspaceRoot }, tempDir);
    expect(profile).not.toContain(`(allow file-write* (subpath "${workspaceRoot}")`);
    expect(profile).not.toContain(writeAllow(workspaceRoot));
  });

  it("workspace-write allows workspace and temp file-write subpaths", () => {
    const profile = seatbeltProfile({ mode: "workspace-write", workspaceRoot }, tempDir);
    expect(profile).toContain(writeAllow(workspaceRoot));
    expect(profile).toContain(writeAllow(tempDir));
  });
});

describe("seatbeltArgv", () => {
  it("wraps caller argv as sandbox-exec -p profile ...callerArgv", () => {
    const policy = { mode: "read-only" as const, workspaceRoot };
    const profile = seatbeltProfile(policy, tempDir);
    expect(seatbeltArgv(policy, caller, tempDir)).toEqual([
      "sandbox-exec",
      "-p",
      profile,
      ...caller,
    ]);
  });
});
