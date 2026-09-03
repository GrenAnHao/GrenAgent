import { describe, expect, it, vi } from "vitest";
import factory from "./index.js";

type Handler = (args: string, ctx: unknown) => Promise<void>;

function setup(control: { request: (...args: unknown[]) => Promise<unknown> } = { request: async () => { throw new Error('offline'); } }) {
  const calls = {
    sendMessage: [] as unknown[][],
    status: [] as unknown[][],
    notify: [] as unknown[][],
    entries: [] as unknown[][],
  };
  const commands: string[] = [];
  const events: string[] = [];
  let handler: Handler | undefined;
  factory({
    registerCommand: (n: string, def: { handler: Handler }) => {
      commands.push(n);
      if (n === "goal") handler = def.handler;
    },
    on: (e: string) => events.push(e),
    appendEntry: (t: string, d: unknown) => calls.entries.push([t, d]),
    sendMessage: (m: unknown, o: unknown) => calls.sendMessage.push([m, o]),
  } as never, control as never);
  const ctx = {
    cwd: 'C:/work',
    ui: {
      notify: (...a: unknown[]) => calls.notify.push(a),
      setStatus: (...a: unknown[]) => calls.status.push(a),
    },
    model: undefined,
    modelRegistry: { find: () => undefined },
  };
  return { handler: handler as Handler, ctx, calls, commands, events };
}

const lastStatus = (calls: { status: unknown[][] }) => calls.status.at(-1) as [string, string | undefined];

describe("goal extension factory", () => {
  it("registers /goal command and session_start/agent_end hooks", () => {
    const { commands, events } = setup();
    expect(commands).toContain("goal");
    expect(events).toEqual(expect.arrayContaining(["session_start", "agent_end"]));
  });

  it("setting a goal drives execution via sendMessage(triggerTurn)", async () => {
    const { handler, ctx, calls } = setup();
    await handler("写完并通过测试", ctx);
    expect(calls.sendMessage).toHaveLength(1);
    const [msg, opts] = calls.sendMessage[0];
    expect(msg).toMatchObject({ content: "写完并通过测试", display: true });
    expect(opts).toEqual({ triggerTurn: true });
    const [key, text] = lastStatus(calls);
    expect(key).toBe("goal");
    expect(JSON.parse(text as string)).toMatchObject({ condition: "写完并通过测试", paused: false });
  });

  it("queues a desktop-managed Turn when the Electron control plane is available", async () => {
    const control = { request: vi.fn(async () => ({ status: 'queued' })) };
    const { handler, ctx, calls } = setup(control);

    await handler("完成统一事件迁移", ctx);

    expect(control.request).toHaveBeenCalledWith('turn.start', expect.objectContaining({ workspace: 'C:/work', input: '完成统一事件迁移' }));
    expect(calls.sendMessage[0]?.[1]).toEqual({ triggerTurn: false });
  });

  it("pause then resume toggles the pushed paused flag", async () => {
    const { handler, ctx, calls } = setup();
    await handler("目标X", ctx);
    await handler("pause", ctx);
    expect(JSON.parse(lastStatus(calls)[1] as string)).toMatchObject({ paused: true });
    await handler("resume", ctx);
    expect(JSON.parse(lastStatus(calls)[1] as string)).toMatchObject({ paused: false });
  });

  it("clear removes the goal (status pushed undefined)", async () => {
    const { handler, ctx, calls } = setup();
    await handler("目标X", ctx);
    await handler("clear", ctx);
    expect(lastStatus(calls)).toEqual(["goal", undefined]);
  });

  it("pause without an active goal warns and drives nothing", async () => {
    const { handler, ctx, calls } = setup();
    await handler("pause", ctx);
    expect(calls.notify.at(-1)).toEqual(["当前没有生效的目标。", "warning"]);
    expect(calls.sendMessage).toHaveLength(0);
  });
});
