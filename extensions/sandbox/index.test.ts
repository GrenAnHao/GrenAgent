import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetIsolatedWorkspaceCacheForTest, isolatedMarkerPath } from "../_shared/isolated-workspace.js";
import { setApprovalPolicy, __resetApprovalForTest } from "../_shared/approval.js";
import {
  grantEscalation,
  takeEscalationGrant,
  __resetEscalationGrantsForTest,
} from "../_shared/sandbox/escalationGrant.js";
import { setAgentMode, __resetAgentModeForTest } from "../agent-mode/modes.js";
import { __resetJobsForTest } from "../jobs/service.js";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  dispose: vi.fn(async () => {}),
  getPolicy: undefined as undefined | (() => {
    mode: string;
    workspaceRoot: string;
    sessionId?: string;
  }),
}));

vi.mock("../_shared/sandbox/operations.js", () => ({
  createSandboxedBashOperations: (deps: {
    getPolicy: () => { mode: string; workspaceRoot: string; sessionId?: string };
  }) => {
    mocks.getPolicy = deps.getPolicy;
    return { exec: mocks.exec };
  },
}));

vi.mock("../_shared/sandbox/provider.js", () => ({
  createSandboxProvider: () => ({
    confine: vi.fn(),
    dispose: mocks.dispose,
  }),
}));

import sandbox from "./index.js";

const CWD = "D:/repo";
const SESSION = "sess-1";
const COMMAND = "echo denied";
const JUSTIFY = "需要把构建产物写进工作区";
const CLEAN = { exitCode: 0, sandbox: { mode: "read-only", denied: false } };

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean };
type ExecCtx = {
  cwd: string;
  hasUI: boolean;
  ui: { select: ReturnType<typeof vi.fn> };
  sessionManager: { getSessionId: () => string };
};
type Tool = {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  execute?: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: ExecCtx) => Promise<ToolResult>;
};

function load() {
  const tools: Tool[] = [];
  const handlers: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
  sandbox({
    registerTool: (tool: Tool) => {
      tools.push(tool);
    },
    on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
      handlers[event] = handler;
    },
  } as never);
  return { tools, handlers };
}

function sessionCtx(cwd = CWD, sessionId = SESSION) {
  return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

function execCtx(overrides: Partial<ExecCtx> = {}): ExecCtx {
  return {
    cwd: CWD,
    hasUI: true,
    ui: { select: vi.fn() },
    sessionManager: { getSessionId: () => SESSION },
    ...overrides,
  };
}

async function start(handlers: ReturnType<typeof load>["handlers"], cwd = CWD, sessionId = SESSION) {
  await handlers.session_start?.({}, sessionCtx(cwd, sessionId));
}

function bash(tools: Tool[]): Tool {
  const tool = tools.find((item) => item.name === "bash");
  if (!tool?.execute) throw new Error("bash not registered");
  return tool;
}

/** 带升权参数调一次 bash（和模型的调用一样带 description）。 */
function escalate(tools: Tool[], ctx: ExecCtx, mode: string) {
  return bash(tools).execute!(
    "call-1",
    { command: COMMAND, description: "Write build output", sandbox_permissions: mode, justification: JUSTIFY },
    undefined,
    undefined,
    ctx,
  );
}

beforeEach(() => {
  // 子代理里跑测试会继承 PI_IS_SUBAGENT=1，bash 会把审批通道判成没有。
  delete process.env.PI_IS_SUBAGENT;
  mocks.exec.mockReset().mockResolvedValue(CLEAN);
  mocks.dispose.mockReset().mockResolvedValue(undefined);
  mocks.getPolicy = undefined;
  __resetEscalationGrantsForTest();
  __resetApprovalForTest();
  __resetAgentModeForTest();
  __resetJobsForTest();
});

describe("sandbox extension", () => {
  it("registers bash and no separate escalation tool", () => {
    const names = load().tools.map((tool) => tool.name);
    expect(names).toContain("bash");
    expect(names).not.toContain("bash_escalate");
  });

  it("bash carries the escalation pair", () => {
    const properties = bash(load().tools).parameters?.properties ?? {};
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(["sandbox_permissions", "justification"]));
  });

  it("describes the bash tool the same on win32 as pi does: Git Bash, no PowerShell rules", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const tool = bash(load().tools);
      expect(tool.promptSnippet).toBe("Execute bash commands (ls, grep, find, etc.)");
      expect(tool.description).not.toMatch(/PowerShell|LASTEXITCODE/);
      expect(tool.promptGuidelines?.some((g) => /PowerShell|LASTEXITCODE/.test(g))).toBe(false);
      expect(tool.parameters?.properties?.description).toBeTruthy();
      expect(tool.parameters?.required).toContain("description");
      expect(tool.promptGuidelines?.some((g) => g.includes("shown in the UI"))).toBe(true);
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });

  it("hands user_bash the sandbox operations with the facts written back as text", async () => {
    const { handlers } = load();
    mocks.exec.mockResolvedValue({ exitCode: 1, sandbox: { mode: "read-only", denied: true } });
    const { operations } = handlers.user_bash?.({}, {}) as {
      operations: { exec: (c: string, cwd: string, o: { onData?: (d: Buffer) => void }) => Promise<unknown> };
    };
    const chunks: string[] = [];
    const result = await operations.exec(COMMAND, CWD, { onData: (d) => chunks.push(d.toString()) });
    expect(mocks.exec).toHaveBeenCalledWith(COMMAND, CWD, expect.anything());
    expect(result).toEqual({ exitCode: 1 });
    expect(chunks.join("")).toBe("[sandbox: file access denied under read-only mode]\n");
  });

  it("auto: asks before a one-shot widening, then runs it through the sandbox operations", async () => {
    setApprovalPolicy("auto", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    expect(mocks.getPolicy?.()).toMatchObject({ mode: "workspace-write" });
    const ctx = execCtx();
    ctx.ui.select.mockResolvedValue("允许本次");
    const result = await escalate(tools, ctx, "danger-full-access");
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(mocks.exec).toHaveBeenCalledWith(
      COMMAND,
      CWD,
      expect.objectContaining({ env: expect.objectContaining({ PI_SANDBOX_MODE_ONCE: "danger-full-access" }) }),
    );
    expect(result.isError).toBeUndefined();
  });

  it("workspace-edit preset rejects escalation without a prompt", async () => {
    setApprovalPolicy("workspace", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    expect(mocks.getPolicy?.()).toMatchObject({ mode: "workspace-write", workspaceRoot: CWD });
    const ctx = execCtx();
    await expect(escalate(tools, ctx, "danger-full-access")).rejects.toThrow(/workspace-edit approval preset/);
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("Ask plus workspace approval forces read-only and still asks the user", async () => {
    setApprovalPolicy("workspace", CWD);
    setAgentMode("ask", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    expect(mocks.getPolicy?.()).toMatchObject({ mode: "read-only", workspaceRoot: CWD });
    const ctx = execCtx();
    ctx.ui.select.mockResolvedValue("拒绝");
    await expect(escalate(tools, ctx, "workspace-write")).rejects.toThrow(/the user rejected/);
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("full: asking for the current mode just runs", async () => {
    setApprovalPolicy("full", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    const ctx = execCtx();
    await escalate(tools, ctx, "danger-full-access");
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.exec.mock.calls[0]?.[2]?.env?.PI_SANDBOX_MODE_ONCE).toBeUndefined();
  });

  it("disposes the provider and drops the session's escalation grants on session_shutdown", async () => {
    const { handlers } = load();
    await start(handlers);
    grantEscalation(SESSION, "call-9", "workspace-write");
    await handlers.session_shutdown?.({}, sessionCtx());
    expect(mocks.dispose).toHaveBeenCalledWith(SESSION);
    expect(takeEscalationGrant(SESSION, "call-9", "workspace-write")).toBe(false);
  });

  describe("isolated workspace (A track)", () => {
    function makeIsolated(): { tmp: string; w: string } {
      __resetIsolatedWorkspaceCacheForTest();
      const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "gren-sandbox-iso-")));
      const parent = join(tmp, "repo");
      const w = join(parent, ".gren", "worktrees", "abc12345");
      mkdirSync(w, { recursive: true });
      writeFileSync(isolatedMarkerPath(parent, "abc12345"), JSON.stringify({
        version: 1, id: "abc12345", path: w, parentRoot: parent, branch: "gren/abc12345",
        base: { kind: "fresh", ref: "origin/main", commit: "deadbeef" }, createdAt: "2026-10-18T00:00:00.000Z", createdBy: "grenagent",
      }));
      return { tmp, w };
    }

    it("full preset is clamped to workspace-write and the policy says full-access is blocked", async () => {
      const { tmp, w } = makeIsolated();
      try {
        setApprovalPolicy("full", w);
        const { handlers } = load();
        await start(handlers, w);
        expect(mocks.getPolicy?.()).toMatchObject({ mode: "workspace-write", workspaceRoot: w, fullAccessBlocked: true });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("escalating to danger-full-access throws without a prompt and never runs", async () => {
      const { tmp, w } = makeIsolated();
      try {
        setApprovalPolicy("auto", w);
        const { tools, handlers } = load();
        await start(handlers, w);
        const ctx = execCtx({ cwd: w });
        ctx.ui.select.mockResolvedValue("允许本次");
        await expect(escalate(tools, ctx, "danger-full-access")).rejects.toThrow(/isolated workspace/);
        expect(ctx.ui.select).not.toHaveBeenCalled();
        expect(mocks.exec).not.toHaveBeenCalled();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("an ordinary project with the full preset keeps danger-full-access", async () => {
      setApprovalPolicy("full", CWD);
      const { handlers } = load();
      await start(handlers);
      expect(mocks.getPolicy?.()).toMatchObject({ mode: "danger-full-access" });
      expect(mocks.getPolicy?.()).not.toHaveProperty("fullAccessBlocked");
    });
  });

  it("uses session_start ctx.cwd and sessionManager.getSessionId for getPolicy", async () => {
    const { handlers } = load();
    await start(handlers, "D:/a", "sid-from-ctx");
    expect(mocks.getPolicy).toEqual(expect.any(Function));
    expect(mocks.getPolicy?.()).toMatchObject({
      workspaceRoot: "D:/a",
      sessionId: "sid-from-ctx",
    });
    expect(mocks.getPolicy?.().workspaceRoot).not.toBe(process.cwd());
  });
});
