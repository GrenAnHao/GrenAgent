import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInWorkspace } from "../_shared/workspace-context.js";
import { profileToEnv, resolveProfile } from "./capability.js";
import {
  buildSubagentLaunch,
  buildSubagentRuntimeConfig,
  buildSubagentSkillArgs,
  extractFinalText,
  isAgentEndLine,
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

describe("buildSubagentLaunch", () => {
  beforeEach(() => {
    process.env.PI_WORKER_ENTRY = "C:/app/out/main/pi-worker.js";
  });

  it("command 是 process.execPath，args[0] 是 worker，task 末位，--skill 在 --mode 前", () => {
    const launch = buildSubagentLaunch("D:/proj", "do the work", {});
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toBe("C:/app/out/main/pi-worker.js");
    expect(launch.args[launch.args.length - 1]).toBe("do the work");
    const mode = launch.args.indexOf("--mode");
    expect(launch.args[mode + 1]).toBe("json");
    const skill = launch.args.indexOf("--skill");
    if (skill >= 0) expect(skill).toBeLessThan(mode);
    expect(launch.args.join(" ")).not.toMatch(/pi\.exe/);
    launch.cleanup();
  });

  it("env 顺序：ALS config 进入，PI_IS_SUBAGENT 末位不可覆盖，含 ELECTRON_RUN_AS_NODE 与 NODE_NO_WARNINGS", () => {
    const launch = runInWorkspace(
      {
        origin: "main",
        workspace: "D:/a",
        cwd: "D:/a",
        config: { AGENT_DATA_ENDPOINT: "token-a", PI_IS_SUBAGENT: "0" },
      },
      () => buildSubagentLaunch("D:/a", "t", { env: { PI_IS_SUBAGENT: "0" } }),
    );
    expect(launch.env.AGENT_DATA_ENDPOINT).toBe("token-a");
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(launch.env.NODE_NO_WARNINGS).toBe("1");
    expect(launch.env.PI_IS_SUBAGENT).toBe("1");
    launch.cleanup();
  });

  it("stdio 为 ignore/pipe/pipe，无 windowsHide；POSIX 设 detached", () => {
    const launch = buildSubagentLaunch("D:/a", "t", {});
    expect(launch.spawnOptions.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(launch.spawnOptions).not.toHaveProperty("windowsHide");
    if (process.platform !== "win32") expect(launch.spawnOptions.detached).toBe(true);
    launch.cleanup();
  });

  it("deny 列表：深度未到顶时只含 explore_context，不含 spawn_agent", () => {
    const launch = buildSubagentLaunch("D:/a", "t", { env: { SUBAGENT_DEPTH: "1" } });
    const deny = (launch.env.SAFETY_DENY_TOOLS ?? "").split(",");
    expect(deny).toContain("explore_context");
    expect(deny).not.toContain("spawn_agent");
    launch.cleanup();
  });

  it("deny 列表：深度到顶时含 spawn_agent", () => {
    const launch = buildSubagentLaunch("D:/a", "t", { env: { SUBAGENT_DEPTH: "2" } });
    expect((launch.env.SAFETY_DENY_TOOLS ?? "").split(",")).toContain("spawn_agent");
    launch.cleanup();
  });

  it("thinkingLevel → --thinking，位置在 --mode 之前", () => {
    const launch = buildSubagentLaunch("D:/a", "t", { thinkingLevel: "high" });
    const i = launch.args.indexOf("--thinking");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(launch.args[i + 1]).toBe("high");
    expect(i).toBeLessThan(launch.args.indexOf("--mode"));
    launch.cleanup();
  });

  it("未给 thinkingLevel 则不传 --thinking", () => {
    const launch = buildSubagentLaunch("D:/a", "t", {});
    expect(launch.args).not.toContain("--thinking");
    launch.cleanup();
  });

  it("outputSchema is rejected on the subprocess path", () => {
    expect(() => buildSubagentLaunch("D:/a", "t", { outputSchema: { type: "object" } as never })).toThrow("outputSchema 需要 Electron 进程内子会话");
  });
});

describe("buildSubagentSkillArgs", () => {
  it("adds TencentDB skills without disabling native discovery", () => {
    expect(buildSubagentSkillArgs("C:/managed/skills")).toEqual([
      "--skill",
      "C:/managed/skills",
    ]);
  });

  it("does not add skill flags when no managed root is configured", () => {
    expect(buildSubagentSkillArgs(undefined)).toEqual([]);
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

  it("executor: worktree-isolated workspace write, still cannot spawn", () => {
    delete process.env.PI_RUNTIME_CONFIG;
    const p = resolveProfile("executor");
    const rc = buildSubagentRuntimeConfig(p.mcp, { ...profileToEnv(p), SUBAGENT_DEPTH: "2" });
    // executor.fs=workspace → 不只读；但 net=false → 禁联网，且永不可再 spawn
    expect(rc.env.SAFETY_READONLY).toBeUndefined();
    const deny = denyOf(rc);
    expect(deny).toContain("web_search");
    expect(deny).toContain("spawn_agent");
    rc.cleanup();
  });
});

describe("extractFinalText", () => {
  it("returns the last assistant text from JSONL", () => {
    const jsonl = [
      JSON.stringify({ role: "assistant", content: "first" }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } }),
    ].join("\n");
    expect(extractFinalText(jsonl)).toBe("final answer");
  });
  it("accumulates json-mode text_delta when message_end content is empty", () => {
    const jsonl = [
      JSON.stringify({ type: "session", version: 3, id: "sess" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "RESULT:" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "c=5" } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [] } }),
      JSON.stringify({ type: "agent_end" }),
    ].join("\n");
    expect(extractFinalText(jsonl)).toBe("RESULT:c=5");
  });
  it("does not treat a session header as assistant output", () => {
    expect(extractFinalText(JSON.stringify({ type: "session", version: 3, id: "x", cwd: "/ws" }))).toBe("");
    expect(extractFinalText("not json at all")).toBe("");
  });
});

// 完成检测核心：逐行解析判定 agent_end，取代旧的「对整段 buffer 跑 /agent_end/ 正则」。
// 关键回归点是「文本里出现 agent_end 字样不能被误判为完成」——旧正则会，导致子代理被提前 kill。
describe("isAgentEndLine", () => {
  it("returns true for a real agent_end event line", () => {
    expect(isAgentEndLine(JSON.stringify({ type: "agent_end", messages: [] }))).toBe(true);
  });
  it("ignores surrounding whitespace", () => {
    expect(isAgentEndLine(`  ${JSON.stringify({ type: "agent_end" })}  `)).toBe(true);
  });
  it("does NOT match when 'agent_end' only appears inside text content (old regex false positive)", () => {
    const line = JSON.stringify({ type: "message_update", text: "I will emit an agent_end event soon" });
    expect(isAgentEndLine(line)).toBe(false);
  });
  it("returns false for other event types, blank, and malformed lines", () => {
    expect(isAgentEndLine(JSON.stringify({ type: "agent_start" }))).toBe(false);
    expect(isAgentEndLine("")).toBe(false);
    expect(isAgentEndLine("   ")).toBe(false);
    expect(isAgentEndLine("not json at all")).toBe(false);
    expect(isAgentEndLine('{"type":')).toBe(false);
  });
});
