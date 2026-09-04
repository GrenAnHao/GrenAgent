import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeGraphInstancePool } from './instancePool';

function fakeClient() {
  return { callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })), close: vi.fn(async () => {}) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('CodeGraphInstancePool', () => {
  it('connects once per workspace and reuses the connection', async () => {
    const clients = [fakeClient(), fakeClient()];
    const connect = vi.fn(async () => clients[connect.mock.calls.length - 1]);
    const pool = new CodeGraphInstancePool({ connect, idleTimeoutMs: 1000 });

    await pool.call('/repo', 'codegraph_search', { query: 'a' });
    await pool.call('/repo', 'codegraph_search', { query: 'b' });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(clients[0].callTool).toHaveBeenCalledTimes(2);
  });

  it('keeps separate connections per workspace', async () => {
    const connect = vi.fn(async () => fakeClient());
    const pool = new CodeGraphInstancePool({ connect, idleTimeoutMs: 1000 });

    await pool.call('/repo-a', 'codegraph_search', {});
    await pool.call('/repo-b', 'codegraph_search', {});

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenNthCalledWith(1, '/repo-a');
    expect(connect).toHaveBeenNthCalledWith(2, '/repo-b');
  });

  it('closes an idle connection after the timeout and reconnects on demand', async () => {
    const clients = [fakeClient(), fakeClient()];
    const connect = vi.fn(async () => clients[connect.mock.calls.length - 1]);
    const pool = new CodeGraphInstancePool({ connect, idleTimeoutMs: 1000 });

    await pool.call('/repo', 'codegraph_search', {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(clients[0].close).toHaveBeenCalledTimes(1);

    await pool.call('/repo', 'codegraph_search', {});
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('invalidates a workspace so the next call sees a fresh index', async () => {
    const clients = [fakeClient(), fakeClient()];
    const connect = vi.fn(async () => clients[connect.mock.calls.length - 1]);
    const pool = new CodeGraphInstancePool({ connect, idleTimeoutMs: 1000 });

    await pool.call('/repo', 'codegraph_search', {});
    await pool.invalidate('/repo');
    expect(clients[0].close).toHaveBeenCalledTimes(1);

    await pool.call('/repo', 'codegraph_search', {});
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed connection', async () => {
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('index not initialized'))
      .mockResolvedValueOnce(fakeClient());
    const pool = new CodeGraphInstancePool({ connect, idleTimeoutMs: 1000 });

    await expect(pool.call('/repo', 'codegraph_search', {})).rejects.toThrow('index not initialized');
    await expect(pool.call('/repo', 'codegraph_search', {})).resolves.toBeDefined();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('closes every connection on shutdown', async () => {
    const clients = [fakeClient(), fakeClient()];
    const connect = vi.fn(async () => clients[connect.mock.calls.length - 1]);
    const pool = new CodeGraphInstancePool({ connect, idleTimeoutMs: 1000 });

    await pool.call('/repo-a', 'codegraph_search', {});
    await pool.call('/repo-b', 'codegraph_search', {});
    await pool.closeAll();

    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(clients[1].close).toHaveBeenCalledTimes(1);
  });
});
