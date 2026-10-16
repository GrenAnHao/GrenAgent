import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), on: vi.fn(), off: vi.fn(), getAppMetrics: () => [] },
  BrowserWindow: { getAllWindows: () => [] },
}));

const { startRuntimeDiag } = await import('./runtimeDiag');
const { agentDataTiming } = await import('./agentData/methodTiming');

function samples(file: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === 'sample');
  } catch { return []; }
}

describe('runtimeDiag sample.agentData', () => {
  let stop: (() => void) | undefined;
  let dir: string | undefined;
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    if (dir) rmSync(dir, { recursive: true, force: true });
    agentDataTiming.drain();
  });

  it('writes AgentData timing into the 10-second sample and omits it for an idle window', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    dir = mkdtempSync(join(tmpdir(), 'runtime-diag-'));
    const file = join(dir, 'runtime-diag.jsonl');
    agentDataTiming.drain();
    stop = startRuntimeDiag(dir);

    agentDataTiming.record('item.upsert', 12, { totalMs: 13 });
    agentDataTiming.record('thread.read', 1_200, { totalMs: 1_201 });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(samples(file)).toHaveLength(1), { timeout: 3_000, interval: 20 });

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(samples(file)).toHaveLength(2), { timeout: 3_000, interval: 20 });

    const [busy, idle] = samples(file);
    expect(busy.agentData).toMatchObject({
      syncMs: 1_212,
      n: 2,
      methods: [{ method: 'thread.read', n: 1, syncMs: 1_200 }, { method: 'item.upsert', n: 1, syncMs: 12 }],
      slow: [{ method: 'thread.read', syncMs: 1_200 }],
    });
    expect(idle).not.toHaveProperty('agentData');
    expect(busy).toHaveProperty('ipc');
  });
});
