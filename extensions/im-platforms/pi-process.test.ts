import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInWorkspace } from "../_shared/workspace-context.js";
import { buildSubagentLaunch, buildSubagentSkillArgs, extractFinalText, isAgentEndLine } from "./pi-process.js";

// 从 multi-agent/runner.test.ts 搬来：打印模式子进程只剩 im-platforms 在用。
const origWorkerEntry = process.env.PI_WORKER_ENTRY;
const origRuntimeConfig = process.env.PI_RUNTIME_CONFIG;
beforeEach(() => {
  process.env.PI_WORKER_ENTRY = origWorkerEntry ?? "C:/app/out/main/pi-worker.js";
});
afterEach(() => {
  if (origWorkerEntry === undefined) delete process.env.PI_WORKER_ENTRY;
  else process.env.PI_WORKER_ENTRY = origWorkerEntry;
  if (origRuntimeConfig === undefined) delete process.env.PI_RUNTIME_CONFIG;
  else process.env.PI_RUNTIME_CONFIG = origRuntimeConfig;
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

