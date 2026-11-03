import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { activeRuleContextFiles, createRuleCache, parseRule, ruleAppliesToMode } from "./rules.js";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "context-rules-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("parseRule", () => {
  it("读标题和开关，缺 enabled 视为启用，缺 title 用 id", () => {
    expect(parseRule("zh", "global", "/r/zh.md", "---\ntitle: 中文回答\n---\n- 中文")).toEqual({
      id: "zh", scope: "global", path: "/r/zh.md", title: "中文回答", enabled: true, body: "- 中文", modes: undefined,
    });
    expect(parseRule("x", "project", "/r/x.md", "---\nenabled: false\n---\nbody").title).toBe("x");
    expect(parseRule("x", "project", "/r/x.md", "---\nenabled: false\n---\nbody").enabled).toBe(false);
  });

  it("读 modes：数组或逗号串，空数组等同全部模式", () => {
    expect(parseRule("u", "global", "/r/u.md", "---\nmodes:\n  - ultra\n  - plan\n---\nu").modes).toEqual(["ultra", "plan"]);
    expect(parseRule("u", "global", "/r/u.md", "---\nmodes: ultra, Plan\n---\nu").modes).toEqual(["ultra", "plan"]);
    expect(parseRule("u", "global", "/r/u.md", "---\nmodes: []\n---\nu").modes).toBeUndefined();
  });

  it("未知模式不能把专属规则扩大成所有模式", () => {
    for (const value of ["[ultr]", "[ultra, nope]", "[brainstorm]", "[agent, brainstorm]", "42"]) {
      const rule = parseRule("bad-mode", "global", "/r/bad-mode.md", `---\nmodes: ${value}\n---\nUltra only`);
      expect(rule.enabled).toBe(false);
      expect(rule.error).toContain("模式");
      expect(activeRuleContextFiles([rule], "ask")).toEqual([]);
    }
  });

  it("frontmatter 坏掉时带 error，并视为未启用", () => {
    const rule = parseRule("bad", "global", "/r/bad.md", "---\ntitle: [\n---\nbody");
    expect(rule.enabled).toBe(false);
    expect(rule.error).toBeTruthy();
  });
});

describe("ruleAppliesToMode", () => {
  const base = { id: "r", scope: "global" as const, path: "/r.md", title: "t", enabled: true, body: "b" };

  it("没有 modes 的旧规则适用所有模式", () => {
    for (const mode of ["agent", "ask", "debug", "plan", "ultra"] as const) {
      expect(ruleAppliesToMode(base, mode)).toBe(true);
    }
  });

  it("有 modes 时只在列出的模式生效", () => {
    const rule = { ...base, modes: ["ultra" as const] };
    expect(ruleAppliesToMode(rule, "ultra")).toBe(true);
    expect(ruleAppliesToMode(rule, "agent")).toBe(false);
    expect(ruleAppliesToMode(rule, "plan")).toBe(false);
  });

  it("没给模式时不做过滤（兼容旧调用）", () => {
    expect(ruleAppliesToMode({ ...base, modes: ["ultra"] }, undefined)).toBe(true);
  });
});

describe("activeRuleContextFiles", () => {
  const base = { scope: "global" as const, title: "t" };

  it("只要启用、无错误、正文非空的规则", () => {
    expect(
      activeRuleContextFiles([
        { ...base, id: "a", path: "/a.md", enabled: true, body: "A" },
        { ...base, id: "b", path: "/b.md", enabled: false, body: "B" },
        { ...base, id: "c", path: "/c.md", enabled: true, body: "  " },
        { ...base, id: "d", path: "/d.md", enabled: true, body: "D", error: "x" },
      ]),
    ).toEqual([{ path: "/a.md", content: "A" }]);
  });

  it("按当前模式过滤：模式专属规则只在对应模式出现，旧规则全模式保留", () => {
    const rules = [
      { ...base, id: "all", path: "/all.md", enabled: true, body: "ALL" },
      { ...base, id: "u", path: "/u.md", enabled: true, body: "U", modes: ["ultra" as const] },
      { ...base, id: "p", path: "/p.md", enabled: true, body: "P", modes: ["plan" as const, "ultra" as const] },
    ];
    expect(activeRuleContextFiles(rules, "ultra").map((f) => f.path)).toEqual(["/all.md", "/u.md", "/p.md"]);
    expect(activeRuleContextFiles(rules, "plan").map((f) => f.path)).toEqual(["/all.md", "/p.md"]);
    expect(activeRuleContextFiles(rules, "agent").map((f) => f.path)).toEqual(["/all.md"]);
  });

  it("未启用或被禁用的模式规则不出现", () => {
    const rules = [
      { ...base, id: "u", path: "/u.md", enabled: false, body: "U", modes: ["ultra" as const] },
      { ...base, id: "v", path: "/v.md", enabled: true, body: "V", modes: ["ultra" as const] },
    ];
    expect(activeRuleContextFiles(rules, "ultra")).toEqual([{ path: "/v.md", content: "V" }]);
  });
});

describe("createRuleCache with modes", () => {
  it("缓存解析结果里保留 modes", () => {
    const dir = dirWith({ "u.md": "---\nmodes: [ultra]\n---\nu" });
    const cache = createRuleCache(vi.fn());
    expect(cache.load([{ dir, scope: "global" }])[0].modes).toEqual(["ultra"]);
  });
});
