import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { establishCatalogChild, foldCatalog, foldCatalogFromEntries } from "./catalog.js";
import { writeSeed } from "./fork-seed.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* session file handle may linger on Windows */
    }
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cat-"));
  dirs.push(dir);
  return dir;
}

function persistSession(sm: SessionManager): string {
  const path = sm.getSessionFile();
  if (!path) throw new Error("session file was not created");
  // SessionManager 在没有 assistant 消息时不落盘 header/custom，测试必须自己写出 JSONL。
  const header = sm.getHeader();
  const lines = [header, ...sm.getEntries()].filter(Boolean).map((entry) => JSON.stringify(entry));
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function catalogData(over: Record<string, unknown> = {}) {
  return {
    version: 0,
    childId: "sa-1",
    sessionPath: "/c/sa-1.jsonl",
    childCreatedAt: 100,
    mode: "one-shot",
    label: "first",
    ...over,
  };
}

const fact = (over: Record<string, unknown> = {}) => ({
  type: "custom",
  customType: "subagent_catalog",
  data: catalogData(over),
});

describe("foldCatalogFromEntries", () => {
  it("keeps write order not childCreatedAt", () => {
    const view = foldCatalogFromEntries([
      fact({ childId: "sa-b", childCreatedAt: 200, label: "b" }),
      fact({ childId: "sa-a", childCreatedAt: 50, label: "a" }),
    ]);
    expect(view.entries.map((e) => e.id)).toEqual(["sa-b", "sa-a"]);
  });

  it("drops facts before subagent_catalog_base", () => {
    const view = foldCatalogFromEntries([
      fact({ childId: "sa-old" }),
      { type: "custom", customType: "subagent_catalog_base", data: { version: 0, reason: "user-fork" } },
      fact({ childId: "sa-new", label: "n" }),
    ]);
    expect(view.entries.map((e) => e.id)).toEqual(["sa-new"]);
  });

  it("marks corrupt fact and keeps siblings", () => {
    const view = foldCatalogFromEntries([
      fact({ childId: "sa-ok" }),
      { type: "custom", customType: "subagent_catalog", data: { version: 1, childId: "sa-bad" } },
    ]);
    expect(view.entries[0].id).toBe("sa-ok");
    expect(view.diagnostics?.[0]).toMatchObject({ id: "sa-bad", reason: "corrupt" });
  });

  it("uses untitled label when label is empty", () => {
    const view = foldCatalogFromEntries([fact({ childId: "sa-1", label: "  " })]);
    expect(view.entries[0]?.label).toBe("(untitled)");
  });
});

describe("establishCatalogChild", () => {
  it("stamps version 0 and appends once", () => {
    const appendEntry = vi.fn();
    establishCatalogChild(appendEntry, {
      childId: "sa-1",
      sessionPath: "/c/sa-1.jsonl",
      childCreatedAt: 100,
      mode: "one-shot",
      label: "first",
    });
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith(
      "subagent_catalog",
      expect.objectContaining({
        version: 0,
        childId: "sa-1",
        sessionPath: "/c/sa-1.jsonl",
        childCreatedAt: 100,
        mode: "one-shot",
        label: "first",
      }),
    );
  });
});

describe("foldCatalog", () => {
  it("drops catalog facts on abandoned branches", () => {
    // 第二参数必须是 tmpdir —— 不传就写进 ~/.pi/agent/sessions
    const dir = tmpDir();
    const sm = SessionManager.create("/ws", dir);
    const firstId = sm.appendCustomEntry("anchor", {});
    sm.appendCustomEntry("subagent_catalog", catalogData({ childId: "sa-old", label: "old" }));
    sm.branch(firstId);
    sm.appendCustomEntry("subagent_catalog", catalogData({ childId: "sa-new", label: "new" }));
    const path = persistSession(sm);
    expect(sm.getEntries().length).toBeGreaterThan(sm.buildContextEntries().length);
    expect(readFileSync(path, "utf8")).toContain("sa-old");
    const view = foldCatalog(path);
    expect(view.entries.map((e) => e.id)).toEqual(["sa-new"]);
  });

  it("returns empty view when the session cannot be opened", () => {
    const path = join(tmpDir(), "broken.jsonl");
    writeFileSync(path, "not a pi session\n");
    expect(foldCatalog(path)).toEqual({ entries: [], diagnostics: [] });
  });

  it("fork seed catalog_base hides leaked parent facts", () => {
    const dir = tmpDir();
    const sm = SessionManager.create("/ws", dir, { id: "sa-fork" });
    writeSeed(sm, [{ role: "user", content: "hi" }]);
    sm.appendCustomEntry("subagent_catalog", catalogData({ childId: "sa-parent-1" }));
    sm.appendCustomEntry("subagent_catalog", catalogData({ childId: "sa-parent-2" }));
    sm.appendCustomEntry("subagent_catalog_base", { version: 0, reason: "subagent-seed" });
    sm.appendCustomEntry("subagent_meta", { inheritedEventCount: 1, mode: "one-shot" });
    const path = persistSession(sm);
    expect(foldCatalog(path).entries).toEqual([]);
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain('"customType":"subagent_catalog_base"');
    expect(raw).toContain("subagent-seed");
  });
});
