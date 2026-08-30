import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from './workspaceService';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createService(): Promise<{ service: WorkspaceService; agentDir: string }> {
  const agentDir = await mkdtemp(join(tmpdir(), 'electron-agent-workspaces-'));
  directories.push(agentDir);
  return { service: new WorkspaceService(agentDir), agentDir };
}

describe('WorkspaceService', () => {
  it('creates conversation directories below the canonical works directory', async () => {
    const { service } = await createService();
    const worksDir = await service.getWorksDir();
    const conversation = await service.createConversation();

    expect(conversation.cwd.startsWith(worksDir)).toBe(true);
    await expect(service.getWorksDir()).resolves.toBe(worksDir);
  });

  it('lists only session JSONL files with a workspace cwd', async () => {
    const { service, agentDir } = await createService();
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'kept.jsonl'), '{"type":"session","id":"one","cwd":"C:/work","timestamp":"2026-08-30T00:00:00Z"}\n');
    await writeFile(join(sessionsDir, 'ignored.jsonl'), '{"type":"session","id":"two"}\n');

    await expect(service.listAllSessions()).resolves.toEqual([
      { id: 'one', path: join(sessionsDir, 'kept.jsonl'), cwd: 'C:/work', timestamp: '2026-08-30T00:00:00Z', name: null },
    ]);
  });

  it('prunes an unused conversation while retaining a session-backed directory and explicit keep item', async () => {
    const { service, agentDir } = await createService();
    const worksDir = await service.getWorksDir();
    const used = join(worksDir, 'used');
    const kept = join(worksDir, 'kept');
    const orphan = join(worksDir, 'orphan');
    await Promise.all([mkdir(used), mkdir(kept), mkdir(orphan)]);
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'used.jsonl'), `{\"type\":\"session\",\"id\":\"one\",\"cwd\":${JSON.stringify(used)}}\n`);

    await expect(service.pruneOrphanConversations([kept])).resolves.toBe(1);
    await expect(service.getWorksDir()).resolves.toBe(worksDir);
    await expect(service.pruneOrphanConversations([used, kept])).resolves.toBe(0);
  });

  it('does not prune a draft conversation created in the current application run', async () => {
    const { service } = await createService();
    const conversation = await service.createConversation();

    await expect(service.pruneOrphanConversations([])).resolves.toBe(0);
    await expect(service.listSessions(conversation.cwd)).resolves.toEqual([]);
  });
});
