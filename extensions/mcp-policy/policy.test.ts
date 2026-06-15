import { describe, expect, it } from "vitest";
import { globMatch, matchRules, parsePolicy, type Rule } from "./policy.js";

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
