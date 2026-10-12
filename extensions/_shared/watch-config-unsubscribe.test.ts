import { describe, expect, it, vi } from "vitest";

// 每个会话（含每个子代理）都会实例化一遍这些扩展。它们在工厂里订阅 runtime-config，
// 会话结束不退订的话订阅越积越多，每次配置变动都要为已销毁的会话跑一遍回调。
const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
vi.mock("./runtime-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-config.js")>();
  return {
    ...actual,
    watchConfig: vi.fn(() => {
      const off = vi.fn();
      unsubscribes.push(off);
      return off;
    }),
  };
});

/** 只记 on() 注册的处理器，其余 API 都是空实现。 */
function fakePi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const api = new Proxy({} as Record<string, unknown>, {
    get(_target, prop: string) {
      if (prop === "on") {
        return (event: string, handler: (...args: unknown[]) => unknown) => {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        };
      }
      if (prop === "getActiveTools" || prop === "getAllTools") return () => [];
      return () => undefined;
    },
  });
  return { api, fire: (event: string) => Promise.all((handlers.get(event) ?? []).map((h) => h({ type: event }, {}))) };
}

describe.each([
  ["approval", () => import("../approval/index.js")],
  ["agent-mode", () => import("../agent-mode/index.js")],
  ["compaction-policy", () => import("../compaction-policy/index.js")],
])("%s 扩展", (_name, load) => {
  it("会话结束时退订 runtime-config", async () => {
    const { default: factory } = await load();
    const before = unsubscribes.length;
    const pi = fakePi();
    factory(pi.api as never);
    const mine = unsubscribes.slice(before);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((off) => off.mock.calls.length === 0)).toBe(true);
    await pi.fire("session_shutdown");
    expect(mine.every((off) => off.mock.calls.length === 1)).toBe(true);
  });
});
