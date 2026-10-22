import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callFromMessage, callKey, UsageLedger, type LedgerCall } from "./ledger.js";

const dirs: string[] = [];
const ledgers: UsageLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(): UsageLedger {
  const dir = mkdtempSync(join(tmpdir(), "usage-ledger-"));
  dirs.push(dir);
  const ledger = new UsageLedger(join(dir, "usage", "ledger.db"));
  ledgers.push(ledger);
  return ledger;
}

function call(partial: Partial<LedgerCall>): LedgerCall {
  return {
    sessionId: "s1", timestamp: "2026-08-30T10:00:00.000Z", provider: "openai", model: "gpt-5",
    input: 10, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 20, cost: 0.25,
    responseId: null, messageTimestamp: 1, ...partial,
  };
}

describe("callFromMessage / callKey", () => {
  it("reads assistant usage and ignores everything else", () => {
    const message = { role: "assistant", provider: "openai", model: "gpt-5", responseId: "resp_1", timestamp: 42, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0.5 } } };
    expect(callFromMessage(message, "s1", "2026-08-30T10:00:00Z")).toMatchObject({ sessionId: "s1", provider: "openai", model: "gpt-5", totalTokens: 10, cost: 0.5, responseId: "resp_1", messageTimestamp: 42 });
    expect(callFromMessage({ role: "user", usage: {} }, "s1", null)).toBeNull();
    expect(callFromMessage({ role: "assistant" }, "s1", null)).toBeNull();
  });

  it("prefers the response id, then the message time, then the entry id", () => {
    expect(callKey({ sessionId: "s1", provider: "p", responseId: "r", messageTimestamp: 1 })).toBe("r:p:r");
    expect(callKey({ sessionId: "s1", provider: "p", responseId: null, messageTimestamp: 1 })).toBe("t:s1:1");
    expect(callKey({ sessionId: "s1", provider: "p", responseId: null, messageTimestamp: null, entryId: "e1" })).toBe("e:s1:e1");
    expect(callKey({ sessionId: "s1", provider: "p", responseId: null, messageTimestamp: null })).toBeNull();
  });
});

describe("UsageLedger", () => {
  it("records each call once, whichever side sees it first", () => {
    const ledger = open();
    expect(ledger.record(call({ responseId: "r1" }), "live")).toBe(true);
    // 历史导入、或分叉复制到另一份会话里的同一条调用：同一个 responseId，不再计数。
    expect(ledger.record(call({ responseId: "r1", sessionId: "fork" }), "import")).toBe(false);
    expect(ledger.record(call({ messageTimestamp: 2 }), "import")).toBe(true);
    expect(ledger.record(call({ messageTimestamp: 2 }), "live")).toBe(false);
    expect(ledger.report().totals.messages).toBe(2);
  });

  it("keeps known session fields when a later upsert has nulls", () => {
    const ledger = open();
    ledger.upsertSession({ id: "s1", path: "/a.jsonl", cwd: "C:/work", startedAt: "2026-08-29T10:00:00Z", name: "First" });
    ledger.upsertSession({ id: "s1", path: null, cwd: null, startedAt: "2030-01-01T00:00:00Z", name: null });
    ledger.record(call({}), "live");
    expect(ledger.report().recentSessions).toEqual([{ id: "s1", name: "First", cwd: "C:/work", path: "/a.jsonl", timestamp: "2026-08-29T10:00:00Z", tokens: 20, cost: 0.25 }]);
    ledger.upsertSession({ id: "s1", path: null, cwd: null, startedAt: null, name: "Renamed" });
    expect(ledger.report().recentSessions[0].name).toBe("Renamed");
  });

  it("aggregates by day, model, project, session and call", () => {
    const ledger = open();
    ledger.upsertSession({ id: "s1", path: "/a.jsonl", cwd: "C:/work", startedAt: "2026-08-29T10:00:00Z", name: "Alpha" });
    ledger.upsertSession({ id: "s2", path: "/b.jsonl", cwd: "C:/work", startedAt: "2026-08-31T10:00:00Z", name: "Beta" });
    ledger.upsertSession({ id: "s3", path: "/c.jsonl", cwd: "C:/other", startedAt: "2026-08-30T10:00:00Z", name: null });
    ledger.record(call({ sessionId: "s1", messageTimestamp: 1, timestamp: "2026-08-30T10:00:00Z" }), "live");
    ledger.record(call({ sessionId: "s1", messageTimestamp: 2, timestamp: "2026-08-30T11:00:00Z", model: "gpt-5-mini", totalTokens: 7, cost: 0.1, input: 3, cacheRead: 1 }), "live");
    ledger.record(call({ sessionId: "s2", messageTimestamp: 3, timestamp: "2026-08-31T10:00:00Z" }), "import");
    ledger.record(call({ sessionId: "s3", messageTimestamp: 4, timestamp: "2026-08-31T12:00:00Z", provider: "anthropic", model: "claude", totalTokens: 100, cost: 2 }), "import");

    const report = ledger.report();
    expect(report.totals).toMatchObject({ messages: 4, sessions: 3, totalTokens: 147, input: 33, cacheRead: 13 });
    expect(report.totals.cost).toBeCloseTo(2.6);
    expect(report.totals.cacheHitRate).toBeCloseTo(13 / 46);
    expect(report.byDay.map((d) => [d.date, d.tokens])).toEqual([["2026-08-30", 27], ["2026-08-31", 120]]);
    expect(report.byModel.map((m) => [m.provider, m.model, m.tokens, m.messages])).toEqual([
      ["anthropic", "claude", 100, 1], ["openai", "gpt-5", 40, 2], ["openai", "gpt-5-mini", 7, 1],
    ]);
    expect(report.byProject).toEqual([
      { cwd: "C:/other", name: null, tokens: 100, cost: 2, sessions: 1 },
      { cwd: "C:/work", name: "Alpha", tokens: 47, cost: expect.closeTo(0.6), sessions: 2 },
    ]);
    expect(report.recentSessions.map((s) => s.id)).toEqual(["s2", "s3", "s1"]);
    expect(report.calls.map((c) => c.timestamp)).toEqual(["2026-08-31T12:00:00Z", "2026-08-31T10:00:00Z", "2026-08-30T11:00:00Z", "2026-08-30T10:00:00Z"]);
  });

  it("reports zeros on an empty ledger", () => {
    const report = open().report();
    expect(report.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, sessions: 0, messages: 0, cacheHitRate: 0 });
    expect(report.calls).toEqual([]);
  });

  it("rolls back a failed batch", () => {
    const ledger = open();
    expect(() => ledger.transaction(() => {
      ledger.record(call({ messageTimestamp: 9 }), "import");
      throw new Error("boom");
    })).toThrow("boom");
    expect(ledger.report().totals.messages).toBe(0);
  });
});
