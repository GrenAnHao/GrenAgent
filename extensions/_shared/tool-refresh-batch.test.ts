import { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { batchToolRefresh, installToolRefreshBatching } from "./tool-refresh-batch.js";

/** 和 pi 的 AgentSession 一样：refreshTools 动作每次现取 this._refreshToolRegistry。 */
function fakeSession() {
  const calls: Array<unknown> = [];
  const session = {
    _refreshToolRegistry(options?: unknown) {
      calls.push(options);
    },
  };
  const refreshTools = () => session._refreshToolRegistry();
  return { session, calls, refreshTools };
}

describe("installToolRefreshBatching", () => {
  it("不在批量里时每次刷新照常立即执行", () => {
    const { session, calls, refreshTools } = fakeSession();
    expect(installToolRefreshBatching(session)).toBe(true);
    refreshTools();
    refreshTools();
    expect(calls).toHaveLength(2);
  });

  it("批量期间无参数的刷新只记下，结束时每个会话刷新一次", () => {
    const a = fakeSession();
    const b = fakeSession();
    installToolRefreshBatching(a.session);
    installToolRefreshBatching(b.session);
    batchToolRefresh(() => {
      for (let i = 0; i < 300; i += 1) a.refreshTools();
      b.refreshTools();
      expect(a.calls).toHaveLength(0);
    });
    expect(a.calls).toEqual([undefined]);
    expect(b.calls).toEqual([undefined]);
  });

  it("带参数的刷新（建运行时、reload）不合并，立即执行", () => {
    const { session, calls } = fakeSession();
    installToolRefreshBatching(session);
    batchToolRefresh(() => {
      session._refreshToolRegistry({ activeToolNames: ["read"] });
      expect(calls).toEqual([{ activeToolNames: ["read"] }]);
    });
    expect(calls).toHaveLength(1);
  });

  it("嵌套批量只在最外层结束时刷新", () => {
    const { session, calls, refreshTools } = fakeSession();
    installToolRefreshBatching(session);
    batchToolRefresh(() => {
      batchToolRefresh(() => refreshTools());
      expect(calls).toHaveLength(0);
      refreshTools();
    });
    expect(calls).toHaveLength(1);
  });

  it("批量里抛错时照样刷新，再把错误抛出去", () => {
    const { session, calls, refreshTools } = fakeSession();
    installToolRefreshBatching(session);
    expect(() => batchToolRefresh(() => {
      refreshTools();
      throw new Error("boom");
    })).toThrow("boom");
    expect(calls).toHaveLength(1);
  });

  it("返回批量函数的返回值", () => {
    expect(batchToolRefresh(() => 42)).toBe(42);
  });

  it("重复安装不会套两层；没有该方法的对象不装", () => {
    const { session, calls, refreshTools } = fakeSession();
    expect(installToolRefreshBatching(session)).toBe(true);
    expect(installToolRefreshBatching(session)).toBe(false);
    batchToolRefresh(() => refreshTools());
    expect(calls).toHaveLength(1);
    expect(installToolRefreshBatching({})).toBe(false);
    expect(installToolRefreshBatching(null)).toBe(false);
  });

  it("没装过的会话不受批量影响", () => {
    const { calls, refreshTools } = fakeSession();
    batchToolRefresh(() => refreshTools());
    expect(calls).toHaveLength(1);
  });

  it("刷新本身抛错不影响其他会话刷新", () => {
    const bad = { _refreshToolRegistry: vi.fn(() => { throw new Error("stale session"); }) };
    const good = fakeSession();
    installToolRefreshBatching(bad);
    installToolRefreshBatching(good.session);
    expect(() => batchToolRefresh(() => {
      bad._refreshToolRegistry();
      good.refreshTools();
    })).toThrow("stale session");
    expect(good.calls).toHaveLength(1);
  });

  it("pi 的 AgentSession 仍然有 _refreshToolRegistry（升级 pi 后改名会在这里失败）", () => {
    expect(typeof (AgentSession.prototype as unknown as { _refreshToolRegistry?: unknown })._refreshToolRegistry).toBe("function");
  });
});
