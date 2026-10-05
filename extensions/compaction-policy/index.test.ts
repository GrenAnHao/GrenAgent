import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: vi.fn(),
  refreshConfig: vi.fn(),
  watchConfig: vi.fn(() => () => {}),
}));

import { getConfig, refreshConfig, watchConfig } from "../_shared/runtime-config.js";
import { contextExclusionConfigKey } from "./exclusion.js";
import factory from "./index.js";
import { AUTO_COMPACT_RESUME_TEXT, AUTO_COMPACT_RESUME_TYPE } from "./resume.js";

beforeEach(() => {
  vi.mocked(getConfig).mockReset();
  vi.mocked(refreshConfig).mockReset();
  vi.mocked(watchConfig).mockReset().mockImplementation(() => () => {});
});

describe("compaction-policy factory", () => {
  it("registers context/turn_end/agent_end hooks and no slash commands", () => {
    const commands: string[] = [];
    const events: string[] = [];
    factory({
      registerCommand: (n: string) => commands.push(n),
      on: (e: string) => events.push(e),
      appendEntry: () => {},
    } as never);
    expect(commands).toEqual([]);
    expect(events).toEqual(expect.arrayContaining(["context", "turn_end", "agent_end"]));
  });

  it("applies a desktop exclusion pulse from runtime config without a slash prompt", () => {
    const subscribers: Array<(next: Record<string, string>) => void> = [];
    vi.mocked(watchConfig).mockImplementation((cb) => {
      subscribers.push(cb);
      return () => {};
    });
    const entries: unknown[] = [];
    factory({
      registerCommand: () => {},
      on: () => {},
      appendEntry: (_type: string, data: unknown) => {
        entries.push(data);
      },
    } as never);
    const key = contextExclusionConfigKey(process.cwd());
    vi.mocked(getConfig).mockImplementation((name: string) =>
      name === key ? JSON.stringify({ op: "add", ts: 42, rev: 1 }) : undefined,
    );
    for (const cb of subscribers) cb({ [key]: JSON.stringify({ op: "add", ts: 42, rev: 1 }) });
    expect(refreshConfig).toHaveBeenCalled();
    expect(entries).toEqual([{ op: "add", ts: 42 }]);
  });

  it('压缩不再弹确认，占用到 80% 时触发 compact', async () => {
    const confirm = vi.fn(async () => false);
    const compact = vi.fn();
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
    factory({
      registerCommand: () => {},
      on: (e: string, h: (event: unknown, ctx: unknown) => unknown) => {
        handlers[e] = h;
      },
      appendEntry: () => {},
    } as never);
    const ctx = {
      hasUI: true,
      ui: { confirm, setStatus: () => {} },
      getContextUsage: () => ({ percent: 79 }),
      compact,
    };
    await handlers.session_before_compact?.({ reason: 'threshold' }, ctx);
    await handlers.session_before_compact?.({ reason: 'manual' }, ctx);
    expect(confirm).not.toHaveBeenCalled();

    await handlers.turn_end?.({}, ctx);
    expect(compact).not.toHaveBeenCalled();

    ctx.getContextUsage = () => ({ percent: 80 });
    await handlers.turn_end?.({}, ctx);
    await handlers.turn_end?.({}, ctx);
    expect(compact).toHaveBeenCalledTimes(1);

    await handlers.session_compact_failed?.({}, ctx);
    ctx.getContextUsage = () => ({ percent: 96 });
    await handlers.turn_end?.({}, ctx);
    expect(compact).toHaveBeenCalledTimes(1);

    ctx.getContextUsage = () => ({ percent: 40 });
    await handlers.turn_end?.({}, ctx);
    ctx.getContextUsage = () => ({ percent: 85 });
    await handlers.turn_end?.({}, ctx);
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("会话覆盖优先于全局触发值", async () => {
    vi.mocked(getConfig).mockImplementation((name: string) => {
      if (name === "AUTO_COMPACT_PERCENT") return "60";
      if (name === "AUTO_COMPACT_OVERRIDES") return JSON.stringify({ "/s/a.jsonl": 90 });
      return undefined;
    });
    const compact = vi.fn();
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
    factory({
      registerCommand: () => {},
      on: (e: string, h: (event: unknown, ctx: unknown) => unknown) => {
        handlers[e] = h;
      },
      appendEntry: () => {},
    } as never);
    const ctx = {
      ui: { setStatus: () => {} },
      getContextUsage: () => ({ percent: 85 }),
      compact,
      sessionManager: { getSessionFile: () => "/s/a.jsonl" },
    };
    await handlers.turn_end?.({}, ctx);
    expect(compact).not.toHaveBeenCalled();

    ctx.sessionManager = { getSessionFile: () => "/s/other.jsonl" };
    await handlers.turn_end?.({}, ctx);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("desktop pulse 按 session_start 的 ctx.cwd 读键", async () => {
    const subscribers: Array<(next: Record<string, string>) => void> = [];
    vi.mocked(watchConfig).mockImplementation((cb) => {
      subscribers.push(cb);
      return () => {};
    });
    const entries: unknown[] = [];
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
    factory({
      registerCommand: () => {},
      on: (e: string, h: (event: unknown, ctx: unknown) => unknown) => {
        handlers[e] = h;
      },
      appendEntry: (_type: string, data: unknown) => {
        entries.push(data);
      },
    } as never);
    await handlers.session_start?.({}, { cwd: "D:/proj-a", sessionManager: { getEntries: () => [] } });
    const key = contextExclusionConfigKey("D:/proj-a");
    vi.mocked(getConfig).mockImplementation((name: string) =>
      name === key ? JSON.stringify({ op: "add", ts: 42, rev: 1 }) : undefined,
    );
    for (const cb of subscribers) cb({ [key]: JSON.stringify({ op: "add", ts: 42, rev: 1 }) });
    expect(entries).toEqual([{ op: "add", ts: 42 }]);
  });

  it("进行中的自动压缩结束后用隐藏消息续跑，自然结束则不续跑", async () => {
    const sendMessage = vi.fn();
    const compact = vi.fn();
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
    factory({
      registerCommand: () => {},
      on: (e: string, h: (event: unknown, ctx: unknown) => unknown) => {
        handlers[e] = h;
      },
      appendEntry: () => {},
      sendMessage,
    } as never);
    const ctx = {
      ui: { setStatus: () => {} },
      getContextUsage: () => ({ percent: 80 }),
      compact,
      hasPendingMessages: () => false,
    };

    await handlers.turn_end?.({
      message: { stopReason: "toolUse" },
      toolResults: [{ role: "toolResult" }],
    }, ctx);
    const options = compact.mock.calls[0]?.[0] as { onComplete?: () => void; onError?: (error: Error) => void };
    options.onComplete?.();
    expect(sendMessage).toHaveBeenCalledWith(
      { customType: AUTO_COMPACT_RESUME_TYPE, content: AUTO_COMPACT_RESUME_TEXT, display: false },
      { triggerTurn: true },
    );

    sendMessage.mockClear();
    ctx.getContextUsage = () => ({ percent: 40 });
    await handlers.turn_end?.({}, ctx);
    ctx.getContextUsage = () => ({ percent: 85 });
    await handlers.turn_end?.({ message: { stopReason: "stop" }, toolResults: [] }, ctx);
    const settled = compact.mock.calls.at(-1)?.[0] as { onComplete?: () => void };
    settled.onComplete?.();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("压缩被取消时不续跑，其它失败仍续跑", async () => {
    const sendMessage = vi.fn();
    const compact = vi.fn();
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
    factory({
      registerCommand: () => {},
      on: (e: string, h: (event: unknown, ctx: unknown) => unknown) => {
        handlers[e] = h;
      },
      appendEntry: () => {},
      sendMessage,
    } as never);
    const ctx = {
      ui: { setStatus: () => {} },
      getContextUsage: () => ({ percent: 90 }),
      compact,
      hasPendingMessages: () => true,
    };
    await handlers.turn_end?.({ message: { stopReason: "stop" }, toolResults: [] }, ctx);
    const options = compact.mock.calls[0]?.[0] as { onError?: (error: Error) => void };
    options.onError?.(new Error("Compaction cancelled"));
    expect(sendMessage).not.toHaveBeenCalled();

    ctx.getContextUsage = () => ({ percent: 40 });
    await handlers.turn_end?.({}, ctx);
    ctx.getContextUsage = () => ({ percent: 90 });
    await handlers.turn_end?.({ message: { stopReason: "length" }, toolResults: [] }, ctx);
    const failed = compact.mock.calls.at(-1)?.[0] as { onError?: (error: Error) => void };
    failed.onError?.(new Error("Nothing to compact (session too small)"));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("compaction-policy context 钩子按压力裁剪", () => {
  type Msg = { role: string; content: unknown; toolCallId?: string; toolName?: string; timestamp?: number };
  type Handler = (event: unknown, ctx: unknown) => unknown;

  const setup = () => {
    const handlers: Record<string, Handler> = {};
    factory({
      registerCommand: () => {},
      on: (e: string, h: Handler) => {
        handlers[e] = h;
      },
      appendEntry: () => {},
    } as never);
    return handlers;
  };

  const tr = (id: string, text: string): Msg => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
  });

  // 默认保留 6 轮。old 在保护范围之前，且 near1 + near2 已用掉 158000 字符的近期额度。
  const conversation = (lastAssistantTs: number): Msg[] => {
    const msgs: Msg[] = [
      { role: "user", content: "u0" },
      { role: "assistant", content: [], timestamp: lastAssistantTs - 1 },
      tr("old", "o".repeat(5000)),
      tr("near1", "n".repeat(79_000)),
      tr("near2", "m".repeat(79_000)),
    ];
    for (let i = 1; i <= 6; i++) {
      msgs.push({ role: "user", content: `u${i}` });
      msgs.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }], timestamp: lastAssistantTs });
    }
    return msgs;
  };

  const ctxWith = (percent: number) => ({
    getContextUsage: () => ({ tokens: percent * 2000, contextWindow: 200_000, percent }),
    sessionManager: { getBranch: () => [] },
    ui: { setStatus: () => {} },
  });

  const textAt = (res: unknown, i: number) =>
    ((res as { messages: Msg[] }).messages[i].content as Array<{ text: string }>)[0].text;

  it("未设置开关时按压力裁；热请求沿用冷时的裁法；session_compact 后清空", async () => {
    vi.mocked(getConfig).mockImplementation(() => undefined);
    const handlers = setup();
    const old = Date.now() - 10 * 60_000;

    const first = await handlers.context?.({ messages: conversation(old) }, ctxWith(60));
    const trimmed = textAt(first, 2);
    expect(trimmed).toContain("[... trimmed, removed");

    const warmMsgs = [...conversation(old), { role: "assistant", content: [], timestamp: Date.now() }];
    const second = await handlers.context?.({ messages: warmMsgs }, ctxWith(10));
    expect(textAt(second, 2)).toBe(trimmed);

    await handlers.session_compact?.({}, ctxWith(10));
    const third = await handlers.context?.({ messages: warmMsgs }, ctxWith(90));
    expect(third).toBeUndefined();
  });

  it("COMPACTION_POLICY_PRUNE=0 时高占用也不裁，熔断仍作用于保护范围内的超大结果", async () => {
    vi.mocked(getConfig).mockImplementation((name: string) => (name === "COMPACTION_POLICY_PRUNE" ? "0" : undefined));
    const handlers = setup();
    const old = Date.now() - 10 * 60_000;
    const msgs = [...conversation(old), tr("bomb", "x".repeat(100_000))];
    const res = await handlers.context?.({ messages: msgs }, ctxWith(95));
    expect(textAt(res, 2)).toBe("o".repeat(5000));
    expect(textAt(res, msgs.length - 1)).toMatch(/truncated tool output: bash, 100000 chars/);
  });
});
