import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageService } from './usageService';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('UsageService', () => {
  it('aggregates persisted assistant usage by day, model, project, session, and call', async () => {
    const agent = await mkdtemp(join(tmpdir(), 'electron-agent-usage-')); directories.push(agent);
    const sessionDir = join(agent, 'sessions', 'hash'); await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'a.jsonl'), [
      '{"type":"session","id":"s1","cwd":"C:/work","timestamp":"2026-08-29T10:00:00Z","name":"Header"}',
      '{"type":"session_info","name":"Latest"}',
      '{"type":"message","timestamp":"2026-08-30T10:00:00Z","message":{"role":"assistant","provider":"openai","model":"gpt-5","usage":{"input":10,"output":5,"cacheRead":4,"cacheWrite":1,"totalTokens":20,"cost":{"total":0.25}}}}',
      '{"type":"message","timestamp":"2026-08-30T11:00:00Z","message":{"role":"user"}}',
    ].join('\n'));
    const report = await new UsageService(agent).report();

    expect(report.totals).toEqual({ input: 10, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 20, cost: 0.25, sessions: 1, messages: 1, cacheHitRate: 4 / 14 });
    expect(report.byDay).toEqual([{ date: '2026-08-30', tokens: 20, cost: 0.25 }]);
    expect(report.byModel).toEqual([{ provider: 'openai', model: 'gpt-5', tokens: 20, cost: 0.25, messages: 1 }]);
    expect(report.byProject).toEqual([{ cwd: 'C:/work', name: 'Latest', tokens: 20, cost: 0.25, sessions: 1 }]);
    expect(report.recentSessions[0]).toMatchObject({ id: 's1', name: 'Latest', tokens: 20, cost: 0.25 });
    expect(report.calls).toEqual([{ timestamp: '2026-08-30T10:00:00Z', provider: 'openai', model: 'gpt-5', input: 10, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 20, cost: 0.25 }]);
  });
});
