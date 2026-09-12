import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSandboxProvider } from "./provider.js";
import type { ConfinedArgv } from "./types.js";
import { SANDBOX_DENIAL_EXIT } from "./types.js";

const caller = ["bash", "-c", "true"];
const policy = { mode: "read-only" as const, network: "enabled" as const, workspaceRoot: "/w" };

describe("createSandboxProvider", () => {
  it("throws SANDBOX_UNAVAILABLE when the platform probe fails", async () => {
    const provider = createSandboxProvider({
      platform: "linux",
      probe: async () => ({ ok: false, reason: "no-bwrap" }),
    });
    await expect(provider.confine(caller, policy)).rejects.toMatchObject({
      code: "SANDBOX_UNAVAILABLE",
      message: expect.stringContaining("no-bwrap"),
    });
  });

  it("never returns the caller's argv unwrapped", async () => {
    const provider = createSandboxProvider({
      platform: "linux",
      probe: async () => ({ ok: true }),
      build: (argv) => ({
        argv: ["bwrap", "--ro-bind", "/", "/", "--", ...argv],
        enforcement: "full",
        denialExitCodes: [],
        denialSignatures: ["erofs"],
        runnerFailureRules: [],
      }),
    });
    const out = await provider.confine(caller, policy);
    expect(out.argv[0]).toBe("bwrap");
    expect(out.argv.slice(-3)).toEqual(caller);
    expect(out.argv).not.toEqual(caller);
  });

  it("rejects a build that returns the caller's argv unwrapped", async () => {
    const provider = createSandboxProvider({
      platform: "linux",
      probe: async () => ({ ok: true }),
      build: (argv): ConfinedArgv => ({
        argv,
        enforcement: "full",
        denialExitCodes: [],
        denialSignatures: [],
        runnerFailureRules: [],
      }),
    });
    await expect(provider.confine(caller, policy)).rejects.toMatchObject({
      code: "SANDBOX_UNAVAILABLE",
    });
  });

  it("uses full linux confinement metadata when probe succeeds", async () => {
    const provider = createSandboxProvider({
      platform: "linux",
      probe: async () => ({ ok: true }),
      tempDir: "/tmp/pi-sandbox-s1",
    });
    const out = await provider.confine(caller, policy);
    expect(out.argv).not.toEqual(caller);
    expect(out.argv[0]).toBe("bwrap");
    expect(out.enforcement).toBe("full");
    expect(out.denialExitCodes).toEqual([SANDBOX_DENIAL_EXIT]);
    expect(out.denialSignatures).toEqual(expect.arrayContaining(["erofs", "read-only file system"]));
    expect(out.runnerFailureRules).toEqual([
      {
        kind: "runner-launch-failed",
        exitCodes: [127],
        signatures: ["bwrap: executable not found"],
      },
    ]);
  });

  it.skipIf(existsSync("/usr/bin/sandbox-exec"))(
    "throws SANDBOX_UNAVAILABLE when darwin sandbox-exec is missing",
    async () => {
      const provider = createSandboxProvider({ platform: "darwin" });
      await expect(provider.confine(caller, policy)).rejects.toMatchObject({
        code: "SANDBOX_UNAVAILABLE",
      });
    },
  );

  it("uses full darwin confinement when probe succeeds and build is not injected", async () => {
    const provider = createSandboxProvider({
      platform: "darwin",
      probe: async () => ({ ok: true }),
      tempDir: "/tmp/pi-sandbox-s1",
    });
    const out = await provider.confine(caller, policy);
    expect(out.argv[0]).toBe("sandbox-exec");
    expect(out.enforcement).toBe("full");
  });

  it("throws SANDBOX_UNAVAILABLE when the windows helper file is missing", async () => {
    const provider = createSandboxProvider({
      platform: "win32",
      helperPath: "Z:/missing/pi-sandbox-win.exe",
    });
    await expect(provider.confine(caller, policy)).rejects.toMatchObject({
      code: "SANDBOX_UNAVAILABLE",
      message: expect.stringMatching(/helper|pi-sandbox-win/i),
    });
  });

  it("uses partial windows confinement when the helper file exists", async () => {
    const helperPath = fileURLToPath(import.meta.url);
    const provider = createSandboxProvider({
      platform: "win32",
      helperPath,
      tempDir: "C:/tmp/pi-sandbox-s1",
    });
    const out = await provider.confine(caller, {
      mode: "workspace-write",
      network: "enabled",
      workspaceRoot: "C:/work/repo",
    });
    expect(out.argv[0]).toBe(helperPath);
    expect(out.argv).toContain("--workspace-sid");
    expect(out.argv).toContain("--temp-sid");
    expect(out.enforcement).toBe("partial");
    expect(out.denialExitCodes).toEqual([SANDBOX_DENIAL_EXIT]);
    expect(out.runnerFailureRules).toEqual([
      {
        kind: "runner-launch-failed",
        exitCodes: [163],
        signatures: ["pi-sandbox-win:"],
      },
    ]);
  });

  it("uses acquireTempDir on win32 and releases it on dispose", async () => {
    const helperPath = fileURLToPath(import.meta.url);
    const sessionId = `win-temp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const provider = createSandboxProvider({
      platform: "win32",
      helperPath,
    });
    const out = await provider.confine(caller, {
      mode: "workspace-write",
      network: "enabled",
      workspaceRoot: "C:/work/repo",
      sessionId,
    });
    const tempFlag = out.argv.indexOf("--temp");
    expect(tempFlag).toBeGreaterThan(-1);
    const acquired = out.argv[tempFlag + 1] ?? "";
    expect(acquired.replace(/\\/g, "/")).not.toMatch(/\/tmp\/pi-sandbox/);
    expect(acquired.toLowerCase().replace(/\\/g, "/")).toContain(
      tmpdir().toLowerCase().replace(/\\/g, "/"),
    );
    expect(existsSync(acquired)).toBe(true);
    await provider.dispose?.(sessionId);
    expect(existsSync(acquired)).toBe(false);
  });
});
