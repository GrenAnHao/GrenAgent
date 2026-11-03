import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runInWorkspace } from "../_shared/workspace-context.js";
import {
  activeToolsFor,
  AGENT_MODES,
  agentModeConfigKey,
  type AgentMode,
  gateToolCall,
  getAgentMode,
  hasAgentMode,
  isAgentMode,
  modeBadge,
  modeLabel,
  parseModeArg,
  setAgentMode,
  toolWhitelist,
  __resetAgentModeForTest,
} from "./modes.js";

beforeEach(() => __resetAgentModeForTest());

describe("isAgentMode / parseModeArg", () => {
  it("recognizes only the five current modes", () => {
    expect(AGENT_MODES).toEqual(["agent", "ask", "debug", "plan", "ultra"]);
    for (const m of AGENT_MODES) {
      expect(isAgentMode(m)).toBe(true);
    }
  });
  it("rejects unknown values", () => {
    expect(isAgentMode("build")).toBe(false);
    expect(isAgentMode("")).toBe(false);
    expect(isAgentMode(undefined)).toBe(false);
  });
  it("parses mode args case-insensitively and trims", () => {
    expect(parseModeArg("  ASK ")).toBe("ask");
    expect(parseModeArg("Debug")).toBe("debug");
    expect(parseModeArg("")).toBeUndefined();
    expect(parseModeArg("nope")).toBeUndefined();
  });
});

describe("agentModeConfigKey", () => {
  it("normalizes workspace path like approval keys", () => {
    expect(agentModeConfigKey("D:/Proj-A/")).toBe("AGENT_MODE:d:/proj-a");
    expect(agentModeConfigKey("D:\\Proj-A")).toBe("AGENT_MODE:d:/proj-a");
  });
});

describe("toolWhitelist / activeToolsFor", () => {
  it("restricts ask and plan, leaves agent/debug unrestricted", () => {
    expect(toolWhitelist("ask")).toBeDefined();
    expect(toolWhitelist("plan")).toBeDefined();
    expect(toolWhitelist("agent")).toBeUndefined();
    expect(toolWhitelist("debug")).toBeUndefined();
  });

  it("intersects the whitelist with the available tools for ask", () => {
    const all = ["read", "write", "edit", "bash", "grep", "mcp__server__do"];
    const active = activeToolsFor("ask", all);
    expect(active).toContain("read");
    expect(active).toContain("grep");
    expect(active).not.toContain("write");
    expect(active).not.toContain("edit");
    expect(active).toContain("bash");
    expect(active).not.toContain("mcp__server__do");
  });

  it("keeps bash for plan but never write/edit", () => {
    const all = ["read", "write", "edit", "bash", "grep"];
    const active = activeToolsFor("plan", all);
    expect(active).toContain("bash");
    expect(active).toContain("read");
    expect(active).not.toContain("write");
    expect(active).not.toContain("edit");
  });

  it("returns undefined (full tools) for agent and debug", () => {
    const all = ["read", "write", "edit", "bash"];
    expect(activeToolsFor("agent", all)).toBeUndefined();
    expect(activeToolsFor("debug", all)).toBeUndefined();
  });

  it("falls back to the whitelist when intersection is empty", () => {
    const active = activeToolsFor("ask", ["some-unrelated-tool"]);
    expect(active).toEqual([...(toolWhitelist("ask") ?? [])]);
  });
});

describe("gateToolCall", () => {
  it("ask blocks writes, exec, subagents and MCP", () => {
    for (const t of [
      "write",
      "edit",
      "kb_add",
      "review_note",
      "todo",
      "generate_image",
      "speak",
      "spawn_agent",
      "explore_context",
      "diagnostics",
      "mcp__server__do",
    ]) {
      expect(gateToolCall("ask", t, {})?.block).toBe(true);
    }
  });
  it("ask allows bash and leaves writes blocked", () => {
    expect(gateToolCall("ask", "bash", { command: "ls" })).toBeUndefined();
    // 升权并进了 bash：ask 照旧放行，由 bash 自己的审批把关；bash_escalate 已删除，不在白名单里。
    expect(
      gateToolCall("ask", "bash", { command: "touch a.txt", sandbox_permissions: "workspace-write", justification: "需要写入" }),
    ).toBeUndefined();
    expect(gateToolCall("ask", "bash_escalate", {})?.block).toBe(true);
    expect(gateToolCall("ask", "write", { path: "a" })?.block).toBe(true);
    expect(gateToolCall("ask", "write", { path: "a" })?.reason).toContain(
      "不能修改文件或调用 MCP；命令行由只读 OS 沙箱执行",
    );
  });

  it("plan checks every bash command for safety, escalation or not", () => {
    const pair = { sandbox_permissions: "workspace-write", justification: "需要写入" };
    expect(gateToolCall("plan", "bash", { command: "git status", ...pair })).toBeUndefined();
    expect(gateToolCall("plan", "bash", { command: "touch a.txt", ...pair })?.block).toBe(true);
  });

  it("ask allows read-only retrieval and web lookup", () => {
    for (const t of [
      "read",
      "grep",
      "find",
      "ls",
      "fetch_url",
      "web_search",
      "anysearch_search",
      "anysearch_sub_domains",
      "search",
      "git_diff",
      "code_explore",
      "present",
    ]) {
      expect(gateToolCall("ask", t, {})).toBeUndefined();
    }
    expect(gateToolCall("ask", "code_search", {})?.block).toBe(true);
    expect(gateToolCall("plan", "present", {})).toBeUndefined();
  });

  it("plan blocks write/edit and mutating bash, allows read-only bash", () => {
    expect(gateToolCall("plan", "write", { path: "a" })?.block).toBe(true);
    expect(gateToolCall("plan", "edit", { path: "a" })?.block).toBe(true);
    expect(gateToolCall("plan", "bash", { command: "rm -rf x" })?.block).toBe(true);
    expect(gateToolCall("plan", "bash", { command: "git status" })).toBeUndefined();
    expect(gateToolCall("plan", "read", { path: "a" })).toBeUndefined();
  });

  it("plan blocks new execution tools (py_run/hl_edit/dap_*) but allows read-only ones", () => {
    expect(gateToolCall("plan", "py_run", { code: "x" })?.block).toBe(true);
    expect(gateToolCall("plan", "hl_edit", { patch: "x" })?.block).toBe(true);
    expect(gateToolCall("plan", "dap_launch", { program: "x" })?.block).toBe(true);
    expect(gateToolCall("plan", "hl_read", { path: "a" })).toBeUndefined();
    expect(gateToolCall("plan", "lsp_definition", { path: "a" })).toBeUndefined();
  });

  it("agent and debug never block", () => {
    for (const mode of ["agent", "debug"] as AgentMode[]) {
      expect(gateToolCall(mode, "write", { path: "a" })).toBeUndefined();
      expect(gateToolCall(mode, "bash", { command: "rm -rf x" })).toBeUndefined();
      expect(gateToolCall(mode, "mcp__server__do", {})).toBeUndefined();
    }
  });
});

describe("modeBadge / modeLabel", () => {
  it("hides the badge for the default agent mode only", () => {
    expect(modeBadge("agent")).toBeUndefined();
    expect(modeBadge("ask")).toBe("Ask");
    expect(modeBadge("debug")).toBe("Debug");
    expect(modeBadge("plan")).toBe("Plan");
  });
  it("provides a human label for every mode", () => {
    expect(modeLabel("agent")).toBeTruthy();
    expect(modeLabel("ask")).toBeTruthy();
    expect(modeLabel("debug")).toBeTruthy();
    expect(modeLabel("plan")).toBeTruthy();
  });
});

describe("removed brainstorm mode", () => {
  it("rejects brainstorm as a current mode", () => {
    expect(isAgentMode("brainstorm")).toBe(false);
  });

  it("rejects brainstorm in new mode commands", () => {
    expect(parseModeArg("brainstorm")).toBeUndefined();
    expect(parseModeArg(" BRAINSTORM ")).toBeUndefined();
  });
});

describe("agent mode live 表", () => {
  it("未写入时 get 回退 agent，has 为 false", () => {
    expect(hasAgentMode("D:/a")).toBe(false);
    expect(getAgentMode("D:/a")).toBe("agent");
  });

  it("set 之后立刻 get 为新值，随后改盘也盖不过", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-mode-live-"));
    const runtime = join(directory, "runtime-settings.json");
    process.env.PI_RUNTIME_CONFIG = runtime;
    setAgentMode("ask", "D:/a");
    await writeFile(runtime, JSON.stringify({ [agentModeConfigKey("D:/a")]: "plan" }));
    expect(getAgentMode("D:/a")).toBe("ask");
    expect(getAgentMode("D:/b")).toBe("agent");
    expect(hasAgentMode("D:/a")).toBe(true);
    delete process.env.PI_RUNTIME_CONFIG;
  });

  it("无参时读 ALS cwd", async () => {
    setAgentMode("plan", "D:/a");
    setAgentMode("debug", "D:/b");
    await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: {} },
      async () => {
        expect(getAgentMode()).toBe("plan");
      },
    );
  });

  it("显式写成 agent 之后 has 为 true", () => {
    setAgentMode("agent", "D:/a");
    expect(hasAgentMode("D:/a")).toBe(true);
    expect(getAgentMode("D:/a")).toBe("agent");
  });
});

describe("getAgentMode 按会话", () => {
  it("会话模式互不影响，未写过的会话回退项目默认", () => {
    setAgentMode("agent", "D:/a");
    setAgentMode("plan", "D:/a", "s1");
    setAgentMode("ask", "D:/a", "s2");
    expect(getAgentMode("D:/a", "s1")).toBe("plan");
    expect(getAgentMode("D:/a", "s2")).toBe("ask");
    expect(getAgentMode("D:/a", "s3")).toBe("agent");
    setAgentMode("debug", "D:/a");
    expect(getAgentMode("D:/a", "s1")).toBe("plan");
    expect(getAgentMode("D:/a", "s3")).toBe("debug");
  });
});

describe("ultra mode", () => {
  it("isAgentMode / parseModeArg recognize ultra", () => {
    expect(isAgentMode("ultra")).toBe(true);
    expect(parseModeArg(" ultra ")).toBe("ultra");
    expect(parseModeArg("ULTRA")).toBe("ultra");
  });

  it("uses the full toolset like agent", () => {
    expect(toolWhitelist("ultra")).toBeUndefined();
    const all = ["read", "grep", "write", "edit", "bash", "spawn_agent", "mcp__server__do"];
    expect(activeToolsFor("ultra", all)).toBeUndefined();
    for (const tool of all) expect(gateToolCall("ultra", tool, { command: "rm -rf x" })).toBeUndefined();
  });

  it("still blocks plan-only tools for ultra", () => {
    expect(gateToolCall("ultra", "upsert_plan", {})?.block).toBe(true);
  });

  it("has an Ultra badge and label", () => {
    expect(modeBadge("ultra")).toBe("Ultra");
    expect(modeLabel("ultra")).toBeTruthy();
  });

  it("is mutually exclusive with ask/plan by being one mode value", () => {
    setAgentMode("ultra", "D:/a", "s1");
    expect(getAgentMode("D:/a", "s1")).toBe("ultra");
    setAgentMode("ask", "D:/a", "s1");
    expect(getAgentMode("D:/a", "s1")).toBe("ask");
    expect(getAgentMode("D:/a", "s1")).not.toBe("ultra");
  });
});
