import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetApprovalRoutesForTest,
  canForwardApproval,
  canRequestApproval,
  forwardApproval,
  registerChildApprovalRoute,
  registerTopApprovalRoute,
  requestApproval,
  setApprovalUpstream,
  subagentApprovalTimeoutMs,
  type ApprovalUi,
} from "./approval-route.js";
import { runInWorkspace } from "./workspace-context.js";

const withConfig = <T>(config: Record<string, string>, fn: () => T): T =>
  runInWorkspace({ origin: "subagent", workspace: "/ws", cwd: "/ws", config }, fn);

type SelectOpts = { signal?: AbortSignal; timeout?: number; subagents?: unknown };

function fakeUi(answer: (title: string, options: string[], opts: SelectOpts) => Promise<string | undefined>) {
  const calls: Array<{ title: string; options: string[]; opts: SelectOpts }> = [];
  const ui: ApprovalUi = {
    select: (title, options, opts) => {
      calls.push({ title, options, opts: (opts ?? {}) as SelectOpts });
      return answer(title, options, (opts ?? {}) as SelectOpts);
    },
  };
  return { ui, calls };
}

/** 等到 signal 被中止才返回 undefined：模拟没人点的卡片。 */
const neverAnswered = (_t: string, _o: string[], opts: SelectOpts) =>
  new Promise<string | undefined>((resolve) => opts.signal?.addEventListener("abort", () => resolve(undefined)));

afterEach(() => {
  __resetApprovalRoutesForTest();
  vi.useRealTimers();
});

describe("approval routes", () => {
  it("defaults to 60 seconds, reads SUBAGENT_APPROVAL_TIMEOUT_MS, and 0 turns forwarding off", async () => {
    expect(withConfig({}, subagentApprovalTimeoutMs)).toBe(60_000);
    expect(withConfig({ SUBAGENT_APPROVAL_TIMEOUT_MS: "5000" }, subagentApprovalTimeoutMs)).toBe(5000);
    expect(withConfig({ SUBAGENT_APPROVAL_TIMEOUT_MS: "nope" }, subagentApprovalTimeoutMs)).toBe(60_000);

    registerTopApprovalRoute("/s/parent.jsonl", fakeUi(async () => "允许本次").ui);
    registerChildApprovalRoute({ sessionPath: "/s/child.jsonl", parentSessionPath: "/s/parent.jsonl", agentId: "sa-1", label: "fix" });
    expect(await withConfig({}, () => canRequestApproval("/s/child.jsonl"))).toBe(true);
    expect(await withConfig({ SUBAGENT_APPROVAL_TIMEOUT_MS: "0" }, () => canRequestApproval("/s/child.jsonl"))).toBe(false);
    expect(await withConfig({ SUBAGENT_APPROVAL_TIMEOUT_MS: "0" }, () => canForwardApproval("/s/parent.jsonl"))).toBe(false);
  });

  it("a child reaches the top session through its ancestors; a dangling chain cannot ask", async () => {
    registerTopApprovalRoute("/s/top.jsonl", fakeUi(async () => undefined).ui);
    registerChildApprovalRoute({ sessionPath: "/s/a.jsonl", parentSessionPath: "/s/top.jsonl", agentId: "sa-a", label: "a" });
    registerChildApprovalRoute({ sessionPath: "/s/b.jsonl", parentSessionPath: "/s/a.jsonl", agentId: "sa-b", label: "b" });
    registerChildApprovalRoute({ sessionPath: "/s/lost.jsonl", parentSessionPath: "/s/gone.jsonl", agentId: "sa-l", label: "l" });

    expect(await canRequestApproval("/s/b.jsonl")).toBe(true);
    expect(await canRequestApproval("/s/lost.jsonl")).toBe(false);
    // 顶层会话自己不是子代理：它直接用自己的界面，不走路由。
    expect(await canRequestApproval("/s/top.jsonl")).toBe(false);
    expect(await canRequestApproval(undefined)).toBe(false);
    expect(await canForwardApproval("/s/a.jsonl")).toBe(true);
    expect(await canForwardApproval("/s/gone.jsonl")).toBe(false);
  });

  it("asks through the top session's ui with the child chain in the title, outermost first", async () => {
    const { ui, calls } = fakeUi(async () => "允许本次");
    registerTopApprovalRoute("/s/top.jsonl", ui);
    registerChildApprovalRoute({ sessionPath: "/s/a.jsonl", parentSessionPath: "/s/top.jsonl", agentId: "sa-a", label: "review the parser" });
    registerChildApprovalRoute({ sessionPath: "/s/b.jsonl", parentSessionPath: "/s/a.jsonl", agentId: "sa-b", label: "run the tests" });

    const result = await requestApproval("/s/b.jsonl", { title: "请求批准：\n\n  npm test", options: ["允许本次", "拒绝"] });

    expect(result).toEqual({ outcome: "answered", choice: "允许本次" });
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe("子代理 review the parser（sa-a） › run the tests（sa-b） 请求批准：\n\n  npm test");
    expect(calls[0].options).toEqual(["允许本次", "拒绝"]);
    expect(calls[0].opts.timeout).toBe(60_000);
    expect(calls[0].opts.subagents).toEqual([
      { agentId: "sa-a", label: "review the parser" },
      { agentId: "sa-b", label: "run the tests" },
    ]);
  });

  it("times out after SUBAGENT_APPROVAL_TIMEOUT_MS counted from the request, and closes the dialog", async () => {
    vi.useFakeTimers();
    const { ui, calls } = fakeUi(neverAnswered);
    registerTopApprovalRoute("/s/top.jsonl", ui);
    registerChildApprovalRoute({ sessionPath: "/s/a.jsonl", parentSessionPath: "/s/top.jsonl", agentId: "sa-a", label: "a" });

    const pending = withConfig({ SUBAGENT_APPROVAL_TIMEOUT_MS: "8000" }, () =>
      requestApproval("/s/a.jsonl", { title: "t", options: ["允许本次", "拒绝"] }),
    );
    await vi.advanceTimersByTimeAsync(7999);
    expect(calls[0].opts.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ outcome: "timeout" });
    expect(calls[0].opts.timeout).toBe(8000);
    expect(calls[0].opts.signal?.aborted).toBe(true);
  });

  it("a dismissed card is a cancellation, and an interrupted child withdraws its request", async () => {
    registerTopApprovalRoute("/s/top.jsonl", fakeUi(async () => undefined).ui);
    registerChildApprovalRoute({ sessionPath: "/s/a.jsonl", parentSessionPath: "/s/top.jsonl", agentId: "sa-a", label: "a" });
    await expect(requestApproval("/s/a.jsonl", { title: "t", options: ["拒绝"] })).resolves.toEqual({ outcome: "cancelled" });

    __resetApprovalRoutesForTest();
    const { ui, calls } = fakeUi(neverAnswered);
    registerTopApprovalRoute("/s/top.jsonl", ui);
    registerChildApprovalRoute({ sessionPath: "/s/a.jsonl", parentSessionPath: "/s/top.jsonl", agentId: "sa-a", label: "a" });
    const controller = new AbortController();
    const pending = requestApproval("/s/a.jsonl", { title: "t", options: ["拒绝"], signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ outcome: "cancelled" });
    expect(calls[0].opts.signal?.aborted).toBe(true);

    const already = new AbortController();
    already.abort();
    await expect(requestApproval("/s/a.jsonl", { title: "t", options: ["拒绝"], signal: already.signal })).resolves.toEqual({
      outcome: "cancelled",
    });
    expect(calls).toHaveLength(1);
  });

  it("with nobody above, the request is unavailable instead of hanging", async () => {
    registerChildApprovalRoute({ sessionPath: "/s/a.jsonl", parentSessionPath: "/s/gone.jsonl", agentId: "sa-a", label: "a" });
    await expect(requestApproval("/s/a.jsonl", { title: "t", options: ["拒绝"] })).resolves.toEqual({ outcome: "unavailable" });
    await expect(requestApproval("/s/unknown.jsonl", { title: "t", options: ["拒绝"] })).resolves.toEqual({ outcome: "unavailable" });
    await expect(
      withConfig({ SUBAGENT_APPROVAL_TIMEOUT_MS: "0" }, () => requestApproval("/s/a.jsonl", { title: "t", options: ["拒绝"] })),
    ).resolves.toEqual({ outcome: "unavailable" });
  });

  it("in a worker process, a parent that lives in the host goes upstream with the chain so far", async () => {
    const ask = vi.fn(async (_path: string, _request: unknown) => ({ outcome: "answered" as const, choice: "拒绝" }));
    const reachable = vi.fn(async (_path: string) => true);
    setApprovalUpstream({ ask, reachable });
    registerChildApprovalRoute({ sessionPath: "/s/worker-child.jsonl", parentSessionPath: "/s/host-parent.jsonl", agentId: "sa-w", label: "w" });

    expect(await canRequestApproval("/s/worker-child.jsonl")).toBe(true);
    await expect(requestApproval("/s/worker-child.jsonl", { title: "t", options: ["拒绝"] })).resolves.toEqual({
      outcome: "answered",
      choice: "拒绝",
    });
    expect(reachable).toHaveBeenCalledWith("/s/host-parent.jsonl");
    expect(ask).toHaveBeenCalledWith(
      "/s/host-parent.jsonl",
      expect.objectContaining({ title: "t", chain: [{ agentId: "sa-w", label: "w" }], timeoutMs: 60_000 }),
    );
  });

  it("the host side forwards a worker's request from the worker child's parent", async () => {
    const { ui, calls } = fakeUi(async () => "允许本次");
    registerTopApprovalRoute("/s/top.jsonl", ui);
    const result = await forwardApproval("/s/top.jsonl", {
      title: "t",
      options: ["允许本次"],
      chain: [{ agentId: "sa-w", label: "w" }],
      timeoutMs: 1000,
    });
    expect(result).toEqual({ outcome: "answered", choice: "允许本次" });
    expect(calls[0].title).toBe("子代理 w（sa-w） t");
  });

  it("unregistering only removes the caller's own route", async () => {
    const first = registerTopApprovalRoute("/s/top.jsonl", fakeUi(async () => undefined).ui);
    const second = registerTopApprovalRoute("/s/top.jsonl", fakeUi(async () => undefined).ui);
    first();
    expect(await canForwardApproval("/s/top.jsonl")).toBe(true);
    second();
    expect(await canForwardApproval("/s/top.jsonl")).toBe(false);
  });
});

describe("approval routes · edges", () => {
  afterEach(() => {
    __resetApprovalRoutesForTest();
    vi.useRealTimers();
  });

  it("in a worker, a parent the host cannot ask through means no route, so the main process keeps the pinned deny", async () => {
    setApprovalUpstream({ ask: vi.fn(), reachable: async () => false });
    registerChildApprovalRoute({ sessionPath: "/s/w.jsonl", parentSessionPath: "/s/host-parent.jsonl", agentId: "sa-w", label: "w" });
    expect(await canRequestApproval("/s/w.jsonl")).toBe(false);

    setApprovalUpstream({ ask: vi.fn(), reachable: async () => { throw new Error("worker channel closed"); } });
    expect(await canRequestApproval("/s/w.jsonl")).toBe(false);
  });

  it("a request withdrawn before it is sent never reaches the parent", async () => {
    const ask = vi.fn(async () => ({ outcome: "answered" as const, choice: "允许本次" }));
    setApprovalUpstream({ ask, reachable: async () => true });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      forwardApproval("/s/host-parent.jsonl", { title: "t", options: [], chain: [], timeoutMs: 1000, signal: aborted.signal }),
    ).resolves.toEqual({ outcome: "cancelled" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("a ui that ignores the abort signal still cannot hold the child past the timeout", async () => {
    vi.useFakeTimers();
    registerTopApprovalRoute("/s/top.jsonl", { select: () => new Promise(() => {}) });
    registerChildApprovalRoute({ sessionPath: "/s/a.jsonl", parentSessionPath: "/s/top.jsonl", agentId: "sa-a", label: "a" });
    const pending = withConfig({ SUBAGENT_APPROVAL_TIMEOUT_MS: "5000" }, () =>
      requestApproval("/s/a.jsonl", { title: "t", options: ["拒绝"] }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({ outcome: "timeout" });
  });
});
