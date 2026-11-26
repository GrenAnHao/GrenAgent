import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceService } from './workspaceService';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const agent = await realpath(await mkdtemp(join(tmpdir(), 'gren-startup-lookup-')));
  dirs.push(agent);
  const svc = new WorkspaceService(agent);
  const project = join(agent, 'project');
  const sessions = join(agent, 'sessions');
  await mkdir(project);
  await mkdir(sessions);
  // Neither entry point may depend on a global/sidebar/project listing.
  for (const name of ['listAllSessions', 'listSessions', 'listProjects'] as const) {
    vi.spyOn(svc, name).mockRejectedValue(new Error('unexpected listing: ' + name));
  }
  const header = (cwd: string) => JSON.stringify({ type: 'session', id: 'id', cwd }) + '\n';
  return { agent, svc, project, sessions, header };
}

describe('startup point lookup', () => {
  it('uses recovered ownership, not the remembered project or the bucket; checks archives and blocks live', async () => {
    const { agent, svc, project, sessions, header } = await fixture();
    const file = join(sessions, 'remembered.jsonl');
    const gate = vi.fn(async () => {});
    gate.mockImplementationOnce(async () => { await writeFile(file, header(project)); });
    svc.setRecoveryGate(gate);
    expect(await svc.lookupStartupSession(file)).toMatchObject({ id: 'id', cwd: project, path: file });
    expect(gate).toHaveBeenCalledWith([file]);
    await writeFile(join(agent, 'archived-sessions.json'), JSON.stringify({ sessions: [file] }));
    expect(await svc.lookupStartupSession(file)).toBeNull();
    await rm(join(agent, 'archived-sessions.json'));
    svc.markSessionPathsBlocked([{ path: file, reason: 'pending' }]);
    await expect(svc.lookupStartupSession(file)).rejects.toThrow('SESSION_TRANSFER_BLOCKED');
    svc.clearSessionPathsBlocked([file]);
    await rm(project, { recursive: true });
    expect(await svc.lookupStartupSession(file)).toBeNull();
    await rm(file);
    expect(await svc.lookupStartupSession(file)).toBeNull();
  });

  it('rejects hidden records, arbitrary JSONL, directory links and non-files', async () => {
    const { svc, project, sessions, header } = await fixture();
    const hidden = join(sessions, 'child.jsonl');
    await writeFile(hidden, header(project) + JSON.stringify({ type: 'custom', customType: 'subagent_meta',
      data: { origin: 'subagent', agentId: 'child', parentSession: null, mode: 'continuable' } }) + '\n');
    expect(await svc.lookupStartupSession(hidden)).toBeNull();
    await writeFile(join(project, 'outside.jsonl'), header(project));
    expect(await svc.lookupStartupSession(join(project, 'outside.jsonl'))).toBeNull();
    await symlink(project, join(sessions, 'alias'), 'junction');
    expect(await svc.lookupStartupSession(join(sessions, 'alias', 'outside.jsonl'))).toBeNull();
    await mkdir(join(sessions, 'dir.jsonl'));
    expect(await svc.lookupStartupSession(join(sessions, 'dir.jsonl'))).toBeNull();
  });

  it('checks only the remembered scratch bucket: archived counts, an outbound transfer does not', async () => {
    const { agent, svc, project, sessions, header } = await fixture();
    const { cwd } = await svc.createConversation();
    const bucket = join(sessions, '--' + cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--');
    await mkdir(bucket);
    await writeFile(join(bucket, 'moved.jsonl'), header(project));
    expect(await svc.startupScratchHasSessions(cwd)).toBe(false);
    const file = join(bucket, 'original.jsonl');
    await writeFile(file, header(cwd));
    await writeFile(join(agent, 'archived-sessions.json'), JSON.stringify({ sessions: [file] }));
    expect(await svc.startupScratchHasSessions(cwd)).toBe(true);
    expect(await svc.startupScratchHasSessions(project)).toBe(true);
    expect(await svc.startupScratchHasSessions(join(cwd, 'nested'))).toBe(true);
  });
});
