import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetApprovalRoutesForTest, canForwardApproval, forwardApproval } from "../_shared/approval-route.js";
import { runInWorkspace } from "../_shared/workspace-context.js";
import { registerTopApprovalLifecycle } from "./approval-top.js";

type Handler = (event: unknown, ctx: unknown) => void;

function setup() {
  const handlers = new Map<string, Handler>();
  registerTopApprovalLifecycle({ on: (ev: string, h: Handler) => handlers.set(ev, h) } as never);
  return {
    start: (ctx: unknown) => handlers.get("session_start")!({ type: "session_start" }, ctx),
    shutdown: () => handlers.get("session_shutdown")!({ type: "session_shutdown" }, {}),
  };
}

function sessionCtx(path: string, opts: { hasUI?: boolean; entries?: unknown[]; select?: (...args: never[]) => unknown } = {}) {
  return {
    hasUI: opts.hasUI ?? true,
    ui: { select: opts.select ?? vi.fn(async () => "允许本次") },
    sessionManager: { getSessionFile: () => path, getEntries: () => opts.entries ?? [] },
  };
}

const childMeta = { type: "custom", customType: "subagent_meta", data: { origin: "subagent", agentId: "sa-1" } };

afterEach(() => {
  __resetApprovalRoutesForTest();
  delete process.env.PI_IS_SUBAGENT;
});

describe("top-level approval route", () => {
  it("a top-level session with an interface becomes where its subagents' approvals end up", async () => {
    const { start } = setup();
    const select = vi.fn<(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>>(async () => "允许本次");
    start(sessionCtx("/s/top.jsonl", { select }));

    expect(await canForwardApproval("/s/top.jsonl")).toBe(true);
    const answer = await forwardApproval("/s/top.jsonl", {
      title: "请求批准：x",
      options: ["允许本次", "拒绝"],
      chain: [{ agentId: "sa-1", label: "fix" }],
      timeoutMs: 1000,
    });
    expect(answer).toEqual({ outcome: "answered", choice: "允许本次" });
    expect(select.mock.calls[0]?.[0]).toBe("子代理 fix（sa-1） 请求批准：x");
  });

  it("does not register sessions without an interface, subagent sessions, or anything in a worker process", async () => {
    const { start } = setup();
    start(sessionCtx("/s/headless.jsonl", { hasUI: false }));
    start(sessionCtx("/s/child.jsonl", { entries: [childMeta] }));
    runInWorkspace({ origin: "subagent", workspace: "/ws", cwd: "/ws", config: {} }, () => start(sessionCtx("/s/opening.jsonl")));
    process.env.PI_IS_SUBAGENT = "1";
    start(sessionCtx("/s/worker.jsonl"));

    for (const path of ["/s/headless.jsonl", "/s/child.jsonl", "/s/opening.jsonl", "/s/worker.jsonl"]) {
      expect(await canForwardApproval(path)).toBe(false);
    }
  });

  it("switching to another session moves the route; shutting down removes it", async () => {
    const { start, shutdown } = setup();
    start(sessionCtx("/s/first.jsonl"));
    start(sessionCtx("/s/second.jsonl"));
    expect(await canForwardApproval("/s/first.jsonl")).toBe(false);
    expect(await canForwardApproval("/s/second.jsonl")).toBe(true);
    shutdown();
    expect(await canForwardApproval("/s/second.jsonl")).toBe(false);
  });
});
