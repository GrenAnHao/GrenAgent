import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn() }));
import { getConfig } from "../_shared/runtime-config.js";
import { assertRouteAllowed, assertThinkingLevel, readModelSelectionPolicy, resolveRouteAlias, THINKING_LEVELS } from "./model-selection.js";

function cfg(map: Record<string, string | undefined>): void {
  vi.mocked(getConfig).mockImplementation((k: string) => map[k]);
}

const model = (provider: string, id: string, reasoning = false) => ({ provider, id, name: id, reasoning }) as never;

beforeEach(() => vi.resetAllMocks());

describe("readModelSelectionPolicy", () => {
  it("disabled when switch off even with allowlist", () => {
    cfg({ SUBAGENT_MODEL_SELECTION: "0", SUBAGENT_MODEL_ALLOWLIST: '["a/b"]' });
    expect(readModelSelectionPolicy().enabled).toBe(false);
  });
  it("disabled when switch on but allowlist empty", () => {
    cfg({ SUBAGENT_MODEL_SELECTION: "1", SUBAGENT_MODEL_ALLOWLIST: "[]" });
    expect(readModelSelectionPolicy().enabled).toBe(false);
  });
  it("enabled with '1' or 'true' and a non-empty list", () => {
    cfg({ SUBAGENT_MODEL_SELECTION: "true", SUBAGENT_MODEL_ALLOWLIST: '["a/b"," c/d "]' });
    const p = readModelSelectionPolicy();
    expect(p.enabled).toBe(true);
    expect([...p.allowlist]).toEqual(["a/b", "c/d"]);
  });
  it("bad JSON → empty list → disabled", () => {
    cfg({ SUBAGENT_MODEL_SELECTION: "1", SUBAGENT_MODEL_ALLOWLIST: "not json" });
    expect(readModelSelectionPolicy().enabled).toBe(false);
  });
  it("allowlist is re-read on every access; enabled stays as decided at load", () => {
    cfg({ SUBAGENT_MODEL_SELECTION: "1", SUBAGENT_MODEL_ALLOWLIST: '["a/b"]' });
    const p = readModelSelectionPolicy();
    cfg({ SUBAGENT_MODEL_SELECTION: "1", SUBAGENT_MODEL_ALLOWLIST: '["c/d"]' });
    expect([...p.allowlist]).toEqual(["c/d"]);
    expect(p.enabled).toBe(true);
  });
  it("turning the switch off empties the live allowlist", () => {
    cfg({ SUBAGENT_MODEL_SELECTION: "1", SUBAGENT_MODEL_ALLOWLIST: '["a/b"]' });
    const p = readModelSelectionPolicy();
    cfg({ SUBAGENT_MODEL_SELECTION: "0", SUBAGENT_MODEL_ALLOWLIST: '["a/b"]' });
    expect(p.allowlist.size).toBe(0);
  });
});

describe("resolveRouteAlias", () => {
  it("maps cheap / strong to their settings and passes literal routes through", () => {
    cfg({ SUBAGENT_MODEL_CHEAP: "deepseek/flash", SUBAGENT_MODEL_STRONG: "c/sonnet" });
    expect(resolveRouteAlias("cheap")).toBe("deepseek/flash");
    expect(resolveRouteAlias("strong")).toBe("c/sonnet");
    expect(resolveRouteAlias("a/b")).toBe("a/b");
  });
  it("falls back to SUBAGENT_MODEL, and is undefined when nothing is configured", () => {
    cfg({ SUBAGENT_MODEL: "x/y" });
    expect(resolveRouteAlias("cheap")).toBe("x/y");
    cfg({});
    expect(resolveRouteAlias("strong")).toBeUndefined();
  });
  it("is undefined when the policy inherits the parent model", () => {
    cfg({ SUBAGENT_MODE: "inherit", SUBAGENT_MODEL_CHEAP: "deepseek/flash" });
    expect(resolveRouteAlias("cheap")).toBeUndefined();
  });
});

describe("assertRouteAllowed", () => {
  const policy = { enabled: true, allowlist: new Set(["a/b"]) };
  it("rejects a route outside the allowlist", () => {
    expect(() => assertRouteAllowed("x/y", policy, [model("x", "y")])).toThrow("路由 x/y 不在授权白名单");
  });
  it("rejects an allowlisted route that is not available", () => {
    expect(() => assertRouteAllowed("a/b", policy, [])).toThrow("路由 a/b 当前不可用");
  });
  it("passes an allowlisted, available route", () => {
    expect(() => assertRouteAllowed("a/b", policy, [model("a", "b")])).not.toThrow();
  });
  it("cheap / strong skip the allowlist and the catalog when they resolve", () => {
    cfg({ SUBAGENT_MODEL_CHEAP: "deepseek/flash" });
    expect(() => assertRouteAllowed("cheap", policy, [])).not.toThrow();
  });
  it("an alias that resolves to nothing is an explicit error, not a silent fallback", () => {
    cfg({});
    expect(() => assertRouteAllowed("strong", policy, [])).toThrow("别名 strong 没有对应模型");
  });
});

describe("assertThinkingLevel", () => {
  it("rejects a non-enum level", () => {
    expect(() => assertThinkingLevel("turbo", model("a", "b", true))).toThrow("thinking_level 无效");
  });
  it("rejects a non-off level on a model without reasoning", () => {
    expect(() => assertThinkingLevel("medium", model("a", "b", false))).toThrow("模型 a/b 不支持思考档");
  });
  it("accepts off on a model without reasoning", () => {
    expect(() => assertThinkingLevel("off", model("a", "b", false))).not.toThrow();
  });
  it("accepts high on a reasoning model", () => {
    expect(() => assertThinkingLevel("high", model("a", "b", true))).not.toThrow();
  });
  it("rejects a level the model maps to null", () => {
    const m = { ...(model("a", "b", true) as object), thinkingLevelMap: { xhigh: null } } as never;
    expect(() => assertThinkingLevel("xhigh", m)).toThrow("模型 a/b 不支持思考档 xhigh");
  });
  it("exports the SDK enum", () => {
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});
