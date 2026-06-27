import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAgentTemplates, seedModeFromConfig } from "./seed-agents.js";

const TEMPLATES = { worker: "WORKER-V2\n", scout: "SCOUT-V2\n" };
const MANIFEST = ".seed.json";

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function makeDir(): string {
  root = mkdtempSync(join(tmpdir(), "pi-seedhelper-"));
  return join(root, "agents");
}

function read(dir: string, name: string): string {
  return readFileSync(join(dir, `${name}.md`), "utf8");
}

describe("seedModeFromConfig", () => {
  it("maps config values to modes (default auto)", () => {
    expect(seedModeFromConfig("0")).toBe("off");
    expect(seedModeFromConfig("off")).toBe("off");
    expect(seedModeFromConfig("force")).toBe("force");
    expect(seedModeFromConfig("if-absent")).toBe("if-absent");
    expect(seedModeFromConfig(undefined)).toBe("auto");
    expect(seedModeFromConfig("1")).toBe("auto");
  });
});

describe("seedAgentTemplates", () => {
  it("off → no-op (no files, no manifest)", () => {
    const dir = makeDir();
    const r = seedAgentTemplates({ templates: TEMPLATES, dir, manifestFile: MANIFEST, version: "v", mode: "off" });
    expect(r).toEqual({ wrote: [], upgraded: [], preserved: [] });
    expect(existsSync(dir)).toBe(false);
  });

  it("writes missing files and records hashes", () => {
    const dir = makeDir();
    const r = seedAgentTemplates({ templates: TEMPLATES, dir, manifestFile: MANIFEST, version: "v1", mode: "auto" });
    expect(r.wrote.sort()).toEqual(["scout", "worker"]);
    expect(read(dir, "worker")).toBe("WORKER-V2\n");
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as { version: string; hashes: Record<string, string> };
    expect(m.version).toBe("v1");
    expect(Object.keys(m.hashes).sort()).toEqual(["scout", "worker"]);
  });

  it("if-absent never overwrites an existing file", () => {
    const dir = makeDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worker.md"), "USER\n", "utf8");
    const r = seedAgentTemplates({ templates: TEMPLATES, dir, manifestFile: MANIFEST, version: "v", mode: "if-absent" });
    expect(read(dir, "worker")).toBe("USER\n");
    expect(r.wrote).toEqual(["scout"]); // only the missing one
  });

  it("force overwrites everything", () => {
    const dir = makeDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worker.md"), "USER\n", "utf8");
    const r = seedAgentTemplates({ templates: TEMPLATES, dir, manifestFile: MANIFEST, version: "v", mode: "force" });
    expect(read(dir, "worker")).toBe("WORKER-V2\n");
    expect(r.upgraded).toContain("worker");
  });

  it("auto upgrades a file we previously wrote when the template drifts", () => {
    const dir = makeDir();
    // First seed at "v1" with the OLD content.
    seedAgentTemplates({ templates: { worker: "WORKER-V1\n" }, dir, manifestFile: MANIFEST, version: "v1", mode: "auto" });
    expect(read(dir, "worker")).toBe("WORKER-V1\n");
    // Template changes → unmodified-ours file gets upgraded.
    const r = seedAgentTemplates({ templates: { worker: "WORKER-V2\n" }, dir, manifestFile: MANIFEST, version: "v2", mode: "auto" });
    expect(read(dir, "worker")).toBe("WORKER-V2\n");
    expect(r.upgraded).toEqual(["worker"]);
  });

  it("auto preserves a file the user edited after our write", () => {
    const dir = makeDir();
    seedAgentTemplates({ templates: { worker: "WORKER-V1\n" }, dir, manifestFile: MANIFEST, version: "v1", mode: "auto" });
    writeFileSync(join(dir, "worker.md"), "USER-EDIT\n", "utf8"); // diverge from recorded hash
    const r = seedAgentTemplates({ templates: { worker: "WORKER-V2\n" }, dir, manifestFile: MANIFEST, version: "v2", mode: "auto" });
    expect(read(dir, "worker")).toBe("USER-EDIT\n");
    expect(r.preserved).toEqual(["worker"]);
  });

  it("auto adopts+upgrades on first migration from a legacy plain-text marker", () => {
    const dir = makeDir();
    mkdirSync(dir, { recursive: true });
    // Simulate an old install: stale shipped file + legacy plain-text version marker.
    writeFileSync(join(dir, "worker.md"), "WORKER-OLD\n", "utf8");
    writeFileSync(join(dir, MANIFEST), "2026-06-20\n", "utf8");
    const r = seedAgentTemplates({ templates: { worker: "WORKER-V2\n" }, dir, manifestFile: MANIFEST, version: "v2", mode: "auto" });
    expect(read(dir, "worker")).toBe("WORKER-V2\n");
    expect(r.upgraded).toEqual(["worker"]);
    // Manifest is upgraded to JSON with recorded hashes.
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as { version: string; hashes: Record<string, string> };
    expect(m.version).toBe("v2");
    expect(m.hashes.worker).toBeTruthy();
  });

  it("auto leaves an already-current file untouched but records ownership", () => {
    const dir = makeDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worker.md"), "WORKER-V2\n", "utf8"); // identical to current template
    const r = seedAgentTemplates({ templates: { worker: "WORKER-V2\n" }, dir, manifestFile: MANIFEST, version: "v2", mode: "auto" });
    expect(r.upgraded).toEqual([]);
    expect(r.preserved).toEqual([]);
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as { hashes: Record<string, string> };
    expect(m.hashes.worker).toBeTruthy();
  });
});
