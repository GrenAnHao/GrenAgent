import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  "(allow network-outbound)",
  "(allow network-inbound)",
  "(allow system-socket)",
  '(allow file-write* (literal "/dev/null"))',
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

describe("seatbeltProfile follows no symlinks", () => {
  // seatbelt 只跑在 macOS。Windows 上既没有这个语义，tmpdir() 本身又已经是 8.3 短名，
  // realpathSync.native 会把 junction 展开成长名、和 profile 里的短名对不上，前提不成立。
  it.skipIf(process.platform === "win32")("allows the real path as well as the spelling it was given", () => {
    // macOS 的 /tmp、/var 都是符号链接；内核按真实路径比对 subpath，
    // 所以 profile 里必须两种写法都有，否则 /var/folders/... 下的工作区写不进去。
    const link = join(tmpdir(), `pi-seatbelt-link-${process.pid}-${Date.now()}`);
    const real = mkdtempSync(join(tmpdir(), "pi-seatbelt-real-"));
    try {
      try {
        symlinkSync(real, link, "dir");
      } catch {
        return; // 没有建链接的权限，这条前提就不成立。
      }
      const profile = seatbeltProfile({ mode: "workspace-write", workspaceRoot: link }, tempDir);
      expect(profile).toContain(writeAllow(link.replace(/\\/g, "/")));
      expect(profile).toContain(writeAllow(realpathSync.native(real).replace(/\\/g, "/")));
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});
