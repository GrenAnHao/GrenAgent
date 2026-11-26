import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { UiHistoryService } from './uiHistoryService';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createService(): Promise<{ service: UiHistoryService; workspace: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'electron-agent-ui-history-'));
  directories.push(workspace);
  return { service: new UiHistoryService(async (path) => path), workspace };
}

describe('UiHistoryService', () => {
  it('writes and reads a session history round trip', async () => {
    const { service, workspace } = await createService();
    await service.write(workspace, 'sess-1', '{"a":1}\n{"b":2}\n');
    await expect(service.read(workspace, 'sess-1')).resolves.toBe('{"a":1}\n{"b":2}\n');
  });

  it('returns an empty string for missing history', async () => {
    const { service, workspace } = await createService();
    await expect(service.read(workspace, 'missing')).resolves.toBe('');
  });

  it('overwrites existing session history', async () => {
    const { service, workspace } = await createService();
    await service.write(workspace, 's', 'first');
    await service.write(workspace, 's', 'second');
    await expect(service.read(workspace, 's')).resolves.toBe('second');
  });

  it('appends and replaces UTF-8 history tails and refuses stale or deleted bases', async () => {
    const { service, workspace } = await createService();
    const first = '{"text":"旧行 🌱"}';
    const original = `${first}\n{"text":"等待"}`;
    await service.write(workspace, 's', original);
    const { revision } = await service.readSnapshot(workspace, 's', true);
    expect(revision).toBeTruthy();
    const offset = Buffer.byteLength(original);
    const suffix = '\n{"text":"新行"}';
    const appended = await service.patch(workspace, 's', revision!, offset, suffix);
    expect(appended).toBeTruthy();
    await expect(service.read(workspace, 's')).resolves.toBe(original + suffix);
    await expect(service.patch(workspace, 's', revision!, offset, 'stale')).resolves.toBeNull();
    await expect(service.patch(workspace, 's', appended!, Buffer.byteLength(first), '\n{"text":"完成"}')).resolves.toEqual(expect.any(String));
    await expect(service.read(workspace, 's')).resolves.toBe(first + '\n{"text":"完成"}');
    expect((await stat(join(workspace, '.pi', 'ui-history', 's.jsonl'))).size).toBe(Buffer.byteLength(first + '\n{"text":"完成"}'));
    await service.delete(workspace, 's');
    await expect(service.patch(workspace, 's', appended!, 0, 'stale')).resolves.toBeNull();
    await expect(service.read(workspace, 's')).resolves.toBe('');
  });

  it('deletes history and makes subsequent reads empty', async () => {
    const { service, workspace } = await createService();
    await service.write(workspace, 's', 'value');
    await service.delete(workspace, 's');
    await expect(service.read(workspace, 's')).resolves.toBe('');
  });

  it('accepts deletion of missing history', async () => {
    const { service, workspace } = await createService();
    await expect(service.delete(workspace, 'missing')).resolves.toBeUndefined();
  });

  it('keeps a complete value after concurrent writes', async () => {
    const { service, workspace } = await createService();
    await Promise.all(Array.from({ length: 50 }, (_, index) => service.write(workspace, 's', index % 2 === 0 ? 'AAAA' : 'BBBB')));
    await expect(service.read(workspace, 's')).resolves.toMatch(/^(AAAA|BBBB)$/);
  });

  it('rejects empty and path-like session keys', async () => {
    const { service, workspace } = await createService();
    await expect(service.read(workspace, '')).rejects.toThrow('session_key is required');
    await expect(service.read(workspace, '../evil')).rejects.toThrow('invalid session_key');
    await expect(service.read(workspace, 'a/b')).rejects.toThrow('invalid session_key');
    await expect(service.read(workspace, 'a\\b')).rejects.toThrow('invalid session_key');
  });
});
