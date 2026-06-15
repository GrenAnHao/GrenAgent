import { describe, expect, it } from "vitest";
import {
  decide,
  globMatch,
  matchDanger,
  matchRules,
  parsePolicy,
  summarize,
  type Policy,
  type Rule,
  type ToolEntry,
} from "./policy.js";

describe("parsePolicy", () => {
  it("returns defaults for empty / invalid json", () => {
    expect(parsePolicy("")).toEqual({
      version: 1,
      defaultPermission: "auto",
      tools: {},
      audit: { enabled: true },
    });
    expect(parsePolicy("not json")).toMatchObject({ defaultPermission: "auto", tools: {} });
  });

  it("parses tool permission and ordered rules", () => {
    const p = parsePolicy(
      JSON.stringify({
        tools: {
          mcp__fs__rm: {
            permission: "needs_approval",
            rules: [{ match: { path: "/etc/**" }, policy: "always" }, { policy: "never" }],
          },
        },
      }),
    );
    expect(p.tools.mcp__fs__rm.permission).toBe("needs_approval");
    expect(p.tools.mcp__fs__rm.rules).toEqual([
      { match: { path: "/etc/**" }, policy: "always" },
      { policy: "never" },
    ]);
  });

  it("drops invalid permission / policy values", () => {
    const p = parsePolicy(
      JSON.stringify({ defaultPermission: "weird", tools: { x: { permission: "nope", rules: [{ policy: "bad" }] } } }),
    );
    expect(p.defaultPermission).toBe("auto");
    expect(p.tools.x.permission).toBeUndefined();
    expect(p.tools.x.rules).toEqual([]);
  });

  it("audit defaults true; false only when explicitly disabled", () => {
    expect(parsePolicy("{}").audit.enabled).toBe(true);
    expect(parsePolicy(JSON.stringify({ audit: { enabled: false } })).audit.enabled).toBe(false);
  });
});

describe("globMatch", () => {
  it("matches * across slashes and exact strings", () => {
    expect(globMatch("/etc/**", "/etc/passwd")).toBe(true);
    expect(globMatch("**/.ssh/**", "/home/u/.ssh/id_rsa")).toBe(true);
    expect(globMatch("npx", "npx")).toBe(true);
    expect(globMatch("/etc/*", "/var/log")).toBe(false);
  });
  it("escapes regex metacharacters", () => {
    expect(globMatch("a.b", "axb")).toBe(false);
    expect(globMatch("a.b", "a.b")).toBe(true);
  });
});

describe("matchRules", () => {
  const rules: Rule[] = [{ match: { path: "/etc/**" }, policy: "always" }, { policy: "never" }];
  it("first matching rule wins; bare rule is catch-all", () => {
    expect(matchRules(rules, { path: "/etc/passwd" })).toBe("always");
    expect(matchRules(rules, { path: "/tmp/x" })).toBe("never");
  });
  it("returns undefined when no rules", () => {
    expect(matchRules(undefined, {})).toBeUndefined();
  });
  it("non-string arg value does not match", () => {
    expect(matchRules([{ match: { n: "1" }, policy: "required" }], { n: 1 })).toBeUndefined();
  });
});

describe("matchDanger", () => {
  it("flags rm -rf, sudo, system paths and secrets", () => {
    expect(matchDanger({ command: "rm -rf /" })).toBe(true);
    expect(matchDanger({ command: "sudo reboot" })).toBe(true);
    expect(matchDanger({ path: "/etc/shadow" })).toBe(true);
    expect(matchDanger({ file: "/home/u/.ssh/id_rsa" })).toBe(true);
  });
  it("ignores benign args", () => {
    expect(matchDanger({ query: "hello world" })).toBe(false);
  });
});

describe("summarize", () => {
  it("truncates long args with an ellipsis", () => {
    expect(summarize({ a: "x".repeat(600) }).endsWith("…")).toBe(true);
  });
  it("returns compact json for short args", () => {
    expect(summarize({ a: "short" })).toBe('{"a":"short"}');
  });
});

describe("decide", () => {
  const base: Policy = { version: 1, defaultPermission: "auto", tools: {}, audit: { enabled: true } };
  const withTool = (entry: ToolEntry): Policy => ({ ...base, tools: { mcp__s__t: entry } });

  it("passes non-mcp tools untouched (even dangerous)", () => {
    expect(decide(base, "bash", { command: "rm -rf /" }, true)).toEqual({ action: "pass" });
  });
  it("auto passes", () => {
    expect(decide(withTool({ permission: "auto" }), "mcp__s__t", { q: "ok" }, true)).toEqual({ action: "pass" });
  });
  it("unknown tool uses defaultPermission (auto)", () => {
    expect(decide(base, "mcp__s__t", { q: "ok" }, true)).toEqual({ action: "pass" });
  });
  it("disabled blocks", () => {
    expect(decide(withTool({ permission: "disabled" }), "mcp__s__t", {}, true)).toMatchObject({
      action: "block",
      code: "disabled",
    });
  });
  it("needs_approval prompts (recordable) with UI", () => {
    expect(decide(withTool({ permission: "needs_approval" }), "mcp__s__t", {}, true)).toMatchObject({
      action: "prompt",
      recordable: true,
    });
  });
  it("needs_approval blocks when headless", () => {
    expect(decide(withTool({ permission: "needs_approval" }), "mcp__s__t", {}, false)).toMatchObject({
      action: "block",
      code: "headless",
    });
  });
  it("required rule prompts but is not recordable", () => {
    const p = withTool({ permission: "auto", rules: [{ match: { p: "x" }, policy: "required" }] });
    expect(decide(p, "mcp__s__t", { p: "x" }, true)).toMatchObject({ action: "prompt", recordable: false });
  });
  it("never rule passes and exempts danger", () => {
    const p = withTool({ permission: "needs_approval", rules: [{ policy: "never" }] });
    expect(decide(p, "mcp__s__t", { command: "rm -rf /" }, true)).toEqual({ action: "pass" });
  });
  it("danger upgrades auto to prompt, not recordable", () => {
    expect(decide(withTool({ permission: "auto" }), "mcp__s__t", { command: "rm -rf /" }, true)).toMatchObject({
      action: "prompt",
      recordable: false,
    });
  });
  it("danger under headless blocks", () => {
    expect(decide(withTool({ permission: "auto" }), "mcp__s__t", { command: "sudo x" }, false)).toMatchObject({
      action: "block",
      code: "headless",
    });
  });
});
