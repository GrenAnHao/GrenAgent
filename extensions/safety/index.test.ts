import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  evaluateToolCall: vi.fn(async (): Promise<{ decision: "allow" | "ask" | "deny"; auditId: string }> => ({
    decision: "allow",
    auditId: "a1",
  })),
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
import { __resetEscalationGrantsForTest, takeEscalationGrant } from "../_shared/sandbox/escalationGrant.js";
import safety from "./index.js";
import { __resetApprovalRoutesForTest, registerChildApprovalRoute, registerTopApprovalRoute } from "../_shared/approval-route.js";
import { runInWorkspace } from "../_shared/workspace-context.js";

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
  __resetEscalationGrantsForTest();
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
    expect(r).toMatchObject({ block: true, terminate: true });
    expect(mocks.evaluateToolCall).not.toHaveBeenCalled();
  });

  it("ask: blocks out-of-cwd write when user declines", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    const ui = { select: vi.fn().mockResolvedValue("拒绝") };
    const r = await setup()({ toolName: "write", input: { path: "../escape.txt" } }, { hasUI: true, cwd, ui });
    expect(ui.select).toHaveBeenCalled();
    expect(r).toMatchObject({ block: true, terminate: true });
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
    expect(r).toMatchObject({ block: true, terminate: true });
  });

  it("ask: confirms MCP tools (mcp__*, e.g. fetch) and blocks on decline", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    const ui = { select: vi.fn().mockResolvedValue("拒绝") };
    const r = await setup()({ toolName: "mcp__user_fetch__fetch", input: {} }, { hasUI: true, cwd, ui });
    expect(ui.select).toHaveBeenCalled();
    expect(r).toMatchObject({ block: true, terminate: true });
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
    expect(r).toMatchObject({ block: true, terminate: true });
  });

  it("ask headless (no UI) queues the call instead of degrading to auto", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    const ui = { select: vi.fn() };
    const r = await setup()({ toolName: "write", input: { path: "../escape.txt" } }, { hasUI: false, cwd, ui });
    expect(ui.select).not.toHaveBeenCalled();
    expect(r?.block).toBe(true);
    expect(r).not.toHaveProperty("terminate", true);
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
    expect(r1).toMatchObject({ block: true, terminate: true });
    expect(mocks.evaluateToolCall).not.toHaveBeenCalled();
    const r2 = await setup()({ toolName: "hl_edit", input: {} }, { hasUI: true, cwd, ui: {} });
    expect(r2).toMatchObject({ block: true, terminate: true });
  });

  it("ask: confirms host code execution (py_run)", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    const ui = { select: vi.fn().mockResolvedValue("拒绝") };
    const r = await setup()({ toolName: "py_run", input: { code: "x=1" } }, { hasUI: true, cwd, ui });
    expect(ui.select).toHaveBeenCalled();
    expect(r).toMatchObject({ block: true, terminate: true });
  });

  it("ask: confirms dap_launch (host execution)", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    const ui = { select: vi.fn().mockResolvedValue("拒绝") };
    const r = await setup()({ toolName: "dap_launch", input: { program: "x.py" } }, { hasUI: true, cwd, ui });
    expect(r).toMatchObject({ block: true, terminate: true });
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

describe("safety · bash sandbox escalation", () => {
  const input = { command: "npm run build", sandbox_permissions: "workspace-write", justification: "需要写构建产物" };
  const sessionManager = { getSessionId: () => "s1" };
  const askVerdict = () => mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });

  it("the ask names the target mode and the reason; allowing leaves a grant for this call", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    askVerdict();
    const ui = { select: vi.fn().mockResolvedValue("允许本次") };
    const r = await setup()({ toolName: "bash", toolCallId: "call-1", input }, { hasUI: true, cwd, ui, sessionManager });
    expect(r).toBeUndefined();
    expect(ui.select.mock.calls[0]?.[0]).toBe(
      "请求批准：\n\n  npm run build\n\n  沙箱升权 → workspace-write\n  理由：需要写构建产物",
    );
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(true);
  });

  it("an escalation ask offers no always-allow: that would only remember the command, not the widening", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    askVerdict();
    const ui = { select: vi.fn().mockResolvedValue("允许本次") };
    await setup()({ toolName: "bash", toolCallId: "call-1", input }, { hasUI: true, cwd, ui, sessionManager });
    expect(ui.select.mock.calls[0]?.[1]).toEqual(["允许本次", "拒绝"]);
    expect(mocks.rememberToolRule).not.toHaveBeenCalled();
  });

  it("a rejection leaves no grant", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    askVerdict();
    const ui = { select: vi.fn().mockResolvedValue("拒绝") };
    const r = await setup()({ toolName: "bash", toolCallId: "call-1", input }, { hasUI: true, cwd, ui, sessionManager });
    expect(r).toMatchObject({ block: true });
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(false);
  });

  it("an auto-allowed call leaves no grant, so bash still asks", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("auto");
    const ui = { select: vi.fn() };
    const r = await setup()({ toolName: "bash", toolCallId: "call-1", input }, { hasUI: true, cwd, ui, sessionManager });
    expect(r).toBeUndefined();
    expect(ui.select).not.toHaveBeenCalled();
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(false);
  });

  it("a plain bash ask reads as before and leaves no grant", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    askVerdict();
    const ui = { select: vi.fn().mockResolvedValue("允许本次") };
    await setup()(
      { toolName: "bash", toolCallId: "call-1", input: { command: "rm foo" } },
      { hasUI: true, cwd, ui, sessionManager },
    );
    expect(ui.select.mock.calls[0]?.[0]).toBe("请求批准：\n\n  rm foo");
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(false);
  });

  it("a blank justification is not an escalation: plain ask, no grant (bash will reject it anyway)", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    askVerdict();
    const ui = { select: vi.fn().mockResolvedValue("允许本次") };
    await setup()(
      { toolName: "bash", toolCallId: "call-1", input: { ...input, justification: "   " } },
      { hasUI: true, cwd, ui, sessionManager },
    );
    expect(ui.select.mock.calls[0]?.[0]).toBe("请求批准：\n\n  npm run build");
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(false);
  });
});

describe("safety · subagent approvals through the parent window", () => {
  const TOP = "/s/top.jsonl";
  const CHILD = "/s/child.jsonl";
  const childCtx = (extra: Record<string, unknown> = {}) => ({
    hasUI: true,
    cwd,
    ui: { select: vi.fn() },
    sessionManager: { getSessionId: () => "child", getSessionFile: () => CHILD },
    ...extra,
  });
  const asChild = <T>(fn: () => Promise<T>) =>
    runInWorkspace({ origin: "subagent", workspace: cwd, cwd, config: {} }, fn);

  beforeEach(() => {
    __resetApprovalRoutesForTest();
    vi.mocked(getApprovalPolicy).mockReturnValue("auto");
  });

  function routeTo(answer: (opts: { signal?: AbortSignal }) => Promise<string | undefined>) {
    const select = vi.fn((_t: string, _o: string[], opts?: { signal?: AbortSignal }) => answer(opts ?? {}));
    registerTopApprovalRoute(TOP, { select });
    registerChildApprovalRoute({ sessionPath: CHILD, parentSessionPath: TOP, agentId: "sa-1", label: "fix build" });
    return select;
  }

  it("tells the main process it can ask, then asks the parent window with the child named in the title", async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    const select = routeTo(async () => "允许本次");
    const ctx = childCtx();
    const r = await asChild(() => setup()({ toolName: "bash", input: { command: "rm -rf build" } }, ctx));

    expect(r).toBeUndefined();
    expect((mocks.evaluateToolCall.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({ origin: "subagent", approvalRoute: true });
    expect(select.mock.calls[0]?.[0]).toBe("子代理 fix build（sa-1） 请求批准：\n\n  rm -rf build");
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(mocks.settleToolCall).toHaveBeenCalledWith(expect.anything(), "a1", "user_allow");
  });

  it("without a route the facts say nothing and the pinned deny keeps its delegation reason", async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: "deny", auditId: "a1", ruleId: "builtin.subagent-ask-pinned" } as never);
    const r = await asChild(() => setup()({ toolName: "bash", input: { command: "rm -rf build" } }, childCtx()));
    expect((mocks.evaluateToolCall.mock.calls[0] as unknown[] | undefined)?.[1]).not.toHaveProperty("approvalRoute");
    expect(r?.reason).toContain("已被自动拒绝");
  });

  it("nobody answers within the timeout: blocked as a refusal (no terminate), audited as timeout", async () => {
    vi.useFakeTimers();
    try {
      mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
      routeTo(({ signal }) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve(undefined))));
      const pending = asChild(() => setup()({ toolName: "bash", input: { command: "rm -rf build" } }, childCtx()));
      await vi.advanceTimersByTimeAsync(60_000);
      const r = await pending;
      expect(r).toMatchObject({ block: true });
      expect(r).not.toHaveProperty("terminate");
      expect(r?.reason).toContain("60 秒内没有人批准 bash，视为被拒");
      expect(mocks.settleToolCall).toHaveBeenCalledWith(expect.anything(), "a1", "timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refusal from the parent window comes back to the child without terminating it", async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });
    routeTo(async () => "拒绝");
    const r = await asChild(() => setup()({ toolName: "bash", input: { command: "rm -rf build" } }, childCtx()));
    expect(r).toMatchObject({ block: true });
    expect(r).not.toHaveProperty("terminate");
    expect(r?.reason).toContain("用户拒绝：bash");
    expect(mocks.settleToolCall).toHaveBeenCalledWith(expect.anything(), "a1", "user_deny");
  });

  it("the parent goes away between the verdict and the question: delegation deny, audited as aborted", async () => {
    routeTo(async () => "允许本次");
    mocks.evaluateToolCall.mockImplementation(async () => {
      __resetApprovalRoutesForTest();
      registerChildApprovalRoute({ sessionPath: CHILD, parentSessionPath: TOP, agentId: "sa-1", label: "fix build" });
      return { decision: "ask", auditId: "a1" };
    });
    const r = await asChild(() => setup()({ toolName: "bash", input: { command: "rm -rf build" } }, childCtx()));
    expect(r?.reason).toContain("已被自动拒绝");
    expect(mocks.settleToolCall).toHaveBeenCalledWith(expect.anything(), "a1", "aborted");
  });
});
