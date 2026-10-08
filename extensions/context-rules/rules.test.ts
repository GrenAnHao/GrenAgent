import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { activeRuleContextFiles, createRuleCache, listRuleIds, parseRule } from "./rules.js";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "context-rules-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("parseRule", () => {
  it("读标题和开关，缺 enabled 视为启用，缺 title 用 id", () => {
    expect(parseRule("zh", "global", "/r/zh.md", "---\ntitle: 中文回答\n---\n- 中文")).toEqual({
      id: "zh", scope: "global", path: "/r/zh.md", title: "中文回答", enabled: true, body: "- 中文",
    });
    expect(parseRule("x", "project", "/r/x.md", "---\nenabled: false\n---\nbody").title).toBe("x");
    expect(parseRule("x", "project", "/r/x.md", "---\nenabled: false\n---\nbody").enabled).toBe(false);
  });

  it("frontmatter 坏掉时带 error，并视为未启用", () => {
    const rule = parseRule("bad", "global", "/r/bad.md", "---\ntitle: [\n---\nbody");
    expect(rule.enabled).toBe(false);
    expect(rule.error).toBeTruthy();
  });
});

describe("listRuleIds", () => {
  it("只列 .md 并按文件名排序，目录不存在返回空", () => {
    const dir = dirWith({ "b.md": "", "a.md": "", "c.txt": "" });
    expect(listRuleIds(dir)).toEqual(["a", "b"]);
    expect(listRuleIds(join(dir, "missing"))).toEqual([]);
  });
});

describe("createRuleCache", () => {
  it("全局在前、项目在后；文件 mtime 不变时不重新解析", () => {
    const globalDir = dirWith({ "g.md": "---\ntitle: G\n---\ng" });
    const projectDir = dirWith({ "p.md": "---\ntitle: P\n---\np" });
    const onError = vi.fn();
    const cache = createRuleCache(onError);
    const dirs = [
      { dir: globalDir, scope: "global" as const },
      { dir: projectDir, scope: "project" as const },
    ];
    const first = cache.load(dirs);
    expect(first.map((rule) => rule.id)).toEqual(["g", "p"]);
    expect(cache.load(dirs)[0]).toBe(first[0]);

    writeFileSync(join(globalDir, "g.md"), "---\ntitle: G2\n---\ng");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(globalDir, "g.md"), later, later);
    expect(cache.load(dirs)[0].title).toBe("G2");
  });

  it("坏文件只在解析时报一次", () => {
    const dir = dirWith({ "bad.md": "---\ntitle: [\n---\nx" });
    const onError = vi.fn();
    const cache = createRuleCache(onError);
    cache.load([{ dir, scope: "global" }]);
    cache.load([{ dir, scope: "global" }]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("读文件失败不写缓存，下一轮重新读", () => {
    const dir = dirWith({ "r.md": "---\ntitle: R\n---\nbody" });
    const onError = vi.fn();
    let fail = true;
    const cache = createRuleCache(onError, (path) => {
      if (fail) throw new Error("EBUSY");
      return readFileSync(path, "utf8");
    });
    const dirs = [{ dir, scope: "global" as const }];

    const first = cache.load(dirs)[0];
    expect(first.enabled).toBe(false);
    expect(first.error).toContain("EBUSY");
    expect(onError).toHaveBeenCalledTimes(1);

    fail = false;
    const second = cache.load(dirs)[0];
    expect(second.error).toBeUndefined();
    expect(second.enabled).toBe(true);
    expect(second.title).toBe("R");
  });

  it("同一个 path 连续读失败只报一次，恢复后再失败可以再报", () => {
    const dir = dirWith({ "r.md": "---\ntitle: R\n---\nbody" });
    const onError = vi.fn();
    let fail = true;
    const cache = createRuleCache(onError, (path) => {
      if (fail) throw new Error("EBUSY");
      return readFileSync(path, "utf8");
    });
    const dirs = [{ dir, scope: "global" as const }];

    cache.load(dirs);
    cache.load(dirs);
    expect(onError).toHaveBeenCalledTimes(1);

    fail = false;
    cache.load(dirs);
    fail = true;
    // 读成功的那一轮命中缓存，换 mtime 才会重新读
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, "r.md"), later, later);
    cache.load(dirs);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe("activeRuleContextFiles", () => {
  it("只要启用、无错误、正文非空的规则", () => {
    const base = { scope: "global" as const, title: "t" };
    expect(
      activeRuleContextFiles([
        { ...base, id: "a", path: "/a.md", enabled: true, body: "A" },
        { ...base, id: "b", path: "/b.md", enabled: false, body: "B" },
        { ...base, id: "c", path: "/c.md", enabled: true, body: "  " },
        { ...base, id: "d", path: "/d.md", enabled: true, body: "D", error: "x" },
      ]),
    ).toEqual([{ path: "/a.md", content: "A" }]);
  });
});
