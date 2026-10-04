import { describe, expect, it } from "vitest";
import { DEFAULT_PRUNE_TTL_MS, isCacheCold, lastActivityMs, parsePruneTtlMs } from "./cache-warmth.js";

describe("parsePruneTtlMs", () => {
  it("未设置、空、非法时用 300000", () => {
    expect(parsePruneTtlMs(undefined)).toBe(DEFAULT_PRUNE_TTL_MS);
    expect(parsePruneTtlMs("  ")).toBe(DEFAULT_PRUNE_TTL_MS);
    expect(parsePruneTtlMs("abc")).toBe(DEFAULT_PRUNE_TTL_MS);
    expect(parsePruneTtlMs("-1")).toBe(DEFAULT_PRUNE_TTL_MS);
  });

  it("接受 0 和正数", () => {
    expect(parsePruneTtlMs("0")).toBe(0);
    expect(parsePruneTtlMs("3600000")).toBe(3_600_000);
  });
});

describe("lastActivityMs", () => {
  it("取最后一条助手消息的时间戳", () => {
    const msgs = [
      { role: "assistant", timestamp: 1000 },
      { role: "user", timestamp: 2000 },
      { role: "assistant", timestamp: 3000 },
      { role: "toolResult", timestamp: 4000 },
    ];
    expect(lastActivityMs(msgs, [])).toBe(3000);
  });

  it("cache_warm 条目更晚时以它为准", () => {
    const branch = [{ type: "usage", kind: "cache_warm", timestamp: new Date(5000).toISOString() }];
    expect(lastActivityMs([{ role: "assistant", timestamp: 1000 }], branch)).toBe(5000);
  });

  it("助手消息更晚时以助手消息为准", () => {
    const branch = [{ type: "usage", kind: "cache_warm", timestamp: new Date(500).toISOString() }];
    expect(lastActivityMs([{ role: "assistant", timestamp: 1000 }], branch)).toBe(1000);
  });

  it("其他 usage 条目不算", () => {
    const branch = [{ type: "usage", kind: "other", timestamp: new Date(9000).toISOString() }];
    expect(lastActivityMs([{ role: "assistant", timestamp: 1000 }], branch)).toBe(1000);
  });

  it("都取不到时返回 undefined", () => {
    expect(lastActivityMs([{ role: "assistant" }], [])).toBeUndefined();
    expect(lastActivityMs([], [])).toBeUndefined();
  });
});

describe("isCacheCold", () => {
  it("按 TTL 判断", () => {
    expect(isCacheCold(10_000, 9_000, 5_000)).toBe(false);
    expect(isCacheCold(10_000, 5_000, 5_000)).toBe(true);
  });

  it("没有活动或 TTL 为 0 时为冷", () => {
    expect(isCacheCold(10_000, undefined, 5_000)).toBe(true);
    expect(isCacheCold(10_000, 9_999, 0)).toBe(true);
  });
});
