import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanUsageTitle, standardUsageModel, readUsageFilters } from "./analytics.js";
import { UsageLedger } from "./ledger.js";

let root: string, ledger: UsageLedger, sequence: number;
const options = { worksDir: "D:/Agent/works", now: new Date(2026,10,25,12) };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "usage-dimensions-")); ledger = new UsageLedger(join(root, "ledger.db")); sequence = 0; });
afterEach(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
const session = (id: string, cwd: string | null, name = '{"isNewTopic":true,"title":"登录状态颜色"}') =>
  ledger.upsertSession({ id, cwd, name, path: "/" + id + ".jsonl", startedAt: "2026-11-01" });
function call(id: string, day: string, provider = "openai", model = "gpt-6.1-sol", cost = 1) {
  ledger.record({ sessionId: id, timestamp: new Date(day + "T23:59:59").toISOString(), responseId: "r" + (++sequence), messageTimestamp: sequence, provider, model,
    input: 10, output: 5, cacheRead: 30, cacheWrite: 5, totalTokens: 50, cost, costSource: "provider" }, "live");
}
function warm(id: string, day: string, cost: number) {
  ledger.recordWarm({ sessionId: id, entryId: "w" + (++sequence), kind: "cache_warm", timestamp: new Date(day + "T00:00:00").toISOString(), provider: "relay",
    attributedModel: "openai/gpt-6.1-sol", input: 2, output: 0, cacheRead: 1, cacheWrite: 0, totalTokens: 3, cost, costSource: "catalog" });
}

it("allows the desktop to rank every filtered session without changing the 50-row default", () => {
  session("old-expensive", "D:/Agent/works/old"); call("old-expensive", "2026-11-25", "openai", "gpt-x", 9.25);
  for (let i = 0; i < 55; i++) {
    const id = "new-" + i;
    ledger.upsertSession({ id, cwd:"D:/Agent/works/new", name:id, path:"/" + id + ".jsonl", startedAt:"2026-11-25" });
    call(id, "2026-11-25", "openai", "gpt-x", 0.1);
  }
  session("elsewhere", "/elsewhere"); call("elsewhere", "2026-11-25");
  const scope = { projectId: "global", range: "7d" as const };
  const preview = ledger.report(scope, options).recentSessions;
  expect(preview).toHaveLength(50);
  expect(preview.some(s => s.id === "old-expensive")).toBe(false);
  const full = ledger.report(readUsageFilters({ ...scope, includeAllSessions: true }), options).recentSessions;
  expect(full).toHaveLength(56);
  expect(full.every(s => s.projectId === "global")).toBe(true);
  expect(full.sort((a, b) => b.cost - a.cost)[0]).toMatchObject({ id: "old-expensive", cost: 9.25 });
});

it("uses real directory identity and pools only scratch, unbound and missing sessions; cleans old titles on read", () => {
  session("a", "C:/code/Pi"); session("alias", "c:\\CODE\\Pi\\"); session("b", "C:/old/Pi");
  session("conv1", "d:\\agent\\works\\a"); session("conv2", "D:/Agent/works/b");
  session("missing", null); session("nearby", "D:/Agent/works-local"); session("fork", "/workspace/Foo");
  for (const id of ["a", "alias", "b", "conv1", "conv2", "missing", "orphan", "nearby", "fork"]) call(id, "2026-11-24");
  const r = ledger.report({}, options);
  expect(r.byProject).toHaveLength(5);
  expect(r.byProject.find(p => p.projectId === "global")).toMatchObject({ name: "未归属会话 (全局对话)", sessions: 4, tokens: 200 });
  expect(r.byProject.find(p => p.projectId === "cwd:c:/code/pi")).toMatchObject({ name: "C:/code/Pi", sessions: 2, tokens: 100 });
  expect(new Set(r.projects.map(p => p.name)).size).toBe(5);
  expect(r.projects.map(p => p.name)).toContain("works-local");
  expect(r.recentSessions.every(s => s.name === "登录状态颜色")).toBe(true);
  expect(r.byProject.map(p => p.name)).not.toContain("登录状态颜色");
  const single = ledger.report({ projectId: "global" }, options);
  expect(single.totals).toMatchObject({ sessions: 4, totalTokens: 200 });
  expect(single.recentSessions).toHaveLength(3); // The orphan has no actual session file.
  expect(single.projects).toEqual(r.projects);
  expect(ledger.report({ projectId: "cwd:not-found" }, options).totals.totalTokens).toBe(0);
});

it("applies local calendar ranges and project filters to the entire ledger, not the last 500 calls", () => {
  session("a", "C:/A"); session("b", "C:/B"); session("only-warm", "C:/C");
  ledger.transaction(() => {
    for (let i = 0; i < 505; i++) call("a", "2026-11-19", i % 2 ? "relay" : "openai", i % 2 ? " OPENAI/GPT-6.1-SOL " : "gpt-6.1-sol", 0.5);
    call("a", "2026-11-18"); call("a", "2026-10-26"); call("a", "2026-10-27"); call("a", "2026-11-26");
    call("b", "2026-11-25", "p2", "other", 18);
    warm("a", "2026-11-25", 2); warm("only-warm", "2026-11-25", 9); warm("a", "2026-11-18", 30);
  });
  const report = ledger.report({ range: "7d", projectId: "cwd:c:/a" }, options);
  expect(report.totals).toMatchObject({ sessions: 1, messages: 505, totalTokens: 505 * 50, cost: 252.5 });
  expect(report.byModel).toEqual([{ model: "gpt-6.1-sol", provider: "openai, relay", messages: 505, tokens: 505 * 50, cost: 252.5, recordedCost: 254.5 }]);
  expect(report.byDay.map(d => d.date)).toEqual(Array.from({ length: 7 }, (_, i) => "2026-11-" + (19 + i)));
  expect(report.byDay[0]).toMatchObject({ tokens: 505 * 50, cost: 252.5, messages: 505, cacheHitRate: 0.75 });
  expect(report.byDay[1]).toMatchObject({ tokens: 0, messages: 0, recordedCost: 0, cacheHitRate: 0 });
  expect(report.byDay[6]).toMatchObject({ tokens: 0, messages: 0, cost: 0, recordedCost: 2 });
  expect(report.calls).toHaveLength(500);
  const last = ledger.calls({range:'7d',projectId:'cwd:c:/a',page:26}, options);
  expect(last.total).toBe(505);
  expect(last.rows).toHaveLength(5);
  expect(ledger.calls({range:'7d',projectId:'cwd:c:/a',provider:'openai',model:'gpt-6.1-sol',page:1},options).total).toBe(253);
  expect(report.warmingCalls).toHaveLength(1);
  expect(report.recentSessions).toMatchObject([{ id: "a", tokens: 505 * 50 }]);
  expect(report.recordedCost).toEqual({ assistantCost: 252.5, warmingCost: 2, totalCost: 254.5, sourceBreakdown: { provider: 252.5, catalog: 2, unknown: 0 } });
  for (const dims of [report.byDay, report.byModel, report.byProject]) expect(dims.reduce((sum, d) => sum + d.recordedCost, 0)).toBe(254.5);
  const warmingOnly = ledger.report({ range: "7d", projectId: "cwd:c:/c" }, options);
  expect(warmingOnly.totals).toMatchObject({ sessions: 0, messages: 0, totalTokens: 0, cost: 0 });
  expect(warmingOnly.byModel[0]).toMatchObject({ tokens: 0, cost: 0, recordedCost: 9 });
  expect(warmingOnly.byProject[0]).toMatchObject({ sessions: 0, recordedCost: 9 });
  const thirty = ledger.report({ range: "30d", projectId: "cwd:c:/a" }, options);
  expect(thirty.byDay).toHaveLength(30);
  expect(thirty.byDay[0].date).toBe("2026-10-27");
  expect(thirty.totals.messages).toBe(507);
  expect(ledger.report({}, options).totals.messages).toBe(510);
});

it("never guesses unrelated model identities and never prints broken JSON title envelopes", () => {
  expect(cleanUsageTitle('  {"title":"  修复  ","isNewTopic":true} ')).toBe("修复");
  expect(cleanUsageTitle('{"title":"partial')).toBeNull();
  expect(cleanUsageTitle('{"title": {}}')).toBeNull();
  expect(cleanUsageTitle(" {draft notes} ")).toBe("{draft notes}");
  expect(standardUsageModel("relay", "relay/openai/GPT-6.1-SOL")).toBe("gpt-6.1-sol");
  expect(standardUsageModel("relay", "org/model-2026-01-01")).toBe("org/model-2026-01-01");
  expect(() => readUsageFilters({ range: "3d" })).toThrow();
  expect(() => readUsageFilters({ projectId: [] })).toThrow();
});

it('splits assistant and warming records at local midnight, including the start of a range', () => {
  session('s','/work');
  const midnight = new Date(2026,9,16,0,0,0).getTime();
  for (const offset of [-1,0]) {
    const timestamp = new Date(midnight + offset).toISOString();
    ledger.record({sessionId:'s',responseId:'call'+offset, messageTimestamp:null, provider:'p',model:'model',timestamp,
      input:10,output:0,cacheRead:0,cacheWrite:0,totalTokens:10,cost:1,costSource:'provider'},'live');
    ledger.recordWarm({sessionId:'s',entryId:'warm'+offset,kind:'cache_warm',provider:'p',attributedModel:'model',timestamp,
      input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:2,costSource:'provider'});
  }
  const now = new Date(2026,9,22,12);
  const all = ledger.report({}, {now});
  expect(all.byDay.map(d=>[d.date,d.tokens,d.recordedCost])).toEqual([['2026-10-15',10,3],['2026-10-16',10,3]]);
  const week=ledger.report({range:'7d'}, {now});
  expect(week.byDay[0]).toMatchObject({date:'2026-10-16',tokens:10,recordedCost:3});
  expect(week.recordedCost.totalCost).toBe(3);
  expect(week.calls).toHaveLength(1);
});
