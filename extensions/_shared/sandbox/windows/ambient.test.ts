import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxPolicy } from "../types.js";
import { grantSandboxAccess, type AccountIo } from "./account.js";
import {
  __resetAmbientAttemptForTest,
  ambientDenyArgs,
  ambientDenyPresent,
  ambientDenyTargets,
  applyAmbientDenies,
  parseAmbientLog,
} from "./ambient.js";

const ENV = { ProgramData: "C:\\ProgramData", PUBLIC: "C:\\Users\\Public", SystemRoot: "C:\\Windows" };

describe("ambient write-deny targets", () => {
  it("lists the world-writable system directories that exist", () => {
    const targets = ambientDenyTargets(ENV, () => true);
    expect(targets).toContain("C:\\ProgramData");
    expect(targets).toContain("C:\\Users\\Public");
    expect(targets).toContain("C:\\Windows\\Tasks");
    expect(targets).toContain("C:\\Windows\\System32\\spool\\PRINTERS");
  });

  it("leaves C:\\Windows\\Temp alone because the sandbox deliberately uses it", () => {
    const targets = ambientDenyTargets(ENV, () => true).map((target) => target.toLowerCase());
    expect(targets).not.toContain("c:\\windows\\temp");
  });

  it("omits directories that do not exist on this machine", () => {
    const targets = ambientDenyTargets(ENV, (path) => path === "C:\\ProgramData");
    expect(targets).toEqual(["C:\\ProgramData"]);
  });

  it("falls back to the stock locations when the environment variables are missing", () => {
    const targets = ambientDenyTargets({}, () => true);
    expect(targets).toContain("C:\\ProgramData");
    expect(targets).toContain("C:\\Users\\Public");
  });
});

describe("ambient write-deny icacls", () => {
  it("denies write, delete and delete-child for the sandbox account only, inheritable", () => {
    expect(ambientDenyArgs("C:\\ProgramData", "PiSandbox")).toEqual([
      "C:\\ProgramData",
      "/deny",
      "PiSandbox:(OI)(CI)(WD,AD,WEA,WA,D,DC)",
      "/C",
    ]);
  });

  it("recognises the deny ACE in an icacls dump, whatever the domain prefix", () => {
    const dump = [
      "C:\\ProgramData HOST\\PiSandbox:(OI)(CI)(DENY)(W,D,DC)",
      "              NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
    ].join("\n");
    expect(ambientDenyPresent(dump, "PiSandbox")).toBe(true);
  });

  it("does not take an allow ACE or another account's deny for the sandbox deny", () => {
    expect(ambientDenyPresent("C:\\x HOST\\PiSandbox:(OI)(CI)(M)", "PiSandbox")).toBe(false);
    expect(ambientDenyPresent("C:\\x HOST\\Other:(OI)(CI)(DENY)(W,D,DC)", "PiSandbox")).toBe(false);
    expect(ambientDenyPresent("", "PiSandbox")).toBe(false);
  });

  it("reads which targets an elevated log confirms", () => {
    const log = [
      "### C:\\ProgramData",
      "C:\\ProgramData HOST\\PiSandbox:(OI)(CI)(DENY)(W,D,DC)",
      "### C:\\Windows\\Tasks",
      "C:\\Windows\\Tasks NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
    ].join("\n");
    expect(parseAmbientLog(log, "PiSandbox")).toEqual(["C:\\ProgramData"]);
  });
});

describe("applyAmbientDenies", () => {
  beforeEach(() => __resetAmbientAttemptForTest());

  const all = () => true;

  it("stamps the missing targets in one call and records only the confirmed ones", async () => {
    const stamp = vi.fn(async (paths: string[]) => paths.filter((path) => path !== "C:\\Windows\\Tasks"));
    const grants: Record<string, string> = {};
    const changed = await applyAmbientDenies("PiSandbox", grants, stamp, { env: ENV, exists: all });
    expect(changed).toBe(true);
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(grants["ambient:c:\\programdata"]).toBe("DW1");
    expect(grants["ambient:c:\\windows\\tasks"]).toBeUndefined();
  });

  it("does nothing when every target is already recorded", async () => {
    const stamp = vi.fn(async (paths: string[]) => paths);
    const grants: Record<string, string> = {};
    await applyAmbientDenies("PiSandbox", grants, stamp, { env: ENV, exists: all });
    stamp.mockClear();
    const changed = await applyAmbientDenies("PiSandbox", grants, stamp, { env: ENV, exists: all });
    expect(changed).toBe(false);
    expect(stamp).not.toHaveBeenCalled();
  });

  it("does not ask again right after nothing was confirmed", async () => {
    const stamp = vi.fn(async () => [] as string[]);
    const grants: Record<string, string> = {};
    await applyAmbientDenies("PiSandbox", grants, stamp, { env: ENV, exists: all, now: () => 1_000 });
    await applyAmbientDenies("PiSandbox", grants, stamp, { env: ENV, exists: all, now: () => 2_000 });
    expect(stamp).toHaveBeenCalledTimes(1);
    await applyAmbientDenies("PiSandbox", grants, stamp, { env: ENV, exists: all, now: () => 1_000 + 6 * 60 * 1000 });
    expect(stamp).toHaveBeenCalledTimes(2);
  });

  it("treats a declined or failed elevation as non-fatal", async () => {
    const stamp = vi.fn(async () => {
      throw new Error("elevation declined");
    });
    const grants: Record<string, string> = {};
    await expect(applyAmbientDenies("PiSandbox", grants, stamp, { env: ENV, exists: all })).resolves.toBe(false);
    expect(grants).toEqual({});
  });

  it("rethrows an abort", async () => {
    const stamp = vi.fn(async () => {
      throw new Error("aborted");
    });
    await expect(applyAmbientDenies("PiSandbox", {}, stamp, { env: ENV, exists: all })).rejects.toThrow("aborted");
  });

  it("skips the call when no target exists", async () => {
    const stamp = vi.fn(async (paths: string[]) => paths);
    const changed = await applyAmbientDenies("PiSandbox", {}, stamp, { env: ENV, exists: () => false });
    expect(changed).toBe(false);
    expect(stamp).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "win32")("grantSandboxAccess ambient wiring", () => {
  it("stamps the ambient denies once and remembers them in grants.json", async () => {
    __resetAmbientAttemptForTest();
    const root = mkdtempSync(join(tmpdir(), "pi-ambient-"));
    const workspace = join(root, "ws");
    const tempDir = join(root, "tmp");
    mkdirSync(workspace);
    mkdirSync(tempDir);
    let stored: Record<string, string> = {};
    const stamp = vi.fn(async (paths: string[]) => paths);
    const io: AccountIo = {
      userExists: async () => true,
      provision: async () => {},
      readGrants: async () => ({ ...stored }),
      writeGrants: async (_path, next) => { stored = { ...next }; },
      grant: async () => {},
      stampAmbient: stamp,
      pathEnv: () => "",
      home: () => join(root, "home"),
      blobPath: () => join(root, "account.bin"),
      grantsPath: () => join(root, "grants.json"),
    };
    const policy: SandboxPolicy = { mode: "workspace-write", network: "enabled", workspaceRoot: workspace, sessionId: "s" };
    try {
      await grantSandboxAccess("PiSandbox", policy, tempDir, io);
      await grantSandboxAccess("PiSandbox", policy, tempDir, io);
      expect(stamp).toHaveBeenCalledTimes(1);
      expect(Object.entries(stored).some(([key, value]) => key.startsWith("ambient:") && value === "DW1")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
