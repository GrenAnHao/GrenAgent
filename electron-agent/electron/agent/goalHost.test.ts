import { describe, expect, it, vi } from 'vitest';
import { GoalHost } from './goalHost.js';

function fakeHandle(sessionPath: string, sessionId: string) {
  return {
    session: { sessionId, sessionFile: sessionPath, abort: vi.fn(async () => {}), waitForIdle: vi.fn(async () => {}) },
    dispose: vi.fn(async () => {}),
    currentTurnOrigin: 'goal' as const,
  };
}

describe('GoalHost', () => {
  it('同一 workspace+sessionId 只构造一次', async () => {
    const created: string[] = [];
    const host = new GoalHost({
      create: async (workspace, sessionId, sessionPath) => {
        created.push(`${workspace}\0${sessionId}\0${sessionPath}`);
        return fakeHandle(sessionPath, sessionId) as never;
      },
    });
    const a = await host.open('D:/a', 's1', 'D:/a/s1.jsonl');
    const b = await host.open('D:/a', 's1', 'D:/a/s1.jsonl');
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
  });

  it('findBySessionPath 按规范化路径查找', async () => {
    const host = new GoalHost({ create: async (_w, id, p) => fakeHandle(p, id) as never });
    await host.open('D:/a', 's1', 'D:/a/s1.jsonl');
    expect(host.findBySessionPath('D:/a/s1.jsonl')?.sessionId).toBe('s1');
    expect(host.findBySessionPath('D:/a/other.jsonl')).toBeUndefined();
  });

  it('dispose 后可以重新 open', async () => {
    const first = fakeHandle('D:/a/s1.jsonl', 's1');
    const second = fakeHandle('D:/a/s1.jsonl', 's1');
    let n = 0;
    const host = new GoalHost({ create: async () => (n++ === 0 ? first : second) as never });
    await host.open('D:/a', 's1', 'D:/a/s1.jsonl');
    await host.dispose('D:/a', 's1');
    expect(first.dispose).toHaveBeenCalled();
    const again = await host.open('D:/a', 's1', 'D:/a/s1.jsonl');
    expect(again).toBe(second);
    expect(again).not.toBe(first);
  });

  it('disposeAllForWorkspace 只关该项目', async () => {
    const a = fakeHandle('D:/a/s1.jsonl', 's1');
    const b = fakeHandle('D:/b/s2.jsonl', 's2');
    const host = new GoalHost({
      create: async (workspace) => (workspace === 'D:/a' ? a : b) as never,
    });
    await host.open('D:/a', 's1', 'D:/a/s1.jsonl');
    await host.open('D:/b', 's2', 'D:/b/s2.jsonl');
    await host.disposeAllForWorkspace('D:/a');
    expect(a.dispose).toHaveBeenCalled();
    expect(b.dispose).not.toHaveBeenCalled();
  });
});
