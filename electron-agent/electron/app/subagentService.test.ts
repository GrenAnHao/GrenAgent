import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SubagentService } from './subagentService';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function createRegistry(withTranscript = true): Promise<{ workspace: string; db: DatabaseSync }> {
  const workspace = await mkdtemp(join(tmpdir(), 'electron-agent-subagent-'));
  directories.push(workspace);
  const folder = join(workspace, '.pi', 'subagents');
  await mkdir(folder, { recursive: true });
  const db = new DatabaseSync(join(folder, 'registry.db'));
  db.exec(`CREATE TABLE subagents (
    id TEXT PRIMARY KEY, task TEXT NOT NULL, profile TEXT, model TEXT, status TEXT NOT NULL,
    output TEXT, error TEXT, exitCode INTEGER, ${withTranscript ? 'transcript TEXT,' : ''}
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
  )`);
  return { workspace, db };
}

describe('SubagentService', () => {
  it('reads registry rows newest first without including transcript in the list', async () => {
    const { workspace, db } = await createRegistry();
    db.prepare(`INSERT INTO subagents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('older', 'first task', null, 'm1', 'done', 'result', null, 0, '{"type":"old"}', 1, 2);
    db.prepare(`INSERT INTO subagents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('newer', 'latest task', '{"fs":"readonly"}', null, 'running', null, null, null, '{"type":"live"}', 5, 6);
    db.close();
    const service = new SubagentService();

    expect(service.list(workspace)).toEqual([
      { id: 'newer', task: 'latest task', profile: '{"fs":"readonly"}', model: null, status: 'running', output: null, error: null, exitCode: null, transcript: null, createdAt: 5, updatedAt: 6 },
      { id: 'older', task: 'first task', profile: null, model: 'm1', status: 'done', output: 'result', error: null, exitCode: 0, transcript: null, createdAt: 1, updatedAt: 2 },
    ]);
  });

  it('returns an individual transcript and remains compatible with registries lacking that column', async () => {
    const current = await createRegistry();
    current.db.prepare(`INSERT INTO subagents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('agent', 'task', null, null, 'done', null, null, null, '{"type":"agent_end"}', 1, 1);
    current.db.close();
    const legacy = await createRegistry(false);
    legacy.db.prepare(`INSERT INTO subagents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy', 'task', null, null, 'done', null, null, null, 1, 1);
    legacy.db.close();
    const service = new SubagentService();

    expect(service.transcript(current.workspace, 'agent')).toBe('{"type":"agent_end"}');
    expect(service.transcript(current.workspace, 'missing')).toBeNull();
    expect(service.transcript(legacy.workspace, 'legacy')).toBeNull();
  });

  it('returns no rows for a missing registry and appends cancellation requests as JSONL', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'electron-agent-subagent-'));
    directories.push(workspace);
    const service = new SubagentService();

    expect(service.list(workspace)).toEqual([]);
    await service.cancel(workspace, 'agent-1');
    const request = JSON.parse((await readFile(join(workspace, '.pi', 'subagents', 'cancel-requests.jsonl'), 'utf8')).trim());
    expect(request).toMatchObject({ agentId: 'agent-1' });
    expect(typeof request.at).toBe('number');
    await expect(service.cancel(workspace, '   ')).rejects.toThrow('agentId is required');
  });
});
