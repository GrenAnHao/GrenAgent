import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

async function loadCache() {
  vi.resetModules();
  return import("./toolsCache.js");
}

function cacheFile(): Record<string, { probedAt: string; toolNames: string[] }> {
  return JSON.parse(readFileSync(join(home, ".pi", "mcp-tools-cache.json"), "utf8"));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mcp-tools-cache-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  process.env.HOME = savedEnv.HOME;
  process.env.USERPROFILE = savedEnv.USERPROFILE;
  rmSync(home, { recursive: true, force: true });
});

describe("writeToolsCacheEntry", () => {
  it("结果和已缓存的一样时不重写文件", async () => {
    const { writeToolsCacheEntry } = await loadCache();
    writeToolsCacheEntry("deepwiki", { ok: true, toolNames: ["ask", "read"] });
    const path = join(home, ".pi", "mcp-tools-cache.json");
    const stamped = { ...cacheFile(), deepwiki: { ...cacheFile().deepwiki, probedAt: "sentinel" } };
    writeFileSync(path, JSON.stringify(stamped));

    writeToolsCacheEntry("deepwiki", { ok: true, toolNames: ["ask", "read"] });

    expect(cacheFile().deepwiki.probedAt).toBe("sentinel");
  });

  it("工具列表变了照常写入", async () => {
    const { writeToolsCacheEntry, readToolsCache } = await loadCache();
    writeToolsCacheEntry("deepwiki", { ok: true, toolNames: ["ask"] });
    writeToolsCacheEntry("deepwiki", { ok: true, toolNames: ["ask", "read"] });
    writeToolsCacheEntry("github", { ok: false, toolNames: [], error: "401" });

    expect(readToolsCache()).toEqual({ deepwiki: ["ask", "read"], github: [] });
  });
});
