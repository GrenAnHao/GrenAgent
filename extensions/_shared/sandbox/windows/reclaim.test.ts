import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxPolicy } from "../types.js";
import { __resetReclaimPruneForTest, grantKey, grantSandboxAccess, type AccountIo } from "./account.js";
import {
  GRANT_MAX_IDLE_MS,
  MAX_REVOKES_PER_RUN,
  mergeGrantChanges,
  pathKey,
  reclaimGrants,
  revokeArgs,
  usedKey,
  USED_REFRESH_MS,
} from "./reclaim.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function opts(overrides: Partial<Parameters<typeof reclaimGrants>[1]> = {}) {
  return {
    now: NOW,
    keep: ["C:/work/current", "C:/tmp/pi-sandbox/s1"],
    exists: () => true,
    revoke: vi.fn(),
    prune: true,
    ...overrides,
  };
}

describe("path keys", () => {
  it("are the same as the keys account.ts records grants under", () => {
    for (const p of ["C:\\Work\\Repo\\", "d:/x/Y", "C:\\a\\..\\b"]) expect(pathKey(p)).toBe(grantKey(p));
  });
});

describe("revoke command", () => {
  it("removes only the grant entries of the sandbox account, so denies stay", () => {
    expect(revokeArgs("C:\\work\\old", "PiSandbox")).toEqual(["C:\\work\\old", "/remove:g", "PiSandbox", "/T", "/C", "/Q"]);
  });
});

describe("reclaimGrants", () => {
  it("drops records of paths that no longer exist, along with their last-used time", () => {
    const grants = {
      [grantKey("C:/gone")]: "M",
      [usedKey(grantKey("C:/gone"))]: String(NOW - DAY),
      [grantKey("C:/here")]: "M",
    };
    const o = opts({ exists: (p) => grantKey(p) !== grantKey("C:/gone") });
    expect(reclaimGrants(grants, o)).toBe(true);
    expect(grants[grantKey("C:/gone")]).toBeUndefined();
    expect(grants[usedKey(grantKey("C:/gone"))]).toBeUndefined();
    expect(grants[grantKey("C:/here")]).toBe("M");
    expect(o.revoke).not.toHaveBeenCalled();
  });

  it("keeps the system-level records: ambient denies and the Windows Temp list grant", () => {
    const winTemp = grantKey("C:/Windows/Temp");
    const grants = { "ambient:c:\\programdata": "DW1", [winTemp]: "RD1" };
    // The ambient record has no directory behind its key, and must survive that; the Windows Temp record is a directory that exists.
    reclaimGrants(grants, opts({ keep: [], exists: (p) => grantKey(p) === winTemp }));
    expect(grants).toEqual({ "ambient:c:\\programdata": "DW1", [winTemp]: "RD1" });
  });

  it("starts the idle clock for a modify grant that has no last-used time, instead of revoking it", () => {
    const grants = { [grantKey("C:/work/old")]: "M" };
    const o = opts();
    expect(reclaimGrants(grants, o)).toBe(true);
    expect(grants[usedKey(grantKey("C:/work/old"))]).toBe(String(NOW));
    expect(o.revoke).not.toHaveBeenCalled();
    expect(grants[grantKey("C:/work/old")]).toBe("M");
  });

  it("revokes a modify grant that has been idle too long and forgets it", () => {
    const key = grantKey("C:/work/old");
    const grants = { [key]: "M", [usedKey(key)]: String(NOW - GRANT_MAX_IDLE_MS - 1) };
    const o = opts();
    expect(reclaimGrants(grants, o)).toBe(true);
    expect(o.revoke).toHaveBeenCalledWith(expect.stringMatching(/work[\\/]old$/));
    expect(grants[key]).toBeUndefined();
    expect(grants[usedKey(key)]).toBeUndefined();
  });

  it("leaves a grant alone that was used recently", () => {
    const key = grantKey("C:/work/recent");
    const grants = { [key]: "M", [usedKey(key)]: String(NOW - GRANT_MAX_IDLE_MS + DAY) };
    const o = opts();
    reclaimGrants(grants, o);
    expect(o.revoke).not.toHaveBeenCalled();
    expect(grants[key]).toBe("M");
  });

  it("never revokes the workspace or temp directory in use, however old their record is", () => {
    const grants: Record<string, string> = {};
    for (const keep of ["C:/work/current", "C:/tmp/pi-sandbox/s1"]) {
      grants[grantKey(keep)] = "M";
      grants[usedKey(grantKey(keep))] = String(NOW - 365 * DAY);
    }
    const o = opts();
    reclaimGrants(grants, o);
    expect(o.revoke).not.toHaveBeenCalled();
    expect(grants[grantKey("C:/work/current")]).toBe("M");
  });

  it("stamps the directories in use, but not more often than the refresh interval", () => {
    const grants: Record<string, string> = {};
    const o = opts();
    reclaimGrants(grants, o);
    expect(grants[usedKey(grantKey("C:/work/current"))]).toBe(String(NOW));
    const again = opts({ now: NOW + USED_REFRESH_MS - 1 });
    expect(reclaimGrants(grants, again)).toBe(false);
    expect(grants[usedKey(grantKey("C:/work/current"))]).toBe(String(NOW));
    const later = opts({ now: NOW + USED_REFRESH_MS });
    expect(reclaimGrants(grants, later)).toBe(true);
    expect(grants[usedKey(grantKey("C:/work/current"))]).toBe(String(NOW + USED_REFRESH_MS));
  });

  it("revokes at most a few per run so a long backlog does not start dozens of icacls at once", () => {
    const grants: Record<string, string> = {};
    for (let i = 0; i < MAX_REVOKES_PER_RUN + 3; i++) {
      const key = grantKey(`C:/work/old${i}`);
      grants[key] = "M";
      grants[usedKey(key)] = String(NOW - 2 * GRANT_MAX_IDLE_MS);
    }
    const o = opts();
    reclaimGrants(grants, o);
    expect(o.revoke).toHaveBeenCalledTimes(MAX_REVOKES_PER_RUN);
    expect(Object.keys(grants).filter((k) => !k.startsWith("used:") && grants[k] === "M")).toHaveLength(3);
  });

  it("reports no change when there is nothing to do", () => {
    const grants = {
      [grantKey("C:/work/current")]: "M",
      [usedKey(grantKey("C:/work/current"))]: String(NOW),
      [grantKey("C:/tmp/pi-sandbox/s1")]: "M",
      [usedKey(grantKey("C:/tmp/pi-sandbox/s1"))]: String(NOW),
    };
    expect(reclaimGrants(grants, opts())).toBe(false);
  });
});

describe("reclaimGrants: what the review found", () => {
  const OLD = String(NOW - 2 * GRANT_MAX_IDLE_MS);

  it("revokes the longest idle first", () => {
    const grants: Record<string, string> = {};
    const ages = [3, 9, 5, 7, 4].map((n) => n * DAY + GRANT_MAX_IDLE_MS);
    ages.forEach((age, i) => {
      const key = grantKey(`C:/work/p${i}`);
      grants[key] = "M";
      grants[usedKey(key)] = String(NOW - age);
    });
    const o = opts();
    reclaimGrants(grants, o);
    const order = o.revoke.mock.calls.map((call) => String(call[0]).match(/p(\d)$/)?.[1]);
    expect(order).toEqual(["1", "3", "2"]);
  });

  it("leaves the read-only, traverse and reachable records and the drive root exactly as they were", () => {
    const grants: Record<string, string> = {
      [grantKey("C:/Users/me/bin")]: "RX",
      [grantKey("C:/Users/me/.pi")]: "RAX",
      [grantKey("C:/Users/me/Downloads")]: "reachable",
      [grantKey("D:/")]: "M",
      [usedKey(grantKey("D:/"))]: OLD,
    };
    const before = { ...grants };
    reclaimGrants(grants, opts({ keep: [] }));
    expect(grants).toEqual(before);
  });

  it("does not revoke an idle parent of a directory in use: icacls /T would strip the ACE of the one in use too", () => {
    const parent = grantKey("C:/work");
    const grants: Record<string, string> = {
      [parent]: "M",
      [usedKey(parent)]: OLD,
      [grantKey("C:/work/current")]: "M",
    };
    const o = opts();
    reclaimGrants(grants, o);
    expect(o.revoke).not.toHaveBeenCalled();
    expect(grants[parent]).toBe("M");
  });

  it("does not revoke a parent of a directory that was used recently either, and an unrelated sibling name is no parent", () => {
    const parent = grantKey("C:/work");
    const sibling = grantKey("C:/work-old");
    const recent = grantKey("C:/work/recent");
    const grants: Record<string, string> = {
      [parent]: "M", [usedKey(parent)]: OLD,
      [sibling]: "M", [usedKey(sibling)]: OLD,
      [recent]: "M", [usedKey(recent)]: String(NOW - DAY),
    };
    const o = opts({ keep: [] });
    reclaimGrants(grants, o);
    const revoked = o.revoke.mock.calls.map((call) => String(call[0]));
    expect(revoked).toEqual([expect.stringMatching(/work-old$/)]);
    expect(grants[parent]).toBe("M");
  });

  it("forgets every record under a directory it revokes, whatever their rights, so they get granted again on next use", () => {
    const root = grantKey("C:/proj");
    const grants: Record<string, string> = {
      [root]: "M", [usedKey(root)]: OLD,
      [grantKey("C:/proj/bin")]: "RX",
      [grantKey("C:/proj/sub/.pi")]: "RAX",
      [grantKey("C:/proj/x")]: "reachable",
      [grantKey("C:/proj-other")]: "RX",
    };
    reclaimGrants(grants, opts({ keep: [] }));
    expect(Object.keys(grants).filter((k) => k.startsWith("c:/proj/") || k === root)).toEqual([]);
    expect(grants[grantKey("C:/proj-other")]).toBe("RX");
  });

  it("compares through the real path too, so a junction does not hide a directory in use", () => {
    const real = (p: string) => (grantKey(p) === grantKey("C:/link") ? "D:/real" : p);
    const grants: Record<string, string> = {
      [grantKey("D:/real")]: "M", [usedKey(grantKey("D:/real"))]: OLD,
    };
    const o = opts({ keep: ["C:/link"], real });
    reclaimGrants(grants, o);
    expect(o.revoke).not.toHaveBeenCalled();
  });

  it("does not drop the record of a directory in use even when its lower-cased key cannot be found (case-sensitive directories)", () => {
    const grants: Record<string, string> = { [grantKey("C:/work/current")]: "M" };
    reclaimGrants(grants, opts({ exists: () => false }));
    expect(grants[grantKey("C:/work/current")]).toBe("M");
  });

  it("does not take an unavailable drive for deleted directories", () => {
    const grants: Record<string, string> = {
      [grantKey("E:/usb/project")]: "M",
      [grantKey("C:/gone")]: "M",
    };
    reclaimGrants(grants, opts({ keep: [], exists: (p) => /^c:[\\/]?$/i.test(p) }));
    expect(grants[grantKey("E:/usb/project")]).toBe("M");
    expect(grants[grantKey("C:/gone")]).toBeUndefined();
  });

  it("leaves UNC records alone: there is no drive to ask", () => {
    const unc = "//server/share/project";
    const grants: Record<string, string> = { [unc]: "M" };
    reclaimGrants(grants, opts({ keep: [], exists: () => false }));
    expect(grants[unc]).toBe("M");
  });

  it("checks for deleted directories only when asked, because that is one filesystem call per record", () => {
    const exists = vi.fn(() => false);
    const grants: Record<string, string> = { [grantKey("C:/gone")]: "M" };
    reclaimGrants(grants, opts({ keep: [], exists, prune: false }));
    expect(exists).not.toHaveBeenCalled();
    expect(grants[grantKey("C:/gone")]).toBe("M");
  });
});

describe("reclaimGrants and the workspace protection records", () => {
  const OLD = String(NOW - 2 * GRANT_MAX_IDLE_MS);

  it("drops the protection record of a workspace that no longer exists", () => {
    const grants: Record<string, string> = {
      [`protect:${grantKey("C:/gone")}`]: "PR2:.pi",
      [`protect:${grantKey("C:/here")}`]: "PR2:.pi",
    };
    reclaimGrants(grants, opts({ keep: [], exists: (p) => grantKey(p) !== grantKey("C:/gone") }));
    expect(grants[`protect:${grantKey("C:/gone")}`]).toBeUndefined();
    expect(grants[`protect:${grantKey("C:/here")}`]).toBe("PR2:.pi");
  });

  it("drops it too when it revokes the workspace, so a later grant protects it again", () => {
    const key = grantKey("C:/proj");
    const grants: Record<string, string> = { [key]: "M", [usedKey(key)]: OLD, [`protect:${key}`]: "PR2:.pi,.git" };
    reclaimGrants(grants, opts({ keep: [] }));
    expect(grants[key]).toBeUndefined();
    expect(grants[`protect:${key}`]).toBeUndefined();
  });

  it("does not treat a protection record as a directory to revoke or stamp", () => {
    const key = grantKey("C:/proj");
    const grants: Record<string, string> = { [`protect:${key}`]: "PR2:.pi" };
    const o = opts({ keep: [] });
    reclaimGrants(grants, o);
    expect(o.revoke).not.toHaveBeenCalled();
    expect(Object.keys(grants)).toEqual([`protect:${key}`]);
  });
});

describe("mergeGrantChanges", () => {
  it("applies only this run's additions and removals on top of what is on disk now", () => {
    const before = { a: "M", b: "M", c: "M" };
    const after = { a: "M", c: "RX", d: "M" };
    const onDisk = { a: "M", b: "M", c: "M", e: "M" };
    expect(mergeGrantChanges(before, after, onDisk)).toEqual({ a: "M", c: "RX", d: "M", e: "M" });
  });

  it("keeps a removal another process made, instead of writing the old record back", () => {
    const before = { w: "M", used: "1" };
    const after = { w: "M", used: "1" };
    expect(mergeGrantChanges(before, after, {})).toEqual({});
  });

  it("does not mutate its inputs", () => {
    const onDisk = { a: "M" };
    mergeGrantChanges({ a: "M" }, { b: "M" }, onDisk);
    expect(onDisk).toEqual({ a: "M" });
  });
});

describe("grantSandboxAccess reclaims as it goes", () => {
  let root: string;
  let workspace: string;
  let tempDir: string;
  let policy: SandboxPolicy;

  beforeEach(() => {
    __resetReclaimPruneForTest();
    root = mkdtempSync(join(tmpdir(), "pi-reclaim-"));
    workspace = join(root, "ws");
    tempDir = join(root, "tmp");
    mkdirSync(workspace);
    mkdirSync(tempDir);
    policy = { mode: "workspace-write", network: "enabled", workspaceRoot: workspace, sessionId: "s" };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function fakeIo(stored: Record<string, string>, revoke?: AccountIo["revoke"]) {
    const io: AccountIo = {
      userExists: async () => true,
      provision: async () => {},
      readGrants: async () => ({ ...stored }),
      writeGrants: async (_path, next) => {
        for (const k of Object.keys(stored)) delete stored[k];
        Object.assign(stored, next);
      },
      grant: async () => {},
      pathEnv: () => "",
      home: () => join(root, "home"),
      blobPath: () => join(root, "account.bin"),
      grantsPath: () => join(root, "grants.json"),
      ...(revoke ? { revoke } : {}),
    };
    return io;
  }

  it("prunes records of deleted directories and stamps the ones in use", async () => {
    const stored: Record<string, string> = { [grantKey(join(root, "deleted"))]: "M" };
    await grantSandboxAccess("PiSandbox", policy, tempDir, fakeIo(stored, vi.fn()));
    expect(stored[grantKey(join(root, "deleted"))]).toBeUndefined();
    expect(stored[usedKey(grantKey(workspace))]).toMatch(/^\d+$/);
    expect(stored[usedKey(grantKey(tempDir))]).toMatch(/^\d+$/);
  });

  it("revokes an old grant through the account io", async () => {
    const old = join(root, "old");
    mkdirSync(old);
    const stored: Record<string, string> = {
      [grantKey(old)]: "M",
      [usedKey(grantKey(old))]: String(Date.now() - GRANT_MAX_IDLE_MS - DAY),
    };
    const revoke = vi.fn();
    await grantSandboxAccess("PiSandbox", policy, tempDir, fakeIo(stored, revoke));
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0]?.[0]).toBe("PiSandbox");
    expect(grantKey(revoke.mock.calls[0]?.[1] as string)).toBe(grantKey(old));
    expect(stored[grantKey(old)]).toBeUndefined();
  });

  it("keeps a removal another process made while this call was running, instead of writing the old record back", async () => {
    const stale = join(root, "elsewhere");
    mkdirSync(stale);
    const key = grantKey(stale);
    const onDisk: Record<string, string> = { [key]: "M", [usedKey(key)]: String(Date.now()) };
    const io = fakeIo(onDisk, vi.fn());
    const read = io.readGrants.bind(io);
    let reads = 0;
    io.readGrants = async (path) => {
      reads += 1;
      const seen = await read(path);
      // Another process revokes `stale` and forgets it after our first read, before our write.
      if (reads === 1) {
        delete onDisk[key];
        delete onDisk[usedKey(key)];
      }
      return seen;
    };
    await grantSandboxAccess("PiSandbox", policy, tempDir, io);
    expect(onDisk[key]).toBeUndefined();
    expect(onDisk[usedKey(grantKey(workspace))]).toMatch(/^\d+$/);
  });

  it("checks for deleted directories only once an hour per process", async () => {
    const stored: Record<string, string> = {};
    const exists = vi.fn(() => true);
    const io = fakeIo(stored, vi.fn());
    const first = await grantSandboxAccess("PiSandbox", policy, tempDir, io);
    void first;
    stored[grantKey(join(root, "deleted-later"))] = "M";
    await grantSandboxAccess("PiSandbox", policy, tempDir, io);
    expect(stored[grantKey(join(root, "deleted-later"))]).toBe("M");
    void exists;
  });

  it("does nothing about reclaiming when the io cannot revoke", async () => {
    const stored: Record<string, string> = { [grantKey(join(root, "deleted"))]: "M" };
    await grantSandboxAccess("PiSandbox", policy, tempDir, fakeIo(stored));
    expect(stored[grantKey(join(root, "deleted"))]).toBe("M");
  });
});
