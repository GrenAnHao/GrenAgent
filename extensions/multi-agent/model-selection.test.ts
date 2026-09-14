import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn() }));
import { getConfig } from "../_shared/runtime-config.js";
import { assertRouteAllowed, assertThinkingLevel, readModelSelectionPolicy, THINKING_LEVELS } from "./model-selection.js";

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
