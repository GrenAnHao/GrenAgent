import { describe, expect, it } from 'vitest';
// @ts-expect-error 脚本是 .mjs，没有类型声明
import { report } from '../../scripts/diag-agentdata-report.mjs';

interface Row { t: string; lag: { maxMs: number }; events?: Record<string, number>; agentData?: { syncMs: number; slow: Array<{ method: string; syncMs: number; nested?: true }>; methods: Array<{ method: string; n: number; syncMs: number; syncMaxMs: number }> } }

const at = (i: number) => new Date(Date.UTC(2026, 9, 17) + i * 10_000).toISOString();
function windows(count: number, make: (i: number) => Partial<Row>): Row[] {
  return Array.from({ length: count }, (_, i) => ({ t: at(i), lag: { maxMs: 35 }, events: { 'pi://event:interactive': 5 }, ...make(i) }));
}
const agentData = (slow: Array<{ method: string; syncMs: number; nested?: true }> = [], syncMs = 20) => ({
  syncMs, slow, methods: [{ method: 'item.upsert', n: 2, syncMs, syncMaxMs: syncMs / 2 }],
});

describe('diag-agentdata-report', () => {
  it('reports NO_DATA before the instrumented version has run', () => {
    expect(report(windows(10, () => ({})))).toMatchObject({ instrumented: false, verdict: 'NO_DATA' });
  });

  it('needs about one active hour before deciding', () => {
    expect(report(windows(100, () => ({ agentData: agentData() })))).toMatchObject({ verdict: 'INSUFFICIENT', activeWindows: 100 });
  });

  it('continues when at least 20% of stall windows contain a top-level AgentData segment of 100ms or more', () => {
    const rows = windows(400, (i) => (i % 40 === 0
      ? { lag: { maxMs: 400 }, agentData: agentData(i % 80 === 0 ? [{ method: 'thread.read', syncMs: 180 }] : []) }
      : { agentData: agentData() }));
    const result = report(rows);
    expect(result).toMatchObject({ verdict: 'CONTINUE', stallWindows: 10, stallWindowsWithAgentData: 5, share: 0.5 });
    expect(result.topMethods[0].method).toBe('item.upsert');
  });

  it('ignores nested segments so a write and the index rebuild inside it are not counted twice', () => {
    const rows = windows(400, (i) => (i % 40 === 0
      ? { lag: { maxMs: 400 }, agentData: agentData([{ method: 'wiki.rebuildPageIndex', syncMs: 150, nested: true }]) }
      : { agentData: agentData() }));
    expect(report(rows)).toMatchObject({ verdict: 'STOP', stallWindowsWithAgentData: 0 });
  });

  it('continues when 200ms AgentData segments happen at least once per active hour even without many stalls', () => {
    const rows = windows(720, (i) => ({ agentData: agentData(i % 300 === 0 ? [{ method: 'wiki.pageWrite', syncMs: 450 }] : []) }));
    expect(report(rows)).toMatchObject({ verdict: 'CONTINUE', bigSegments: 3, bigPerActiveHour: 1.5 });
  });

  it('stops when AgentData only shows small writes', () => {
    const rows = windows(400, (i) => ({ lag: { maxMs: i % 30 === 0 ? 900 : 35 }, agentData: agentData([], 40) }));
    const result = report(rows);
    expect(result).toMatchObject({ verdict: 'STOP', bigSegments: 0 });
    expect(result.activeAgentDataSyncMs.p95).toBe(40);
  });

  it('counts only windows after the first instrumented sample by default', () => {
    const rows = [...windows(5, () => ({ lag: { maxMs: 5_000 } })), ...windows(400, (i) => ({ t: at(i + 5), agentData: agentData() }))];
    expect(report(rows)).toMatchObject({ windows: 400, stallWindows: 0 });
  });
});
