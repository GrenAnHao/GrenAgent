import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetIsolatedWorkspaceCacheForTest,
  isolatedMarkerPath,
  isolatedWorkspaceOf,
  writesIntoParent,
  type IsolatedWorkspaceMarker,
} from "./isolated-workspace.js";

let root: string;
let parent: string;

function makeIsolated(id: string, overrides: Partial<IsolatedWorkspaceMarker> = {}): string {
  const path = join(parent, ".gren", "worktrees", id);
  mkdirSync(path, { recursive: true });
  const marker: IsolatedWorkspaceMarker = {
    version: 1,
    id,
    path,
    parentRoot: parent,
    branch: `gren/${id}`,
    base: { kind: "fresh", ref: "origin/main", commit: "abc123" },
    createdAt: "2026-10-18T00:00:00.000Z",
    createdBy: "grenagent",
    ...overrides,
  };
  writeFileSync(isolatedMarkerPath(parent, id), JSON.stringify(marker));
  return path;
}

beforeEach(() => {
  __resetIsolatedWorkspaceCacheForTest();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "gren-iso-")));
  parent = join(root, "repo");
  mkdirSync(parent);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isolatedWorkspaceOf", () => {
  it("recognises <repo>/.gren/worktrees/<id> with a matching marker in the parent", () => {
    const w = makeIsolated("a1b2c3d4");
    const marker = isolatedWorkspaceOf(w);
    expect(marker?.id).toBe("a1b2c3d4");
    expect(marker?.parentRoot.toLowerCase()).toBe(parent.toLowerCase());
  });

  it("is not fooled by the right shape without a marker", () => {
    const w = join(parent, ".gren", "worktrees", "nomarker");
    mkdirSync(w, { recursive: true });
    expect(isolatedWorkspaceOf(w)).toBeUndefined();
  });

  it("ignores a marker file placed inside W (the model can write there)", () => {
    const w = join(parent, ".gren", "worktrees", "inside");
    mkdirSync(w, { recursive: true });
    writeFileSync(join(w, "inside.json"), "{}");
    expect(isolatedWorkspaceOf(w)).toBeUndefined();
  });

  it("rejects a marker that names a different id or parent", () => {
    const w1 = makeIsolated("wrongid", { id: "other" });
    expect(isolatedWorkspaceOf(w1)).toBeUndefined();
    const w2 = makeIsolated("wrongparent", { parentRoot: join(root, "elsewhere") });
    expect(isolatedWorkspaceOf(w2)).toBeUndefined();
  });

  it("does not treat ordinary projects or B-track worktrees as isolated", () => {
    expect(isolatedWorkspaceOf(parent)).toBeUndefined();
    const b = join(parent, ".agents", "worktrees", "worktree-1");
    mkdirSync(b, { recursive: true });
    expect(isolatedWorkspaceOf(b)).toBeUndefined();
    expect(isolatedWorkspaceOf(undefined)).toBeUndefined();
  });

  it("forgets a cached workspace once its marker is deleted (long-lived host process)", () => {
    const w = makeIsolated("removed1");
    expect(isolatedWorkspaceOf(w)?.id).toBe("removed1");
    rmSync(isolatedMarkerPath(parent, "removed1"));
    expect(isolatedWorkspaceOf(w)).toBeUndefined();
  });

  it("a subdirectory of W is not itself the isolated workspace root", () => {
    const w = makeIsolated("subdir");
    mkdirSync(join(w, "src"));
    expect(isolatedWorkspaceOf(join(w, "src"))).toBeUndefined();
  });
});

describe("writesIntoParent", () => {
  it("parent paths outside W are writes into the parent; W paths are not", () => {
    const w = makeIsolated("gate");
    const marker = isolatedWorkspaceOf(w)!;
    expect(writesIntoParent(marker, join(parent, "src", "a.ts"))).toBe(true);
    expect(writesIntoParent(marker, join(parent, ".gren", "worktrees", "other", "x"))).toBe(true);
    expect(writesIntoParent(marker, join(parent, ".gren", "worktrees", "gate.json"))).toBe(true);
    expect(writesIntoParent(marker, join(w, "src", "new", "a.ts"))).toBe(false);
    expect(writesIntoParent(marker, join(w, "..", "..", "..", "README.md"))).toBe(true);
    expect(writesIntoParent(marker, join(root, "outside.txt"))).toBe(false);
  });

  it("follows a junction / symlink in W that points back into the parent", () => {
    const w = makeIsolated("link");
    mkdirSync(join(parent, "src"));
    symlinkSync(join(parent, "src"), join(w, "escape"), "junction");
    const marker = isolatedWorkspaceOf(w)!;
    expect(writesIntoParent(marker, join(w, "escape", "a.ts"))).toBe(true);
    expect(writesIntoParent(marker, join(w, "escape", "deep", "new.ts"))).toBe(true);
  });
});
