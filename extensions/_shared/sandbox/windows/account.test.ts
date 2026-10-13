import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxPolicy } from "../types.js";
import {
  __resetAncestorRetryForTest,
  ancestorDirectories,
  defaultSandboxHome,
  grantKey,
  grantSandboxAccess,
  icaclsGrantArgs,
  isGrantableAncestor,
  needsGrant,
  parseStatProbe,
  profilePathDirs,
  REACHABLE,
  sandboxIdentityEnv,
  statProbeArgv,
  windowsPowerShellEnv,
  windowsTempAllowsList,
  type AccountIo,
  type GrantRights,
} from "./account.js";

describe("windows sandbox account grants", () => {
  it("builds an inheritable icacls grant and propagates only when asked", () => {
    expect(icaclsGrantArgs("C:/work/repo", "PiSandbox", "M", true)).toEqual([
      "C:/work/repo",
      "/grant:r",
      "PiSandbox:(OI)(CI)M",
      "/C",
      "/T",
    ]);
    expect(icaclsGrantArgs("C:/work/repo", "PiSandbox", "RX", false)).not.toContain("/T");
    expect(icaclsGrantArgs("C:/Users/me/.pi", "PiSandbox", "RAX", true)).toEqual([
      "C:/Users/me/.pi",
      "/grant:r",
      "PiSandbox:(RA,X)",
      "/C",
    ]);
    expect(icaclsGrantArgs("C:/Windows/Temp", "PiSandbox", "RD", true)).toEqual([
      "C:/Windows/Temp",
      "/grant:r",
      "PiSandbox:(S,RD,RA)",
      "/C",
    ]);
  });

  it("points identity and temp at the sandbox profile, not the signed-in user", () => {
    const home = defaultSandboxHome("PiSandbox", "C:");
    const env = sandboxIdentityEnv(home, "PiSandbox");
    expect(env.USERNAME).toBe("PiSandbox");
    expect(env.USERPROFILE).toBe(home);
    expect(env.HOMEDRIVE).toBe("C:");
    expect(env.HOMEPATH).toBe("\\Users\\PiSandbox");
    expect(env.TEMP).toBe(`${home}\\AppData\\Local\\Temp`);
    expect(env.TMP).toBe(env.TEMP);
    expect(env.TMPDIR).toBe(env.TEMP);
    expect(env.APPDATA).toBe(`${home}\\AppData\\Roaming`);
    expect(env.LOCALAPPDATA).toBe(`${home}\\AppData\\Local`);
    expect(env.USERPROFILE).not.toContain("rxstudio");
    expect(env.TEMP).not.toContain("pi-sandbox");
  });

  it("lists ancestor directories and stops before the drive root", () => {
    const dirs = ancestorDirectories("C:/Users/me/.pi/agent/works/session").map(grantKey);
    expect(dirs[0]).toBe(grantKey("C:/Users/me/.pi/agent/works"));
    expect(dirs).toContain(grantKey("C:/Users/me/.pi"));
    expect(dirs).toContain(grantKey("C:/Users/me"));
    expect(dirs.some((dir) => dir === "c:" || dir === "c:/")).toBe(false);
  });

  it("does not grant traverse on the profile root or AppData", () => {
    const home = "C:/Users/me";
    const temp = "C:/Users/me/AppData/Local/Temp/pi-sandbox/session";
    expect(isGrantableAncestor("C:/Users/me/.pi", home, temp)).toBe(true);
    expect(isGrantableAncestor("C:/Users/me/.pi/agent", home, temp)).toBe(true);
    expect(isGrantableAncestor("C:/Users/me/AppData/Local/Temp/pi-sandbox", home, temp)).toBe(true);
    expect(isGrantableAncestor("C:/Users/me", home, temp)).toBe(false);
    expect(isGrantableAncestor("C:/Users/me/AppData", home, temp)).toBe(false);
    expect(isGrantableAncestor("C:/Users/me/AppData/Local", home, temp)).toBe(false);
    expect(isGrantableAncestor("C:/Users", home, temp)).toBe(false);
  });

  it("skips a path whose recorded rights already match", () => {
    const key = grantKey("C:/work/repo");
    expect(needsGrant({ [key]: "M" }, "C:/work/repo/", "M")).toBe(false);
    expect(needsGrant({ [key]: "RX" }, "C:/work/repo", "M")).toBe(true);
    expect(needsGrant({}, "C:/work/repo", "RX")).toBe(true);
  });

  it("selects PATH entries under the user profile only", () => {
    const home = "C:/Users/me";
    expect(profilePathDirs(
      "C:\\Windows\\System32;C:\\Users\\me\\AppData\\Local\\fnm;C:\\Users\\me\\AppData\\Local\\fnm",
      home,
    ).map(grantKey)).toEqual([grantKey("C:/Users/me/AppData/Local/fnm")]);
  });

  it("does not treat a stale RD record as a confirmed Windows Temp list grant", () => {
    const key = grantKey("C:/Windows/Temp");
    expect(needsGrant({ [key]: "RD" }, "C:/Windows/Temp", "RD1")).toBe(true);
    expect(needsGrant({ [key]: "RD1" }, "C:/Windows/Temp", "RD1")).toBe(false);
  });

  it("reads an icacls dump for list rights without treating add-file as list", () => {
    const usersOnly = "C:\\Windows\\Temp BUILTIN\\Users:(CI)(S,WD,AD,X)";
    const granted = "C:\\Windows\\Temp BUILTIN\\Users:(CI)(S,WD,AD,X)\n              HOST\\PiSandbox:(S,RD,RA)";
    expect(windowsTempAllowsList(usersOnly, "PiSandbox")).toBe(false);
    expect(windowsTempAllowsList(granted, "PiSandbox")).toBe(true);
    expect(icaclsGrantArgs("C:/Windows/Temp", "PiSandbox", "RD1", true)).toEqual([
      "C:/Windows/Temp",
      "/grant:r",
      "PiSandbox:(S,RD,RA)",
      "/C",
    ]);
  });
});

describe("workspace ancestor traverse grants", () => {
  let root: string;
  let workspace: string;
  let tempDir: string;
  let policy: SandboxPolicy;

  beforeEach(() => {
    __resetAncestorRetryForTest();
    root = mkdtempSync(join(tmpdir(), "pi-acct-"));
    workspace = join(root, "private", "mid", "ws");
    tempDir = join(root, "t", "session");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(tempDir, { recursive: true });
    policy = { mode: "workspace-write", network: "enabled", workspaceRoot: workspace, sessionId: "s" };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fakeIo(opts: {
    blocked?: string[];
    probe?: AccountIo["unreachable"] | null;
    failGrant?: (path: string, rights: GrantRights) => boolean;
  }) {
    let stored: Record<string, string> = {};
    const grants: Array<{ path: string; rights: GrantRights }> = [];
    const probes: string[][] = [];
    const blockedKeys = new Set((opts.blocked ?? []).map(grantKey));
    const defaultProbe: AccountIo["unreachable"] = async (paths) => {
      probes.push(paths);
      return paths.filter((p) => blockedKeys.has(grantKey(p)));
    };
    const io: AccountIo = {
      userExists: async () => true,
      provision: async () => {},
      readGrants: async () => ({ ...stored }),
      writeGrants: async (_path, next) => {
        stored = { ...next };
      },
      grant: async (path, _username, rights) => {
        if (opts.failGrant?.(path, rights)) throw new Error("access denied");
        grants.push({ path, rights });
      },
      pathEnv: () => "",
      home: () => join(root, "home"),
      blobPath: () => join(root, "account.bin"),
      grantsPath: () => join(root, "grants.json"),
      ...(opts.probe === null ? {} : { unreachable: opts.probe ?? defaultProbe }),
    };
    return { io, grants, probes, stored: () => stored };
  }

  const ancestorGrants = (grants: Array<{ path: string; rights: GrantRights }>) =>
    grants.filter((g) => g.rights === "RAX" && ancestorDirectories(workspace).some((d) => grantKey(d) === grantKey(g.path)));

  it("grants traverse only on the workspace ancestors the sandbox account cannot stat", async () => {
    const mid = join(root, "private", "mid");
    const { io, grants, probes, stored } = fakeIo({ blocked: [mid] });
    await grantSandboxAccess("PiSandbox", policy, tempDir, io);
    expect(probes).toHaveLength(1);
    expect(probes[0].map(grantKey)).toEqual(ancestorDirectories(workspace).map(grantKey));
    expect(ancestorGrants(grants).map((g) => grantKey(g.path))).toEqual([grantKey(mid)]);
    expect(stored()[grantKey(mid)]).toBe("RAX");
    expect(stored()[grantKey(join(root, "private"))]).toBe(REACHABLE);
  });

  it("does not probe again once every ancestor is recorded", async () => {
    const { io, probes } = fakeIo({ blocked: [join(root, "private")] });
    await grantSandboxAccess("PiSandbox", policy, tempDir, io);
    await grantSandboxAccess("PiSandbox", policy, tempDir, io);
    expect(probes).toHaveLength(1);
  });

  it("waits out a cooldown instead of retrying a failed ancestor grant on every command", async () => {
    const mid = join(root, "private", "mid");
    const { io, probes, stored } = fakeIo({
      blocked: [mid],
      failGrant: (path, rights) => rights === "RAX" && grantKey(path) === grantKey(mid),
    });
    await grantSandboxAccess("PiSandbox", policy, tempDir, io);
    expect(stored()[grantKey(mid)]).toBeUndefined();
    await grantSandboxAccess("PiSandbox", policy, tempDir, io);
    expect(probes).toHaveLength(1);
    __resetAncestorRetryForTest();
    await grantSandboxAccess("PiSandbox", policy, tempDir, io);
    expect(probes).toHaveLength(2);
    expect(probes[1].map(grantKey)).toEqual([grantKey(mid)]);
  });

  it("records nothing when the probe itself fails", async () => {
    const { io, grants, stored } = fakeIo({
      probe: async () => {
        throw new Error("helper failed");
      },
    });
    await grantSandboxAccess("PiSandbox", policy, tempDir, io);
    expect(ancestorGrants(grants)).toEqual([]);
    expect(stored()[grantKey(join(root, "private"))]).toBeUndefined();
  });

  it("leaves workspace ancestors alone without a probe", async () => {
    const { io, grants, stored } = fakeIo({ probe: null });
    await grantSandboxAccess("PiSandbox", policy, tempDir, io);
    expect(ancestorGrants(grants)).toEqual([]);
    expect(stored()[grantKey(join(root, "private"))]).toBeUndefined();
  });

  it("maps probe output indices back to paths and ignores noise", () => {
    const paths = ["C:/a", "C:/a/b", "C:/a/b/c"];
    expect(parseStatProbe("1\r\n2\r\n", paths)).toEqual(["C:/a/b", "C:/a/b/c"]);
    expect(parseStatProbe("warning: x\n7\n\n0\n", paths)).toEqual(["C:/a"]);
  });

  it("drops a pwsh 7 PSModulePath so Windows PowerShell loads its own modules", () => {
    const env = windowsPowerShellEnv({ PSModulePath: "C:/Program Files/PowerShell/7/Modules", Path: "C:/x" });
    expect(Object.keys(env).some((key) => key.toLowerCase() === "psmodulepath")).toBe(false);
    expect(env.Path).toBe("C:/x");
  });

  it("probes with Windows PowerShell and passes paths through the environment", () => {
    const argv = statProbeArgv("C:\\Windows");
    expect(argv[0]).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    expect(argv.at(-1)).toContain("$env:PI_SANDBOX_STAT_PATHS");
    // Fixed length whatever the paths: the helper's command line stops near 1000 characters.
    expect(argv.join(" ").length).toBeLessThan(400);
  });
});