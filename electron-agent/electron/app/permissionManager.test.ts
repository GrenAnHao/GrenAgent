import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionManager, type PermissionProvider } from './permissionManager';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(providers: PermissionProvider[] = []) {
  const dataDir = await mkdtemp(join(tmpdir(), 'electron-agent-permissions-'));
  directories.push(dataDir);
  const publish = vi.fn();
  return { dataDir, publish, manager: new PermissionManager({ dataDir, providers, publish, now: () => 42 }) };
}

describe('PermissionManager', () => {
  it('denies filesystem writes and process execution for readonly', async () => {
    const { manager } = await fixture();

    await expect(manager.evaluate({ kind: 'filesystem.write', workspace: 'C:/repo', path: 'C:/repo/a.ts' }, 'readonly')).resolves.toBe('deny');
    await expect(manager.evaluate({ kind: 'process.execute', workspace: 'C:/repo' }, 'readonly')).resolves.toBe('deny');
    await expect(manager.evaluate({ kind: 'filesystem.read', workspace: 'C:/repo', path: 'C:/repo/a.ts' }, 'readonly')).resolves.toBe('allow');
    await expect(manager.evaluate({ kind: 'network.request', workspace: 'C:/repo', url: 'https://example.com' }, 'readonly')).resolves.toBe('deny');
  });

  it('limits workspace filesystem access to the workspace root', async () => {
    const { manager } = await fixture();

    await expect(manager.evaluate({ kind: 'filesystem.write', workspace: 'C:/repo', path: 'C:/repo/src/a.ts' }, 'workspace')).resolves.toBe('allow');
    await expect(manager.evaluate({ kind: 'filesystem.read', workspace: 'C:/repo', path: 'C:/other/secret.txt' }, 'workspace')).resolves.toBe('deny');
  });

  it('runs providers in order and preserves the strictest decision', async () => {
    const calls: string[] = [];
    const providers: PermissionProvider[] = [
      { name: 'approval', evaluate: async () => { calls.push('approval'); return 'allow'; } },
      { name: 'safety', evaluate: async () => { calls.push('safety'); return 'ask'; } },
      { name: 'mcp-policy', evaluate: async () => { calls.push('mcp-policy'); return 'deny'; } },
      { name: 'workspace-trust', evaluate: async () => { calls.push('workspace-trust'); return 'allow'; } },
    ];
    const { manager } = await fixture(providers);

    await expect(manager.evaluate({ kind: 'mcp.call', workspace: 'C:/repo', toolName: 'mcp__fs__read' }, 'interactive')).resolves.toBe('deny');
    expect(calls).toEqual(['approval', 'safety', 'mcp-policy', 'workspace-trust']);
  });

  it('turns an automation ask into a persisted blocked request and resolves it with events', async () => {
    const { dataDir, manager, publish } = await fixture([{ name: 'approval', evaluate: async () => 'ask' }]);

    const result = await manager.authorize({ kind: 'web.search', workspace: 'C:/repo', mode: 'automation' }, 'automation');

    expect(result).toMatchObject({ status: 'blocked', decision: 'ask', request: { operation: { kind: 'web.search' } } });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'permission.requested' }));
    await manager.resolve(result.request!.id, 'deny');
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'permission.resolved', data: expect.objectContaining({ resolution: 'deny' }) }));

    const records = (await readFile(join(dataDir, 'permission-audit.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toEqual([
      expect.objectContaining({ type: 'requested', requestId: result.request!.id }),
      expect.objectContaining({ type: 'resolved', requestId: result.request!.id, resolution: 'deny' }),
    ]);
  });
});
