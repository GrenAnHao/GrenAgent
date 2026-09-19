import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: vi.fn(),
  refreshConfig: vi.fn(),
  watchConfig: vi.fn(() => () => {}),
}));

import { getConfig, refreshConfig, watchConfig } from "../_shared/runtime-config.js";
import { contextExclusionConfigKey } from "./exclusion.js";
import factory from "./index.js";

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
});
