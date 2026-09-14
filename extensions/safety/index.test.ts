import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  evaluateToolCall: vi.fn(async () => ({ decision: "allow" as const, auditId: "a1" })),
  rememberToolRule: vi.fn(async () => true),
  settleToolCall: vi.fn(async () => undefined),
}));

vi.mock("../_shared/desktop-control.js", async () => {
  const actual = await vi.importActual<typeof import("../_shared/desktop-control.js")>("../_shared/desktop-control.js");
  return {
    ...actual,
    desktopControl: () => ({ request: vi.fn() }),
    evaluateToolCall: mocks.evaluateToolCall,
    rememberToolRule: mocks.rememberToolRule,
    settleToolCall: mocks.settleToolCall,
  };
});
vi.mock("../_shared/approval.js", () => ({ getApprovalPolicy: vi.fn() }));
vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn() }));

import { getApprovalPolicy } from "../_shared/approval.js";
import { getConfig } from "../_shared/runtime-config.js";
import safety from "./index.js";

type ToolCall = (event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;

function setup(): ToolCall {
  let handler: ToolCall | undefined;
  const pi = { on: (ev: string, h: ToolCall) => { if (ev === "tool_call") handler = h; } };
  safety(pi as unknown as Parameters<typeof safety>[0]);
  return (event, ctx) => handler!(event, ctx);
}

const cwd = process.platform === "win32" ? "D:\\proj" : "/proj";

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.SAFETY_DENY_TOOLS;
  delete process.env.SAFETY_READONLY;
  vi.mocked(getConfig).mockReturnValue(undefined);
  mocks.evaluateToolCall.mockResolvedValue({ decision: "allow", auditId: "a1" });
});

describe("safety approval gating", () => {
  it("full skips user-facing confirms (dangerous bash allowed)", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("full");
    const r = await setup()({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, { hasUI: true, cwd, ui: {} });
    expect(r).toBeUndefined();
  });

  it("full does NOT bypass capability denyTools (sub-agent hard limit)", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("full");
    vi.mocked(getConfig).mockImplementation((k: string) => (k === "SAFETY_DENY_TOOLS" ? "spawn_agent" : undefined));
    const r = await setup()({ toolName: "spawn_agent", input: {} }, { hasUI: true, cwd, ui: {} });
    expect(r?.block).toBe(true);
    expect(mocks.evaluateToolCall).not.toHaveBeenCalled();
  });

  it("ask: blocks out-of-cwd write when user declines", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    const ui = { select: vi.fn().mockResolvedValue("拒绝") };
    const r = await setup()({ toolName: "write", input: { path: "../escape.txt" } }, { hasUI: true, cwd, ui });
    expect(ui.select).toHaveBeenCalled();
    expect(r?.block).toBe(true);
  });

  it("ask: allows in-cwd write without prompting", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    const ui = { select: vi.fn() };
    const r = await setup()({ toolName: "write", input: { path: "src/a.ts" } }, { hasUI: true, cwd, ui });
    expect(ui.select).not.toHaveBeenCalled();
    expect(r).toBeUndefined();
  });

  it("ask: blocks network tool when user declines (real tool name fetch_url)", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    const ui = { select: vi.fn().mockResolvedValue("拒绝") };
    const r = await setup()({ toolName: "fetch_url", input: { url: "http://x" } }, { hasUI: true, cwd, ui });
    expect(ui.select).toHaveBeenCalled();
    expect(r?.block).toBe(true);
  });

  it("ask: confirms MCP tools (mcp__*, e.g. fetch) and blocks on decline", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    const ui = { select: vi.fn().mockResolvedValue("拒绝") };
    const r = await setup()({ toolName: "mcp__user_fetch__fetch", input: {} }, { hasUI: true, cwd, ui });
    expect(ui.select).toHaveBeenCalled();
    expect(r?.block).toBe(true);
  });

  it("auto: does NOT confirm MCP tools (minimal prompts)", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("auto");
    const ui = { select: vi.fn() };
    const r = await setup()({ toolName: "mcp__user_fetch__fetch", input: {} }, { hasUI: true, cwd, ui });
    expect(ui.select).not.toHaveBeenCalled();
    expect(r).toBeUndefined();
  });

  it("ask: confirms mutating bash", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    const ui = { select: vi.fn().mockResolvedValue("拒绝") };
    const r = await setup()({ toolName: "bash", input: { command: "rm foo" } }, { hasUI: true, cwd, ui });
    expect(ui.select).toHaveBeenCalled();
    expect(r?.block).toBe(true);
  });

  it("ask headless (no UI) queues the call instead of degrading to auto", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    const ui = { select: vi.fn() };
    const r = await setup()({ toolName: "write", input: { path: "../escape.txt" } }, { hasUI: false, cwd, ui });
    expect(ui.select).not.toHaveBeenCalled();
    expect(r?.block).toBe(true);
    expect(mocks.settleToolCall).not.toHaveBeenCalled();
  });

  it("auto: no extra confirm for out-of-cwd write", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("auto");
    const ui = { select: vi.fn() };
    const r = await setup()({ toolName: "write", input: { path: "../escape.txt" } }, { hasUI: true, cwd, ui });
    expect(ui.select).not.toHaveBeenCalled();
    expect(r).toBeUndefined();
  });

  it("readonly blocks ast_edit / hl_edit (write-allowlist bypass writers)", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("auto");
    vi.mocked(getConfig).mockImplementation((k: string) => (k === "SAFETY_READONLY" ? "1" : undefined));
    const r1 = await setup()({ toolName: "ast_edit", input: {} }, { hasUI: true, cwd, ui: {} });
    expect(r1?.block).toBe(true);
    expect(mocks.evaluateToolCall).not.toHaveBeenCalled();
    const r2 = await setup()({ toolName: "hl_edit", input: {} }, { hasUI: true, cwd, ui: {} });
    expect(r2?.block).toBe(true);
  });

  it("ask: confirms host code execution (py_run)", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    const ui = { select: vi.fn().mockResolvedValue("拒绝") };
    const r = await setup()({ toolName: "py_run", input: { code: "x=1" } }, { hasUI: true, cwd, ui });
    expect(ui.select).toHaveBeenCalled();
    expect(r?.block).toBe(true);
  });

  it("ask: confirms dap_launch (host execution)", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    const ui = { select: vi.fn().mockResolvedValue("拒绝") };
    const r = await setup()({ toolName: "dap_launch", input: { program: "x.py" } }, { hasUI: true, cwd, ui });
    expect(r?.block).toBe(true);
  });

  it("uses the delegation deny reason when the pinned subagent rule fires", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("auto");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "deny", auditId: "a1", ruleId: "builtin.subagent-ask-pinned" } as never);
    const r = await setup()({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, { hasUI: false, cwd, ui: {} });
    expect(r).toMatchObject({ block: true });
    expect(r?.reason).toContain("已被自动拒绝");
    expect(r?.reason).toContain("不要重试");
  });

  it("keeps the generic deny reason for other rule ids", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("auto");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "deny", auditId: "a1", ruleId: "builtin.protected-path" } as never);
    const r = await setup()({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, { hasUI: false, cwd, ui: {} });
    expect(r?.reason).toBe("已被授权规则拒绝：bash");
  });
});
