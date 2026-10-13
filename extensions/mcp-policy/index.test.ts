import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApprovalPolicy: vi.fn(() => "auto"),
  decide: vi.fn(() => ({ action: "pass" as const })),
}));

vi.mock("../_shared/approval.js", () => ({ getApprovalPolicy: mocks.getApprovalPolicy }));
// 审计写 ~/.pi/mcp-audit.jsonl：测试里不碰真实的家目录。
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, appendFileSync: vi.fn(), mkdirSync: vi.fn() };
});
vi.mock("./policy.js", async () => {
  const actual = await vi.importActual<typeof import("./policy.js")>("./policy.js");
  return { ...actual, decide: mocks.decide };
});

import mcpPolicy from "./index.js";
import { __resetApprovalRoutesForTest, registerChildApprovalRoute, registerTopApprovalRoute } from "../_shared/approval-route.js";
import { runInWorkspace } from "../_shared/workspace-context.js";

type ToolCall = (event: unknown, ctx: unknown) => Promise<unknown>;

function setup(): ToolCall {
  let handler: ToolCall | undefined;
  mcpPolicy({ on: (ev: string, h: ToolCall) => { if (ev === "tool_call") handler = h; } } as never);
  return (event, ctx) => handler!(event, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApprovalPolicy.mockReturnValue("auto");
  mocks.decide.mockReturnValue({ action: "pass" });
});

describe("mcp-policy approvalAsk mapping", () => {
  it("readonly is treated as approvalAsk so MCP is not prompted twice", async () => {
    mocks.getApprovalPolicy.mockReturnValue("readonly");
    await setup()({ toolName: "mcp__s__t", input: {} }, { hasUI: true });
    expect(mocks.decide.mock.calls[0]?.[4]).toBe(true);
  });
});

describe("mcp-policy · subagents", () => {
  const TOP = "/s/top.jsonl";
  const CHILD = "/s/child.jsonl";
  const ctx = { hasUI: true, ui: { select: vi.fn() }, sessionManager: { getSessionFile: () => CHILD } };
  const asChild = <T>(fn: () => Promise<T>) =>
    runInWorkspace({ origin: "subagent", workspace: "/ws", cwd: "/ws", config: {} }, fn);
  const prompt = { action: "prompt" as const, recordable: false, summary: "{}" };

  beforeEach(() => {
    __resetApprovalRoutesForTest();
    ctx.ui.select.mockReset();
  });

  it("a subagent's empty ui does not count as an interface: without a route it is headless", async () => {
    await asChild(() => setup()({ toolName: "mcp__s__t", input: {} }, ctx));
    expect((mocks.decide.mock.calls[0] as unknown[] | undefined)?.[3]).toBe(false);
  });

  it("with a route the question goes to the parent window", async () => {
    const select = vi.fn(async () => "允许本次");
    registerTopApprovalRoute(TOP, { select });
    registerChildApprovalRoute({ sessionPath: CHILD, parentSessionPath: TOP, agentId: "sa-1", label: "lookup" });
    mocks.decide.mockReturnValue(prompt as never);

    const r = await asChild(() => setup()({ toolName: "mcp__s__t", input: {} }, ctx));
    expect((mocks.decide.mock.calls[0] as unknown[] | undefined)?.[3]).toBe(true);
    expect(r).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(1);
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("a dismissed card is a cancellation, not a user refusal", async () => {
    registerTopApprovalRoute(TOP, { select: vi.fn(async () => undefined) });
    registerChildApprovalRoute({ sessionPath: CHILD, parentSessionPath: TOP, agentId: "sa-1", label: "lookup" });
    mocks.decide.mockReturnValue(prompt as never);
    const r = await asChild(() => setup()({ toolName: "mcp__s__t", input: {} }, ctx));
    expect(r).toEqual({ block: true, reason: "授权请求已取消" });
  });

  it("nobody answers in time: blocked with the timeout reason", async () => {
    vi.useFakeTimers();
    try {
      const select = vi.fn(
        (_t: string, _o: string[], opts?: { signal?: AbortSignal }) =>
          new Promise<string | undefined>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(undefined))),
      );
      registerTopApprovalRoute(TOP, { select });
      registerChildApprovalRoute({ sessionPath: CHILD, parentSessionPath: TOP, agentId: "sa-1", label: "lookup" });
      mocks.decide.mockReturnValue(prompt as never);
      const pending = asChild(() => setup()({ toolName: "mcp__s__t", input: {} }, ctx));
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toEqual({ block: true, reason: "60 秒内没有人批准，视为被拒" });
    } finally {
      vi.useRealTimers();
    }
  });
});
