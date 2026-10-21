import { describe, expect, it } from 'vitest';
import { codeIndexPresentation, codeIndexSyncActive } from './codeIndexPresentation';

const ws = 'D:/a';
const ready = { workspace: ws, connected: true, indexed: true, state: 'indexed' } as const;
describe('codeIndexPresentation', () => {
  it.each([
    [{ workspace: ws, connected: true, indexed: true, state: 'indexed' }, '已索引', undefined, true, 'sync'],
    [{ workspace: ws, connected: true, indexed: true, state: 'stale' }, '索引过期', 'warning', true, 'sync'],
    [{ workspace: ws, connected: true, indexed: true, state: 'partial' }, '索引不完整', 'warning', true, 'sync'],
    [{ workspace: ws, connected: true, indexed: true, state: 'failed', message: 'boom' }, '索引失败', 'error', true, 'sync'],
    [{ workspace: ws, connected: true, indexed: true, state: 'indexing' }, '索引中', 'info', false, 'none'],
    [{ workspace: ws, connected: false, indexed: false, state: 'unavailable' }, '未索引', undefined, false, 'build'],
    [{ workspace: ws, connected: false, indexed: false, sdkAvailable: false, state: 'sdk_unavailable' }, 'SDK 不可用', 'error', false, 'none'],
    // 增量同步期间：照常可查，只在标签上说明
    [{ ...ready, phase: 'syncing' }, '同步中', undefined, true, 'sync'],
    [{ ...ready, phase: 'queued' }, '同步中', undefined, true, 'sync'],
    // 全量重建期间 state 是 indexing，不可查
    [{ ...ready, state: 'indexing', phase: 'rebuilding' }, '索引中', 'info', false, 'none'],
  ] as const)('maps %o', (status, label, banner, canQuery, primary) => {
    const view = codeIndexPresentation({ status, checking: false });
    expect(view.label).toBe(label);
    expect(view.banner?.type).toBe(banner);
    expect(view.canQuery).toBe(canQuery);
    expect(view.primary).toBe(primary);
  });

  it('explains automatic retries and the breaker on a failed sync', () => {
    const backoff = codeIndexPresentation({ now: 0, checking: false, status: { ...ready, state: 'failed', message: 'parse exploded', phase: 'backoff', consecutiveFailures: 2, nextRetryAt: 60_000 } });
    expect(backoff).toMatchObject({ label: '索引失败', canQuery: true, banner: { type: 'error', message: 'parse exploded（已连续失败 2 次，约 1 分钟后自动重试）', sync: true } });
    const soon = codeIndexPresentation({ now: 0, checking: false, status: { ...ready, state: 'failed', message: 'x', phase: 'backoff', consecutiveFailures: 1, nextRetryAt: 30_000 } });
    expect(soon.banner?.message).toBe('x（已连续失败 1 次，30 秒后自动重试）');
    const breaker = codeIndexPresentation({ checking: false, status: { ...ready, state: 'failed', message: 'x', phase: 'failed', consecutiveFailures: 6 } });
    expect(breaker.banner?.message).toBe('x（已连续失败 6 次，自动同步已暂停；修改文件或手动同步后再试）');
  });

  it('shows lock contention by another program as a wait, not a failure', () => {
    const view = codeIndexPresentation({ now: 0, checking: false, status: { ...ready, phase: 'backoff', lastError: { message: 'locked', at: 0, code: 'CODEGRAPH_LOCKED' }, nextRetryAt: 20_000 } });
    expect(view).toMatchObject({ label: '等待重试', color: 'warning', canQuery: true, banner: { type: 'warning', message: '另一个程序正在写这个项目的索引（codegraph.lock），20 秒后自动重试' } });
  });

  it('warns when the file watcher is unavailable, unless auto sync is turned off', () => {
    const degraded = { ...ready, autoSync: true, watcher: { active: false, degraded: true, reason: 'EMFILE' } };
    expect(codeIndexPresentation({ checking: false, status: degraded })).toMatchObject({ label: '已索引', banner: { type: 'warning', message: '文件监听不可用（EMFILE），索引不会自动跟上改动，需要时请手动同步', sync: true } });
    expect(codeIndexPresentation({ checking: false, status: { ...degraded, autoSync: false } }).banner).toBeUndefined();
  });

  it('polls only while the scheduler is moving', () => {
    expect(['syncing', 'queued', 'rebuilding', 'backoff'].map((phase) => codeIndexSyncActive({ ...ready, phase: phase as never }))).toEqual([true, true, true, true]);
    expect(['idle', 'failed', undefined].map((phase) => codeIndexSyncActive({ ...ready, phase: phase as never }))).toEqual([false, false, false]);
  });

  it('reports checking and read errors', () => {
    expect(codeIndexPresentation({ checking: true })).toMatchObject({ label: '检查中', canQuery: false, primary: 'none' });
    expect(codeIndexPresentation({ checking: false, error: '断开' })).toMatchObject({ label: '未获取', banner: { type: 'error' }, primary: 'none' });
  });
});
