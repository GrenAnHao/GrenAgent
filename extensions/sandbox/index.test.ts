import { beforeEach, describe, expect, it, vi } from "vitest";
import { setApprovalPolicy, __resetApprovalForTest } from "../_shared/approval.js";
import {
  consumePendingDenial,
  rememberPendingDenial,
  __resetPendingDenialsForTest,
} from "../_shared/sandbox/pendingDenial.js";
import { setAgentMode, __resetAgentModeForTest } from "../agent-mode/modes.js";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(async () => ({ exitCode: 0 })),
  dispose: vi.fn(async () => {}),
  getPolicy: undefined as undefined | (() => {
    mode: string;
    workspaceRoot: string;
    sessionId?: string;
  }),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createBashToolDefinition: (_cwd: string, opts: object) => ({
    name: "bash",
    description: "Execute a bash command.",
    promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
    promptGuidelines: ["Do not leak PI_* environment variables."],
    parameters: {
      properties: {
        command: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["command"],
    },
    ...opts,
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
const JUSTIFY = "need write access for the build output";
const SHORT_JUSTIFY = "too short";

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: unknown };
type EscalateParams = { command: string; justification: string; targetMode: string };
type Tool = {
  name: string;
  execute?: (
    id: string,
    params: EscalateParams,
    signal: unknown,
    onUpdate: unknown,
    ctx: ExecCtx,
  ) => Promise<ToolResult>;
};
type ExecCtx = {
  cwd: string;
  hasUI: boolean;
  ui: { select: ReturnType<typeof vi.fn> };
  sessionManager: { getSessionId: () => string };
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
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
  };
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

function escalateTool(tools: Tool[]) {
  const tool = tools.find((item) => item.name === "bash_escalate");
  if (!tool?.execute) throw new Error("bash_escalate not registered");
  return tool.execute.bind(tool);
}

function resultText(result: ToolResult) {
  return result.content.map((part) => part.text ?? "").join("");
}

async function callEscalate(
  tools: Tool[],
  ctx: ExecCtx,
  params: Partial<EscalateParams> = {},
  extras: { signal?: AbortSignal; onUpdate?: ReturnType<typeof vi.fn> } = {},
) {
  return escalateTool(tools)(
    "call",
    {
      command: COMMAND,
      justification: JUSTIFY,
      targetMode: "workspace-write",
      ...params,
    },
    extras.signal,
    extras.onUpdate,
    ctx,
  );
}

beforeEach(() => {
  mocks.exec.mockReset().mockResolvedValue({ exitCode: 0 });
  mocks.dispose.mockReset().mockResolvedValue(undefined);
  mocks.getPolicy = undefined;
  __resetPendingDenialsForTest();
  __resetApprovalForTest();
  __resetAgentModeForTest();
});

describe("sandbox extension", () => {
  it("registers bash and bash_escalate", () => {
    const { tools } = load();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["bash", "bash_escalate"]));
  });

  it("annotates the bash tool for PowerShell on win32", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const { tools } = load();
      const bash = tools.find((tool) => tool.name === "bash") as {
        promptSnippet?: string;
        description?: string;
        promptGuidelines?: string[];
        parameters?: { properties?: { description?: unknown }; required?: string[] };
      };
      expect(bash.promptSnippet).toContain("PowerShell");
      expect(bash.promptSnippet).not.toContain("ls, grep, find");
      expect(bash.description).toContain("exit $LASTEXITCODE");
      expect(bash.promptGuidelines?.some((g) => g.includes("PowerShell"))).toBe(true);
      expect(bash.parameters?.properties?.description).toBeTruthy();
      expect(bash.parameters?.required).toContain("description");
      expect(bash.promptGuidelines?.some((g) => g.includes("shown in the UI"))).toBe(true);
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });

  it("subscribes to user_bash and returns operations", () => {
    const { handlers } = load();
    expect(typeof handlers.user_bash).toBe("function");
    expect(handlers.user_bash?.({}, {})).toEqual({ operations: { exec: mocks.exec } });
  });

  it("rejects bash_escalate without pending and does not open ui.select", async () => {
    const { tools, handlers } = load();
    await start(handlers);
    const ctx = execCtx();
    const result = await callEscalate(tools, ctx);
    expect(resultText(result)).toContain("no pending denial");
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("rejects bash_escalate when the pending command differs", async () => {
    const { tools, handlers } = load();
    await start(handlers);
    rememberPendingDenial(CWD, COMMAND, "read-only", SESSION);
    const ctx = execCtx();
    const result = await callEscalate(tools, ctx, { command: `${COMMAND} extra` });
    expect(resultText(result)).toContain("no pending denial");
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("rejects bash_escalate when justification is shorter than 20", async () => {
    const { tools, handlers } = load();
    await start(handlers);
    rememberPendingDenial(CWD, COMMAND, "read-only", SESSION);
    const ctx = execCtx();
    const result = await callEscalate(tools, ctx, { justification: SHORT_JUSTIFY });
    expect(resultText(result)).toMatch(/justification/i);
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(consumePendingDenial(CWD, COMMAND, SESSION)).toEqual({ mode: "read-only" });
  });

  it("does not consume pending when targetMode is not a strict widening", async () => {
    const { tools, handlers } = load();
    await start(handlers);
    rememberPendingDenial(CWD, COMMAND, "read-only", SESSION);
    const ctx = execCtx();
    const result = await callEscalate(tools, ctx, { targetMode: "read-only" });
    expect(resultText(result)).toMatch(/widening/i);
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(consumePendingDenial(CWD, COMMAND, SESSION)).toEqual({ mode: "read-only" });
  });

  it("rejects workspace-edit escalation without a prompt when resolved mode is workspace-write", async () => {
    setApprovalPolicy("workspace", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    expect(mocks.getPolicy?.()).toMatchObject({ mode: "workspace-write", workspaceRoot: CWD });
    rememberPendingDenial(CWD, COMMAND, "workspace-write", SESSION);
    const ctx = execCtx();
    const result = await callEscalate(tools, ctx, { targetMode: "danger-full-access" });
    expect(resultText(result)).toMatch(/workspace/i);
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("asks via ui.select for auto plus a legal widening and execs once when allowed", async () => {
    setApprovalPolicy("auto", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    rememberPendingDenial(CWD, COMMAND, "read-only", SESSION);
    const ctx = execCtx();
    ctx.ui.select.mockResolvedValue("允许本次");
    const result = await callEscalate(tools, ctx);
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.exec).toHaveBeenCalledWith(
      COMMAND,
      CWD,
      expect.objectContaining({
        env: expect.objectContaining({ PI_SANDBOX_MODE_ONCE: "workspace-write" }),
      }),
    );
    expect(resultText(result).length).toBeGreaterThan(0);
  });

  it("forwards signal, streams onData through onUpdate, and returns command output", async () => {
    setApprovalPolicy("auto", CWD);
    mocks.exec.mockImplementation(async (_command, _cwd, options: { onData?: (data: Buffer) => void }) => {
      options.onData?.(Buffer.from("hello from bash\n"));
      return { exitCode: 0 };
    });
    const { tools, handlers } = load();
    await start(handlers);
    rememberPendingDenial(CWD, COMMAND, "read-only", SESSION);
    const ctx = execCtx();
    ctx.ui.select.mockResolvedValue("允许本次");
    const signal = new AbortController().signal;
    const onUpdate = vi.fn();
    const result = await callEscalate(tools, ctx, {}, { signal, onUpdate });
    expect(mocks.exec).toHaveBeenCalledWith(
      COMMAND,
      CWD,
      expect.objectContaining({
        signal,
        onData: expect.any(Function),
      }),
    );
    expect(onUpdate).toHaveBeenCalled();
    expect(resultText(result)).toContain("hello from bash");
    expect(resultText(result)).not.toBe("exit 0");
  });

  it("matches a pending commandPrefix record by its last newline segment", async () => {
    setApprovalPolicy("auto", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    rememberPendingDenial(CWD, `pref\n${COMMAND}`, "read-only", SESSION);
    const ctx = execCtx();
    ctx.ui.select.mockResolvedValue("拒绝");
    const result = await callEscalate(tools, ctx);
    expect(resultText(result)).not.toContain("no pending denial");
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(consumePendingDenial(CWD, `pref\n${COMMAND}`, SESSION)).toBeUndefined();
  });

  it.each([
    ["returns undefined", async (select: ReturnType<typeof vi.fn>) => select.mockResolvedValue(undefined)],
    ["throws", async (select: ReturnType<typeof vi.fn>) => select.mockRejectedValue(new Error("cancelled"))],
  ])("fails when ui.select %s; pending is consumed and exec is not called", async (_name, arrange) => {
    setApprovalPolicy("auto", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    rememberPendingDenial(CWD, COMMAND, "read-only", SESSION);
    const ctx = execCtx();
    await arrange(ctx.ui.select);
    const result = await callEscalate(tools, ctx);
    expect(resultText(result)).toMatch(/reject|cancel/i);
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(consumePendingDenial(CWD, COMMAND, SESSION)).toBeUndefined();
  });

  it("disposes the provider and clears pending denials on session_shutdown", async () => {
    const { handlers } = load();
    await start(handlers);
    rememberPendingDenial(CWD, COMMAND, "read-only", SESSION);
    await handlers.session_shutdown?.({}, sessionCtx());
    expect(mocks.dispose).toHaveBeenCalledWith(SESSION);
    expect(consumePendingDenial(CWD, COMMAND, SESSION)).toBeUndefined();
  });

  it("rejects bash_escalate under full with no pending and does not open ui.select", async () => {
    setApprovalPolicy("full", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    const ctx = execCtx();
    const result = await callEscalate(tools, ctx);
    expect(resultText(result)).toContain("no pending denial");
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("Ask plus workspace approval forces read-only and still asks the user", async () => {
    setApprovalPolicy("workspace", CWD);
    setAgentMode("ask", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    expect(mocks.getPolicy?.()).toMatchObject({ mode: "read-only", workspaceRoot: CWD });
    rememberPendingDenial(CWD, COMMAND, "read-only", SESSION);
    const ctx = execCtx();
    ctx.ui.select.mockResolvedValue("拒绝");
    const result = await callEscalate(tools, ctx);
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(resultText(result)).not.toMatch(/workspace-edit preset rejects/i);
    expect(mocks.exec).not.toHaveBeenCalled();
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
