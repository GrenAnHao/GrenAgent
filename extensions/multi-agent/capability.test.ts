import { describe, expect, it } from "vitest";
import { PRESETS, resolveProfile, profileToModel, profileToEnv, profileLimits, resolveMcpServers } from "./capability.js";
import { NET_TOOLS } from "../_shared/tool-groups.js";

describe("resolveProfile", () => {
  it("undefined → default preset", () => {
    expect(resolveProfile(undefined).fs).toBe("workspace");
  });
  it("preset name → that preset", () => {
    expect(resolveProfile("explore").fs).toBe("readonly");
    expect(resolveProfile("explore").model).toBe("cheap");
  });
  it("executor preset is gone (worktrees are an explicit tool now) and falls back to default", () => {
    expect(PRESETS.executor).toBeUndefined();
    expect(resolveProfile("executor")).toEqual(PRESETS.default);
  });
  it("unknown name → falls back to default", () => {
    expect(resolveProfile("nope").fs).toBe("workspace");
  });
  it("extends preset + inline override (additive)", () => {
    const p = resolveProfile({ extends: "explore", fs: { writeAllow: ["notes/"] } });
    expect(p.fs).toEqual({ writeAllow: ["notes/"] }); // overridden
    expect(p.net).toBe(true); // inherited from explore
    expect(p.model).toBe("cheap"); // inherited from explore
  });
  it("pure inline merges onto default base", () => {
    const p = resolveProfile({ fs: "readonly", net: false });
    expect(p.fs).toBe("readonly");
    expect(p.net).toBe(false);
    expect(p.spawn).toBe(false); // from default base
  });
  it("inline tools deny is carried through", () => {
    expect(resolveProfile({ tools: { deny: ["bash"] } }).tools).toEqual({ deny: ["bash"] });
  });
  it("no preset carries the removed isolation field", () => {
    for (const name of Object.keys(PRESETS)) {
      expect(PRESETS[name]).not.toHaveProperty("isolation");
    }
  });
});

describe("profileToModel", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  it("cheap → SUBAGENT_MODEL_CHEAP", () => {
    expect(profileToModel({ model: "cheap" }, env({ SUBAGENT_MODEL_CHEAP: "deepseek/deepseek-chat" }))).toBe(
      "deepseek/deepseek-chat",
    );
  });
  it("cheap falls back to SUBAGENT_MODEL when no _CHEAP", () => {
    expect(profileToModel({ model: "cheap" }, env({ SUBAGENT_MODEL: "foo/bar" }))).toBe("foo/bar");
  });
  it("strong → SUBAGENT_MODEL_STRONG", () => {
    expect(profileToModel({ model: "strong" }, env({ SUBAGENT_MODEL_STRONG: "openai/o3" }))).toBe("openai/o3");
  });
  it("literal provider/id passes through", () => {
    expect(profileToModel({ model: "openai/gpt-4o" }, env({}))).toBe("openai/gpt-4o");
  });
  it("no model → undefined", () => {
    expect(profileToModel({}, env({}))).toBeUndefined();
  });
  it("inherit mode ignores leftover cheap/strong routes", () => {
    const get = env({
      SUBAGENT_MODE: "inherit",
      SUBAGENT_MODEL_CHEAP: "opencode-go/deepseek-v4-flash",
      SUBAGENT_MODEL_STRONG: "opencode-go/glm-5.3",
      SUBAGENT_MODEL: "opencode-go/deepseek-v4-pro",
    });
    expect(profileToModel({ model: "cheap" }, get)).toBeUndefined();
    expect(profileToModel({ model: "strong" }, get)).toBeUndefined();
    expect(profileToModel({ model: "deepseek/deepseek-flash" }, get)).toBe("deepseek/deepseek-flash");
  });
});

describe("profileToEnv", () => {
  it("fs=readonly → SAFETY_READONLY + empty allowlist", () => {
    const e = profileToEnv({ fs: "readonly" });
    expect(e.SAFETY_READONLY).toBe("1");
    expect(e.SAFETY_WRITE_ALLOW).toBe("");
  });
  it("does not set MCP_SERVERS (the runner resolves it from the parent config)", () => {
    expect(profileToEnv({ mcp: ["github"] }).MCP_SERVERS).toBeUndefined();
    expect(profileToEnv({ mcp: true }).MCP_SERVERS).toBeUndefined();
  });
  it("fs writeAllow → readonly + joined prefixes", () => {
    const e = profileToEnv({ fs: { writeAllow: ["plans/", "docs/"] } });
    expect(e.SAFETY_READONLY).toBe("1");
    expect(e.SAFETY_WRITE_ALLOW).toBe("plans/,docs/");
  });
  it("fs=workspace → no SAFETY_READONLY", () => {
    expect(profileToEnv({ fs: "workspace" }).SAFETY_READONLY).toBeUndefined();
  });
  it("net=false → deny all real networking tools", () => {
    // Assert against NET_TOOLS (the single source of truth) so adding a networking
    // tool there doesn't silently drift this expectation.
    expect(profileToEnv({ net: false }).SAFETY_DENY_TOOLS).toBe(NET_TOOLS.join(","));
  });
  it("tools.deny merges into deny list", () => {
    expect(profileToEnv({ net: false, tools: { deny: ["bash"] } }).SAFETY_DENY_TOOLS).toBe(
      [...NET_TOOLS, "bash"].join(","),
    );
  });
  it("restricted fs denies bypass writers + code-exec tools", () => {
    const ro = (profileToEnv({ fs: "readonly" }).SAFETY_DENY_TOOLS ?? "").split(",");
    for (const t of ["ast_edit", "hl_edit", "py_run", "js_run", "dap_launch", "dap_evaluate"]) {
      expect(ro).toContain(t);
    }
    // writeAllow（仅允许某些前缀）同样视为受限 fs，照样禁绕过工具。
    expect((profileToEnv({ fs: { writeAllow: ["docs/"] } }).SAFETY_DENY_TOOLS ?? "").split(",")).toContain("py_run");
  });
  it("fs=workspace does NOT deny code-exec (executor keeps py_run/ast_edit)", () => {
    expect(profileToEnv({ fs: "workspace" }).SAFETY_DENY_TOOLS).toBeUndefined();
  });
});

describe("profileLimits", () => {
  it("extracts positive timeoutMs and maxConcurrency", () => {
    expect(profileLimits({ limits: { timeoutMs: 5000, maxConcurrency: 2 } })).toEqual({
      timeoutMs: 5000,
      maxConcurrency: 2,
    });
  });
  it("drops non-positive or missing values", () => {
    expect(profileLimits({ limits: { timeoutMs: 0, maxConcurrency: 0 } })).toEqual({});
    expect(profileLimits({})).toEqual({});
  });
  it("floors fractional values", () => {
    expect(profileLimits({ limits: { timeoutMs: 1500.7, maxConcurrency: 3.9 } })).toEqual({
      timeoutMs: 1500,
      maxConcurrency: 3,
    });
  });
});

describe("resolveMcpServers", () => {
  const parent = JSON.stringify({
    mcpServers: { context7: { command: "npx" }, codegraph: { command: "codegraph" } },
  });
  it("false / undefined → no MCP (least privilege default)", () => {
    expect(resolveMcpServers(false, parent)).toBe("");
    expect(resolveMcpServers(undefined, parent)).toBe("");
  });
  it("true → inherits the parent's full set verbatim", () => {
    expect(resolveMcpServers(true, parent)).toBe(parent);
  });
  it("allowlist → parent trimmed to the named servers", () => {
    const out = JSON.parse(resolveMcpServers(["codegraph"], parent)) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(out.mcpServers)).toEqual(["codegraph"]);
  });
  it("allowlist never exceeds the parent (unknown names dropped → empty)", () => {
    expect(resolveMcpServers(["nope"], parent)).toBe("");
  });
  it("true but no parent → empty", () => {
    expect(resolveMcpServers(true, undefined)).toBe("");
    expect(resolveMcpServers(true, "")).toBe("");
  });
  it("malformed parent JSON → empty (deny, never leak)", () => {
    expect(resolveMcpServers(["x"], "not json")).toBe("");
  });
});
