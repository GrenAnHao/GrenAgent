import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn() }));
import { getConfig } from "../_shared/runtime-config.js";
import { assertDepthAllowed, childDepthOf, DEFAULT_MAX_DEPTH, readMaxDepth, resolveDelegationDepth } from "./depth.js";

const cfg = (map: Record<string, string | undefined>) => vi.mocked(getConfig).mockImplementation((k: string) => map[k]);
const metaCtx = (depth?: number) => ({
  sessionManager: {
    getEntries: () => [
      { type: "message" },
      { type: "custom", customType: "subagent_meta", data: { origin: "subagent", ...(depth === undefined ? {} : { depth }) } },
    ],
  },
});

beforeEach(() => vi.resetAllMocks());

describe("resolveDelegationDepth", () => {
  it("top-level session with no meta and no env is 0", () => {
    cfg({});
    expect(resolveDelegationDepth({ sessionManager: { getEntries: () => [] } })).toBe(0);
  });
  it("takes max(meta.depth, SUBAGENT_DEPTH)", () => {
    cfg({ SUBAGENT_DEPTH: "1" });
    expect(resolveDelegationDepth(metaCtx(2))).toBe(2);
    cfg({ SUBAGENT_DEPTH: "3" });
    expect(resolveDelegationDepth(metaCtx(2))).toBe(3);
  });
  it("cold resume: env gone, meta still wins", () => {
    cfg({});
    expect(resolveDelegationDepth(metaCtx(2))).toBe(2);
  });
  it("meta without depth counts as 0", () => {
    cfg({});
    expect(resolveDelegationDepth(metaCtx())).toBe(0);
  });
  it("tolerates a sessionManager that throws", () => {
    cfg({ SUBAGENT_DEPTH: "1" });
    expect(resolveDelegationDepth({ sessionManager: { getEntries: () => { throw new Error("x"); } } })).toBe(1);
  });
});

describe("readMaxDepth", () => {
  it("defaults to 2", () => {
    cfg({});
    expect(DEFAULT_MAX_DEPTH).toBe(2);
    expect(readMaxDepth()).toBe(2);
  });
  it("reads a valid integer", () => {
    cfg({ SUBAGENT_MAX_DEPTH: "1" });
    expect(readMaxDepth()).toBe(1);
  });
  it("invalid → default", () => {
    for (const v of ["", "abc", "-1", "1.5"]) {
      cfg({ SUBAGENT_MAX_DEPTH: v });
      expect(readMaxDepth()).toBe(2);
    }
  });
});

describe("childDepthOf / assertDepthAllowed", () => {
  it("child depth is parent + 1", () => {
    cfg({});
    expect(childDepthOf(metaCtx(1))).toBe(2);
  });
  it("assert throws with code DEPTH_EXCEEDED beyond max", () => {
    cfg({ SUBAGENT_MAX_DEPTH: "1" });
    expect(() => assertDepthAllowed(2)).toThrow("已达委派深度上限 1");
    expect(() => assertDepthAllowed(1)).not.toThrow();
  });
});
