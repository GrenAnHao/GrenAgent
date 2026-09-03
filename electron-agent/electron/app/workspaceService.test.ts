import { mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('recreates a missing conversation directory below works', async () => {
    const { service } = await createService();
    const workspace = join(await service.getWorksDir(), 'recreated');

    await expect(service.ensureWorkspace(workspace)).resolves.toBe(workspace);
  });

  it('deletes a conversation directory and only sessions belonging to that conversation', async () => {
    const { service, agentDir } = await createService();
    const conversation = await service.createConversation();
    const sessions = join(agentDir, 'sessions', 'hash');
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, 'conversation.jsonl'), `{"type":"session","cwd":${JSON.stringify(conversation.cwd)}}\n`);
    await writeFile(join(sessions, 'project.jsonl'), '{"type":"session","cwd":"C:/project"}\n');

    await service.deleteConversation(conversation.cwd);
    await expect(service.ensureWorkspace(conversation.cwd)).resolves.toBe(conversation.cwd);
    await expect(readFile(join(sessions, 'project.jsonl'), 'utf8')).resolves.toContain('project');
    await expect(readFile(join(sessions, 'conversation.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('closes an active workspace before deleting its directory', async () => {
    const { service } = await createService();
    const conversation = await service.createConversation();
    const close = vi.fn(async () => {});
    service.setWorkspaceCloser(close);

    await service.deleteConversation(conversation.cwd);

    expect(close).toHaveBeenCalledWith(conversation.cwd);
  });

  it('removes project sessions without deleting the project directory', async () => {
    const { service, agentDir } = await createService();
    const project = join(agentDir, 'project'); await mkdir(project);
    const sessions = join(agentDir, 'sessions', 'hash'); await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, 'project.jsonl'), `{"type":"session","cwd":${JSON.stringify(project)}}\n`);

    await service.removeProject(project);
    await expect(readFile(join(sessions, 'project.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(realpath(project)).resolves.toBe(project);
  });

  it('deletes only a session that belongs to the requested workspace', async () => {
    const { service, agentDir } = await createService();
    const workspace = join(agentDir, 'project'); await mkdir(workspace);
    const sessions = join(agentDir, 'sessions', 'hash'); await mkdir(sessions, { recursive: true });
    const owned = join(sessions, 'owned.jsonl');
    const foreign = join(sessions, 'foreign.jsonl');
    await writeFile(owned, `{"type":"session","cwd":${JSON.stringify(workspace)}}\n`);
    await writeFile(foreign, '{"type":"session","cwd":"C:/other"}\n');

    await service.deleteSession(workspace, owned);
    await expect(readFile(owned, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(service.deleteSession(workspace, foreign)).rejects.toThrow('session does not belong to workspace');
  });
});
