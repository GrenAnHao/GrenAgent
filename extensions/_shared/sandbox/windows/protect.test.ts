import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxPolicy } from "../types.js";
import { __resetReclaimPruneForTest, grantKey, grantSandboxAccess, type AccountIo } from "./account.js";
import {
  __resetProtectFailuresForTest,
  applyWorkspaceProtection,
  PROTECT_COOLDOWN_MS,
  PROTECT_VERSION,
  protectedKey,
  protectedTargets,
  protectSteps,
  type ProtectTarget,
} from "./protect.js";

describe("what the sandbox account may not change in a workspace", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-protect-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists the configuration directories that exist, each with an identity that changes when it is replaced", () => {
    mkdirSync(join(root, ".pi"));
    mkdirSync(join(root, ".vscode"));
    mkdirSync(join(root, "src"));
    const found = protectedTargets(root);
    expect(found.map((t) => t.relative)).toEqual([".pi", ".vscode"]);
    expect(found.every((t) => /^\d+$/.test(t.id))).toBe(true);
    const before = found[0].id;
    rmSync(join(root, ".pi"), { recursive: true });
    mkdirSync(join(root, ".pi"));
    expect(protectedTargets(root).find((t) => t.relative === ".pi")?.id).not.toBe(before);
  });

  it("finds nothing in a plain directory, and leaves .git and single files out of it", () => {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "");
    writeFileSync(join(root, ".gitmodules"), "");
    writeFileSync(join(root, ".mcp.json"), "{}");
    expect(protectedTargets(root)).toEqual([]);
  });

  it("does not follow a protected name that is a link to somewhere else", () => {
    const outside = mkdtempSync(join(tmpdir(), "pi-protect-out-"));
    try {
      symlinkSync(outside, join(root, ".pi"), "junction");
      expect(protectedTargets(root)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not take a plain file for a directory", () => {
    writeFileSync(join(root, ".pi"), "not a directory");
    expect(protectedTargets(root)).toEqual([]);
  });
});

describe("protect commands", () => {
  it("takes ownership away from the sandbox account first, then stops inheriting, then replaces its entry with read and execute", () => {
    expect(protectSteps("C:\\w\\.pi", "PiSandbox", "alice")).toEqual([
      ["C:\\w\\.pi", "/setowner", "alice", "/T", "/L", "/C", "/Q"],
      ["C:\\w\\.pi", "/inheritance:d", "/L", "/C", "/Q"],
      ["C:\\w\\.pi", "/grant:r", "PiSandbox:(OI)(CI)(RX)", "/L", "/C", "/Q"],
    ]);
  });

  it("acts on a link itself and never follows it: the name could be swapped for a junction after it was checked", () => {
    for (const step of protectSteps("C:\\w\\.pi", "PiSandbox", "alice")) expect(step).toContain("/L");
  });

  it("never removes the account's entry before the replacement is in place, so there is no moment without access", () => {
    const flat = protectSteps("C:\\w\\.pi", "PiSandbox", "alice").map((step) => step[1]);
    expect(flat).not.toContain("/remove:g");
    expect(flat.at(-1)).toBe("/grant:r");
  });

  it("never denies anything: a deny of DELETE also makes the file unreadable for the account", () => {
    expect(protectSteps("C:\\w\\x", "PiSandbox", "alice").flat().join(" ")).not.toMatch(/\/deny/i);
  });
});

describe("applyWorkspaceProtection", () => {
  const pi: ProtectTarget = { path: "C:\\w\\.pi", relative: ".pi", id: "11" };
  const vscode: ProtectTarget = { path: "C:\\w\\.vscode", relative: ".vscode", id: "22" };
  const key = protectedKey(grantKey("C:\\w"));
  const same = () => true;

  beforeEach(() => __resetProtectFailuresForTest());

  it("protects each directory on its own and records what it protected, with its identity", async () => {
    const protect = vi.fn(async () => {});
    const grants: Record<string, string> = {};
    const changed = await applyWorkspaceProtection("PiSandbox", "C:\\w", grants, protect, { targets: [pi, vscode], stillSame: same });
    expect(changed).toBe(true);
    expect(protect.mock.calls.map((call) => ((call as unknown[])[1] as ProtectTarget[]).map((t) => t.relative))).toEqual([[".pi"], [".vscode"]]);
    expect(grants[key]).toBe(`${PROTECT_VERSION}:.pi@11,.vscode@22`);
  });

  it("does nothing again while the directories are the same ones", async () => {
    const protect = vi.fn(async () => {});
    const grants: Record<string, string> = {};
    await applyWorkspaceProtection("PiSandbox", "C:\\w", grants, protect, { targets: [pi, vscode], stillSame: same });
    protect.mockClear();
    expect(await applyWorkspaceProtection("PiSandbox", "C:\\w", grants, protect, { targets: [pi, vscode], stillSame: same })).toBe(false);
    expect(protect).not.toHaveBeenCalled();
  });

  it("protects a directory that was deleted and created again, because it is a different one now", async () => {
    const protect = vi.fn(async () => {});
    const grants: Record<string, string> = {};
    await applyWorkspaceProtection("PiSandbox", "C:\\w", grants, protect, { targets: [pi], stillSame: same });
    protect.mockClear();
    await applyWorkspaceProtection("PiSandbox", "C:\\w", grants, protect, { targets: [{ ...pi, id: "99" }], stillSame: same });
    expect(protect).toHaveBeenCalledTimes(1);
    expect(grants[key]).toBe(`${PROTECT_VERSION}:.pi@99`);
  });

  it("protects one that appeared since, without redoing the ones already done", async () => {
    const protect = vi.fn(async () => {});
    const grants: Record<string, string> = {};
    await applyWorkspaceProtection("PiSandbox", "C:\\w", grants, protect, { targets: [pi], stillSame: same });
    protect.mockClear();
    await applyWorkspaceProtection("PiSandbox", "C:\\w", grants, protect, { targets: [pi, vscode], stillSame: same });
    expect(protect).toHaveBeenCalledTimes(1);
    expect(((protect.mock.calls[0] as unknown[])[1] as ProtectTarget[])[0].relative).toBe(".vscode");
  });

  it("starts over when the rule version changed", async () => {
    const protect = vi.fn(async () => {});
    const grants: Record<string, string> = { [key]: "PR0:.pi@11" };
    await applyWorkspaceProtection("PiSandbox", "C:\\w", grants, protect, { targets: [pi], stillSame: same });
    expect(protect).toHaveBeenCalledTimes(1);
  });

  it("keeps what it managed to protect when a later directory fails, and does not hammer a failing one", async () => {
    let calls = 0;
    const protect = vi.fn(async (_u: string, targets: ProtectTarget[]) => {
      calls += 1;
      if (targets[0].relative === ".vscode") throw new Error("timed out");
    });
    const grants: Record<string, string> = {};
    const options = { targets: [pi, vscode], stillSame: same, now: () => 1_000 };
    expect(await applyWorkspaceProtection("PiSandbox", "C:\\w", grants, protect, options)).toBe(true);
    expect(grants[key]).toBe(`${PROTECT_VERSION}:.pi@11`);
    expect(calls).toBe(2);
    // within the cooldown it does not try again
    await applyWorkspaceProtection("PiSandbox", "C:\\w", grants, protect, { ...options, now: () => 2_000 });
    expect(calls).toBe(2);
    // after it, it does, and only the failed one
    await applyWorkspaceProtection("PiSandbox", "C:\\w", grants, protect, { ...options, now: () => 1_000 + PROTECT_COOLDOWN_MS });
    expect(calls).toBe(3);
  });

  it("does not record a directory that was swapped while it was being protected", async () => {
    const protect = vi.fn(async () => {});
    const grants: Record<string, string> = {};
    const changed = await applyWorkspaceProtection("PiSandbox", "C:\\w", grants, protect, { targets: [pi], stillSame: () => false });
    expect(changed).toBe(false);
    expect(grants[key]).toBeUndefined();
  });

  it("rethrows an abort", async () => {
    const protect = vi.fn(async () => {
      throw new Error("aborted");
    });
    await expect(applyWorkspaceProtection("PiSandbox", "C:\\w", {}, protect, { targets: [pi], stillSame: same })).rejects.toThrow("aborted");
  });
});

describe("grantSandboxAccess protects the workspace in write mode only", () => {
  let root: string;
  let workspace: string;
  let tempDir: string;

  beforeEach(() => {
    __resetReclaimPruneForTest();
    __resetProtectFailuresForTest();
    root = mkdtempSync(join(tmpdir(), "pi-protect-grant-"));
    workspace = join(root, "ws");
    tempDir = join(root, "tmp");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    mkdirSync(tempDir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function io(stored: Record<string, string>, protect: AccountIo["protect"]): AccountIo {
    return {
      userExists: async () => true,
      provision: async () => {},
      readGrants: async () => ({ ...stored }),
      writeGrants: async (_path, next) => {
        for (const key of Object.keys(stored)) delete stored[key];
        Object.assign(stored, next);
      },
      grant: async () => {},
      pathEnv: () => "",
      home: () => join(root, "home"),
      blobPath: () => join(root, "account.bin"),
      grantsPath: () => join(root, "grants.json"),
      ...(protect ? { protect } : {}),
    };
  }

  const policy = (mode: SandboxPolicy["mode"], workspaceRoot = workspace): SandboxPolicy => ({ mode, network: "enabled", workspaceRoot, sessionId: "s" });

  it("protects the workspace's configuration directories after granting write access", async () => {
    const protect = vi.fn(async () => {});
    const stored: Record<string, string> = {};
    await grantSandboxAccess("PiSandbox", policy("workspace-write"), tempDir, io(stored, protect));
    expect(protect).toHaveBeenCalledTimes(1);
    expect(stored[protectedKey(grantKey(workspace))]).toMatch(new RegExp(`^${PROTECT_VERSION}:\\.pi@\\d+$`));
  });

  it("protects again after the workspace grant is applied again, because that grant overwrites the account's entries on every object", async () => {
    const protect = vi.fn(async () => {});
    const stored: Record<string, string> = {};
    const account = io(stored, protect);
    await grantSandboxAccess("PiSandbox", policy("workspace-write"), tempDir, account);
    await grantSandboxAccess("PiSandbox", policy("workspace-write"), tempDir, account);
    expect(protect).toHaveBeenCalledTimes(1);
    delete stored[grantKey(workspace)];
    await grantSandboxAccess("PiSandbox", policy("workspace-write"), tempDir, account);
    expect(protect).toHaveBeenCalledTimes(2);
  });

  it("protects a workspace inside another one again when the outer one is granted, since that grant reaches the inner one too", async () => {
    const inner = join(workspace, "inner");
    mkdirSync(join(inner, ".pi"), { recursive: true });
    const protect = vi.fn(async () => {});
    const stored: Record<string, string> = {};
    const account = io(stored, protect);
    await grantSandboxAccess("PiSandbox", policy("workspace-write", inner), tempDir, account);
    expect(stored[protectedKey(grantKey(inner))]).toBeDefined();
    await grantSandboxAccess("PiSandbox", policy("workspace-write", workspace), tempDir, account);
    expect(stored[protectedKey(grantKey(inner))]).toBeUndefined();
  });

  it("does not bother in read-only mode, where there is nothing to write", async () => {
    const protect = vi.fn(async () => {});
    await grantSandboxAccess("PiSandbox", policy("read-only"), tempDir, io({}, protect));
    expect(protect).not.toHaveBeenCalled();
  });

  it("is skipped by an io that cannot protect", async () => {
    const stored: Record<string, string> = {};
    await grantSandboxAccess("PiSandbox", policy("workspace-write"), tempDir, io(stored, undefined));
    expect(Object.keys(stored).some((key) => key.startsWith("protect:"))).toBe(false);
  });
});
