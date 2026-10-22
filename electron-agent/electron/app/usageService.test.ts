import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageLedger, callFromMessage } from '../../../extensions/usage-ledger/ledger.js';
import { UsageService } from './usageService';

const directories: string[] = [];
const ledgers: UsageLedger[] = [];
afterEach(async () => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const header = (id: string, cwd = 'C:/work') => JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-08-29T10:00:00Z' });
const assistantMessage = (messageTimestamp: number, totalTokens: number, extra: Record<string, unknown> = {}) => ({
  role: 'assistant', provider: 'openai', model: 'gpt-5', timestamp: messageTimestamp, content: [{ type: 'text', text: 'x'.repeat(200) }],
  usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { total: totalTokens / 100 } }, ...extra,
});
const assistant = (timestamp: string, messageTimestamp: number, totalTokens: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'message', id: `e${messageTimestamp}`, timestamp, message: assistantMessage(messageTimestamp, totalTokens, extra) });
const toolResult = (text: string) => JSON.stringify({ type: 'message', timestamp: '2026-08-30T10:00:01Z', message: { role: 'toolResult', content: [{ type: 'text', text }] } });

async function setup() {
  const agent = await mkdtemp(join(tmpdir(), 'electron-agent-usage-')); directories.push(agent);
  const sessionDir = join(agent, 'sessions', 'hash'); await mkdir(sessionDir, { recursive: true });
  const ledger = new UsageLedger(join(agent, 'usage', 'ledger.db')); ledgers.push(ledger);
  return { agent, sessionDir, ledger, service: new UsageService(agent, { ledger }) };
}

describe('UsageService', () => {
  it('imports history on first report with the old aggregation rules', async () => {
    const { sessionDir, service } = await setup();
    await writeFile(join(sessionDir, 'a.jsonl'), [
      '{"type":"session","id":"s1","cwd":"C:/work","timestamp":"2026-08-29T10:00:00Z","name":"Header"}',
      '{"type":"session_info","name":"Latest"}',
      '{"type":"message","id":"e1","timestamp":"2026-08-30T10:00:00Z","message":{"role":"assistant","provider":"openai","model":"gpt-5","timestamp":1,"usage":{"input":10,"output":5,"cacheRead":4,"cacheWrite":1,"totalTokens":20,"cost":{"total":0.25}}}}',
      '{"type":"message","timestamp":"2026-08-30T11:00:00Z","message":{"role":"user"}}',
    ].join('\n'));
    const report = await service.report();

    expect(report.totals).toEqual({ input: 10, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 20, cost: 0.25, sessions: 1, messages: 1, cacheHitRate: 4 / 14 });
    expect(report.byDay).toEqual([{ date: '2026-08-30', tokens: 20, cost: 0.25 }]);
    expect(report.byModel).toEqual([{ provider: 'openai', model: 'gpt-5', tokens: 20, cost: 0.25, messages: 1 }]);
    expect(report.byProject).toEqual([{ cwd: 'C:/work', name: 'Latest', tokens: 20, cost: 0.25, sessions: 1 }]);
    expect(report.recentSessions[0]).toMatchObject({ id: 's1', name: 'Latest', tokens: 20, cost: 0.25, path: join(sessionDir, 'a.jsonl') });
    expect(report.calls).toEqual([{ timestamp: '2026-08-30T10:00:00Z', provider: 'openai', model: 'gpt-5', input: 10, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 20, cost: 0.25 }]);
  });

  it('ignores usage-looking text inside tool results and non-session files', async () => {
    const { sessionDir, service } = await setup();
    // 工具结果里原样出现 assistant / usage 字样（转义后的 JSON 文本）不能被算成一次调用。
    await writeFile(join(sessionDir, 'a.jsonl'), `${[header('s1'), toolResult(assistant('2026-08-30T10:00:00Z', 1, 999)), assistant('2026-08-30T10:00:02Z', 2, 30)].join('\n')}\n`);
    await writeFile(join(sessionDir, 'b.jsonl'), `${assistant('2026-08-30T10:00:00Z', 3, 50)}\n`);
    const report = await service.report();
    expect(report.totals).toMatchObject({ sessions: 1, messages: 1, totalTokens: 30 });
  });

  it('imports once; later reports read the ledger without rescanning', async () => {
    const { sessionDir, service } = await setup();
    const file = join(sessionDir, 'a.jsonl');
    await writeFile(file, `${header('s1')}\n${assistant('2026-08-30T10:00:00Z', 1, 10)}\n`);
    expect((await service.report()).totals.totalTokens).toBe(10);
    // 文件之后又长了，但没走记账（例如命令行 pi）：报表不扫目录，补录之后才算进去。
    await appendFile(file, `${assistant('2026-08-30T11:00:00Z', 2, 20)}\n`);
    expect((await service.report()).totals.totalTokens).toBe(10);
    expect(await service.reconcile()).toEqual({ files: 1, added: 1 });
    expect((await service.report()).totals.totalTokens).toBe(30);
    expect(await service.reconcile()).toEqual({ files: 1, added: 0 });
  });

  it('does not double count calls that were already recorded live', async () => {
    const { sessionDir, ledger, service } = await setup();
    const withResponse = assistantMessage(1, 10, { responseId: 'resp_1' });
    const withoutResponse = assistantMessage(2, 20);
    for (const message of [withResponse, withoutResponse]) {
      ledger.record(callFromMessage(message, 's1', '2026-08-30T10:00:00.003Z')!, 'live');
    }
    await writeFile(join(sessionDir, 'a.jsonl'), `${[
      header('s1'),
      JSON.stringify({ type: 'message', id: 'e1', timestamp: '2026-08-30T10:00:00.005Z', message: withResponse }),
      JSON.stringify({ type: 'message', id: 'e2', timestamp: '2026-08-30T10:00:00.009Z', message: withoutResponse }),
    ].join('\n')}\n`);
    const report = await service.report();
    expect(report.totals).toMatchObject({ messages: 2, totalTokens: 30 });
  });

  it('keeps usage of rewound or deleted history', async () => {
    const { sessionDir, service } = await setup();
    const file = join(sessionDir, 'a.jsonl');
    await writeFile(file, `${[header('s1'), assistant('2026-08-30T10:00:00Z', 1, 10), assistant('2026-08-30T10:01:00Z', 2, 20)].join('\n')}\n`);
    expect((await service.report()).totals.totalTokens).toBe(30);
    // 回退把第二条截掉、文件又被删：花出去的 token 不会从账上消失。
    await writeFile(file, `${[header('s1'), assistant('2026-08-30T10:00:00Z', 1, 10)].join('\n')}\n`);
    await service.reconcile();
    await rm(file);
    await service.reconcile();
    expect((await service.report()).totals).toMatchObject({ messages: 2, totalTokens: 30 });
  });

  it('shares one import between concurrent requests', async () => {
    const { sessionDir, service } = await setup();
    await writeFile(join(sessionDir, 'a.jsonl'), `${header('s1')}\n${assistant('2026-08-30T10:00:00Z', 1, 10)}\n`);
    const [x, y] = [service.reconcile(), service.reconcile()];
    expect(x).toBe(y);
    await x;
  });
});
