import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInWorkspace } from "../_shared/workspace-context.js";
import { profileToEnv, resolveProfile } from "./capability.js";
import {
  buildSubagentRuntimeConfig,
  inheritedFsLimits,
  parentModelSpec,
  resolvePiCommand,
  resolveSubagentModel,
} from "./runner.js";

const origPiBin = process.env.PI_BIN;
const origWorkerEntry = process.env.PI_WORKER_ENTRY;
const origSubagentModel = process.env.SUBAGENT_MODEL;
const origSubagentMode = process.env.SUBAGENT_MODE;
const origRuntimeConfig = process.env.PI_RUNTIME_CONFIG;
beforeEach(() => {
  process.env.PI_WORKER_ENTRY = origWorkerEntry ?? "C:/app/out/main/pi-worker.js";
});
afterEach(() => {
  if (origPiBin === undefined) delete process.env.PI_BIN;
  else process.env.PI_BIN = origPiBin;
  if (origWorkerEntry === undefined) delete process.env.PI_WORKER_ENTRY;
  else process.env.PI_WORKER_ENTRY = origWorkerEntry;
  if (origSubagentModel === undefined) delete process.env.SUBAGENT_MODEL;
  else process.env.SUBAGENT_MODEL = origSubagentModel;
  if (origSubagentMode === undefined) delete process.env.SUBAGENT_MODE;
  else process.env.SUBAGENT_MODE = origSubagentMode;
  if (origRuntimeConfig === undefined) delete process.env.PI_RUNTIME_CONFIG;
  else process.env.PI_RUNTIME_CONFIG = origRuntimeConfig;
});

describe("resolvePiCommand", () => {
  it("reads PI_WORKER_ENTRY from process.env, not getConfig", () => {
    process.env.PI_WORKER_ENTRY = "C:/app/out/main/pi-worker.js";
    expect(resolvePiCommand()).toEqual({
      cmd: process.execPath,
      baseArgs: ["C:/app/out/main/pi-worker.js"],
    });
  });

  it("throws when PI_WORKER_ENTRY is missing", () => {
    delete process.env.PI_WORKER_ENTRY;
    expect(() => resolvePiCommand()).toThrow(/PI_WORKER_ENTRY/);
  });

  it("ignores PI_BIN (deleted override)", () => {
    process.env.PI_BIN = "/custom/pi";
    process.env.PI_WORKER_ENTRY = "C:/app/pi-worker.js";
    expect(resolvePiCommand().cmd).toBe(process.execPath);
    expect(resolvePiCommand().baseArgs).toEqual(["C:/app/pi-worker.js"]);
  });
});

describe("resolveSubagentModel", () => {
  it("returns trimmed SUBAGENT_MODEL when set", () => {
    process.env.SUBAGENT_MODEL = "  deepseek/deepseek-chat  ";
    expect(resolveSubagentModel()).toBe("deepseek/deepseek-chat");
  });
  it("returns undefined when unset or blank", () => {
    delete process.env.SUBAGENT_MODEL;
    expect(resolveSubagentModel()).toBeUndefined();
    process.env.SUBAGENT_MODEL = "   ";
    expect(resolveSubagentModel()).toBeUndefined();
  });
  it("inherit mode ignores SUBAGENT_MODEL so the caller can pass the parent model", () => {
    process.env.SUBAGENT_MODE = "inherit";
    process.env.SUBAGENT_MODEL = "other/model";
    expect(resolveSubagentModel()).toBeUndefined();
  });
});

describe("parentModelSpec", () => {
  it("joins provider/id", () => {
    expect(parentModelSpec({ provider: "custom-mtwuh2s5", id: "deepseek-flash" })).toBe(
      "custom-mtwuh2s5/deepseek-flash",
    );
  });
  it("returns undefined when either side is missing", () => {
    expect(parentModelSpec({ provider: "x" })).toBeUndefined();
    expect(parentModelSpec({ id: "y" })).toBeUndefined();
    expect(parentModelSpec(undefined)).toBeUndefined();
  });
});

describe("buildSubagentRuntimeConfig", () => {
  it("does not deny spawn_agent when SUBAGENT_DEPTH is unset (below max)", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const rc = buildSubagentRuntimeConfig(false, {});
    expect(rc.env.SAFETY_DENY_TOOLS.split(",")).not.toContain("spawn_agent");
    rc.cleanup();
  });

  it("denies spawn_agent when SUBAGENT_DEPTH reaches the max", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const rc = buildSubagentRuntimeConfig(false, { SUBAGENT_DEPTH: "2" });
    expect(rc.env.SAFETY_DENY_TOOLS.split(",")).toContain("spawn_agent");
    rc.cleanup();
  });

  it("merges spawn_agent with a profile's existing deny list (no loss)", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const rc = buildSubagentRuntimeConfig(false, { SAFETY_DENY_TOOLS: "web_search,web_fetch", SUBAGENT_DEPTH: "2" });
    const deny = rc.env.SAFETY_DENY_TOOLS.split(",");
    expect(deny).toContain("spawn_agent");
    expect(deny).toContain("web_search");
    expect(deny).toContain("web_fetch");
    rc.cleanup();
  });

  it("also denies explore_context so a sub-agent can't trigger nested exploration", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const rc = buildSubagentRuntimeConfig(false, {});
    expect(rc.env.SAFETY_DENY_TOOLS.split(",")).toContain("explore_context");
    rc.cleanup();
  });

  it("preserves profile-provided deny entries alongside the guards", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const rc = buildSubagentRuntimeConfig(false, { SAFETY_DENY_TOOLS: "bash" });
    const deny = rc.env.SAFETY_DENY_TOOLS.split(",");
    expect(deny).toContain("bash");
    expect(deny).toContain("explore_context");
    rc.cleanup();
  });

  it("does not copy TencentDB credentials into a derived sub-agent config", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-secret-test-"));
    const source = join(dir, "runtime-settings.json");
    writeFileSync(source, JSON.stringify({
      SOME_KEY: "visible",
      TDAI_MEMORY_API_KEY: "gateway-secret",
      TDAI_MEMORY_USER_KEY: "user-secret",
    }));
    process.env.PI_RUNTIME_CONFIG = source;

    const rc = buildSubagentRuntimeConfig(false, {});
    try {
      expect(rc.path).toBeDefined();
      const derived = JSON.parse(readFileSync(rc.path!, "utf8")) as Record<string, string>;
      expect(derived.SOME_KEY).toBe("visible");
      expect(derived).not.toHaveProperty("TDAI_MEMORY_API_KEY");
      expect(derived).not.toHaveProperty("TDAI_MEMORY_USER_KEY");
    } finally {
      rc.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not pass TencentDB credentials supplied as child overrides", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const rc = buildSubagentRuntimeConfig(false, {
      SOME_KEY: "visible",
      TDAI_MEMORY_API_KEY: "gateway-secret",
      TDAI_MEMORY_USER_KEY: "user-secret",
    });

    expect(rc.env.SOME_KEY).toBe("visible");
    expect(rc.env).not.toHaveProperty("TDAI_MEMORY_API_KEY");
    expect(rc.env).not.toHaveProperty("TDAI_MEMORY_USER_KEY");
    rc.cleanup();
  });
});

// 端到端契约：从 preset 名 → profileToEnv → buildSubagentRuntimeConfig，断言「父进程实际下发给
// 子代理的限制」。这是子代理安全模型可确定性验证的一半（另一半是 pi 二进制是否在子代理加载并
// 强制 SAFETY_*，那需运行时集成测试）。
describe("preset → injected sub-agent restrictions (end-to-end contract)", () => {
  const denyOf = (rc: { env: Record<string, string> }) => (rc.env.SAFETY_DENY_TOOLS ?? "").split(",");

  it("explore: readonly + denies bypass-writers/code-exec/spawn + no MCP", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const p = resolveProfile("explore");
    const rc = buildSubagentRuntimeConfig(p.mcp, { ...profileToEnv(p), SUBAGENT_DEPTH: "2" });
    expect(rc.env.SAFETY_READONLY).toBe("1");
    const deny = denyOf(rc);
    for (const t of [
      "ast_edit",
      "hl_edit",
      "py_run",
      "js_run",
      "dap_launch",
      "dap_evaluate",
      "spawn_agent",
      "explore_context",
    ]) {
      expect(deny).toContain(t);
    }
    expect(rc.env.MCP_SERVERS).toBe(""); // explore.mcp=false → 无 MCP
    rc.cleanup();
  });

  it("reviewer: readonly + net off (denies net tools) + cannot spawn", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const p = resolveProfile("reviewer");
    const rc = buildSubagentRuntimeConfig(p.mcp, { ...profileToEnv(p), SUBAGENT_DEPTH: "2" });
    expect(rc.env.SAFETY_READONLY).toBe("1");
    const deny = denyOf(rc);
    expect(deny).toContain("web_search"); // net=false
    expect(deny).toContain("fetch_url");
    expect(deny).toContain("spawn_agent");
    rc.cleanup();
  });

  it("planner: writeAllow plans/docs but still denies bypass writers", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const p = resolveProfile("planner");
    const env = profileToEnv(p);
    expect(env.SAFETY_READONLY).toBe("1");
    expect(env.SAFETY_WRITE_ALLOW).toBe("plans/,docs/");
    const rc = buildSubagentRuntimeConfig(p.mcp, env);
    expect(denyOf(rc)).toContain("py_run");
    rc.cleanup();
  });

  it("default: workspace write (no readonly) yet still cannot spawn sub-agents", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const p = resolveProfile(undefined);
    const rc = buildSubagentRuntimeConfig(p.mcp, { ...profileToEnv(p), SUBAGENT_DEPTH: "2" });
    expect(rc.env.SAFETY_READONLY).toBeUndefined();
    const deny = denyOf(rc);
    expect(deny).toContain("spawn_agent");
    expect(deny).toContain("explore_context");
    rc.cleanup();
  });

  it("workspace write without net: not readonly, net tools denied, cannot spawn at max depth", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const p = resolveProfile({ net: false });
    const rc = buildSubagentRuntimeConfig(p.mcp, { ...profileToEnv(p), SUBAGENT_DEPTH: "2" });
    // fs=workspace → 不只读；但 net=false → 禁联网，且到最大深度不可再 spawn
    expect(rc.env.SAFETY_READONLY).toBeUndefined();
    const deny = denyOf(rc);
    expect(deny).toContain("web_search");
    expect(deny).toContain("spawn_agent");
    rc.cleanup();
  });
});

describe("parent restrictions flow into the sub-agent config (safety no longer reads process.env first)", () => {
  const inParent = <T>(config: Record<string, string>, fn: () => T): T =>
    runInWorkspace({ origin: "main", workspace: "D:/a", cwd: "D:/a", config }, fn);

  it("a read-only parent makes the child read-only even with a writable profile", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const rc = inParent({ SAFETY_READONLY: "1" }, () => buildSubagentRuntimeConfig(false, profileToEnv(resolveProfile("default"))));
    expect(rc.env.SAFETY_READONLY).toBe("1");
    rc.cleanup();
  });

  it("the parent deny list is unioned into the child deny list", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const rc = inParent({ SAFETY_DENY_TOOLS: "fetch_url" }, () => buildSubagentRuntimeConfig(false, { SAFETY_DENY_TOOLS: "bash" }));
    expect(rc.env.SAFETY_DENY_TOOLS?.split(",")).toEqual(expect.arrayContaining(["bash", "fetch_url"]));
    rc.cleanup();
  });

  it("the write allow-list can only narrow to the parent allow-list", () => {
    expect(inParent({ SAFETY_WRITE_ALLOW: "docs/" }, () => inheritedFsLimits({}))).toEqual({ SAFETY_WRITE_ALLOW: "docs/" });
    expect(inParent({ SAFETY_WRITE_ALLOW: "docs/" }, () => inheritedFsLimits({ SAFETY_WRITE_ALLOW: "docs/api/,src/" }))).toEqual({
      SAFETY_WRITE_ALLOW: "docs/api/",
    });
    expect(inParent({}, () => inheritedFsLimits({ SAFETY_WRITE_ALLOW: "src/" }))).toEqual({});
  });
});
