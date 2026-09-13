import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../../../cli/src/pi-sdk.js';
import { foldCatalog } from '../../../extensions/multi-agent/catalog.js';
import { sampleCatalogRow } from '../../../extensions/multi-agent/catalog-sample.js';
import {
  authorizeParent,
  coldResumeAndDeliver,
  deliverToChild,
  getActivationBySessionPath,
  interruptChild as interruptResidentChild,
} from '../../../extensions/multi-agent/activation.js';
import type { SubagentCatalogEntry } from '../../../extensions/multi-agent/catalog.js';
import { SubagentService } from './subagentService';

vi.mock('../../../extensions/multi-agent/catalog.js', () => ({
  foldCatalog: vi.fn(() => ({ entries: [], diagnostics: [] })),
}));

vi.mock('../../../extensions/multi-agent/catalog-sample.js', () => ({
  sampleCatalogRow: vi.fn((entry: SubagentCatalogEntry) => ({
    ...entry,
    activity: 'settled',
    hasChildren: false,
  })),
}));

vi.mock('../../../extensions/multi-agent/activation.js', () => ({
  getActivationBySessionPath: vi.fn(),
  deliverToChild: vi.fn(),
  interruptChild: vi.fn(),
  coldResumeAndDeliver: vi.fn(),
  authorizeParent: vi.fn(),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const parentPath = '/parent.jsonl';
const sa1Path = '/sa-1.jsonl';
const sa2Path = '/sa-2.jsonl';
const sa3Path = '/sa-3.jsonl';
const workspace = '/ws';

function entry(over: Partial<SubagentCatalogEntry> & Pick<SubagentCatalogEntry, 'id' | 'sessionPath'>): SubagentCatalogEntry {
  return {
    createdAt: 1,
    mode: 'continuable',
    label: over.id,
    ...over,
  };
}

function stubCatalog(tree: Record<string, SubagentCatalogEntry[]>): void {
  vi.mocked(foldCatalog).mockImplementation((path: string) => ({
    entries: tree[path] ?? [],
    diagnostics: [],
  }));
}

function stubActivation(sessionPath: string, childId: string, ws = workspace) {
  vi.mocked(getActivationBySessionPath).mockImplementation((path: string) => (
    path === sessionPath ? { childId, workspace: ws, sessionPath } as never : undefined
  ));
}

function persistSession(sm: SessionManager): string {
  const path = sm.getSessionFile();
  if (!path) throw new Error('session file was not created');
  const header = sm.getHeader();
  const lines = [header, ...sm.getEntries()].filter(Boolean).map((item) => JSON.stringify(item));
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

async function writeChildMeta(meta: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'electron-agent-catalog-row-'));
  directories.push(dir);
  const sm = SessionManager.create('/ws', dir);
  sm.appendCustomEntry('subagent_meta', meta);
  return persistSession(sm);
}

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

describe('SubagentService catalog IPC', () => {
  const sa1 = entry({ id: 'sa-1', sessionPath: sa1Path });
  const sa2 = entry({ id: 'sa-2', sessionPath: sa2Path });
  const sa3 = entry({ id: 'sa-3', sessionPath: sa3Path });
  const service = new SubagentService();

  beforeEach(() => {
    stubCatalog({
      [parentPath]: [sa1],
      [sa1Path]: [sa2],
      [sa2Path]: [sa3],
    });
  });

  it('catalog delegates to foldCatalog', () => {
    const view = { entries: [sa1], diagnostics: [] };
    vi.mocked(foldCatalog).mockReturnValue(view);
    expect(service.catalog(parentPath)).toBe(view);
    expect(foldCatalog).toHaveBeenCalledWith(parentPath);
  });

  it('catalogRowSample fills id, label and mode from child subagent_meta', async () => {
    const sessionPath = await writeChildMeta({
      agentId: 'sa-meta-1',
      label: 'from meta',
      mode: 'continuable',
    });
    const row = service.catalogRowSample(sessionPath);
    expect(row).toMatchObject({
      id: 'sa-meta-1',
      label: 'from meta',
      mode: 'continuable',
      sessionPath,
    });
  });

  it('prompts a direct child with a resident activation via deliverToChild', async () => {
    stubActivation(sa1Path, 'sa-1');
    await service.promptChild(workspace, parentPath, sa1Path, 'hello', 'followUp');
    expect(authorizeParent).toHaveBeenCalledWith(expect.objectContaining({ childId: 'sa-1', workspace }), workspace);
    expect(deliverToChild).toHaveBeenCalledWith('sa-1', 'hello', 'followUp');
    expect(coldResumeAndDeliver).not.toHaveBeenCalled();
  });

  it('rejects prompt when sessionPath is not in the parent catalog', async () => {
    await expect(service.promptChild(workspace, parentPath, '/stranger.jsonl', 'x', 'followUp'))
      .rejects.toThrow('sessionPath is not in the parent catalog');
    expect(deliverToChild).not.toHaveBeenCalled();
  });

  it('allows prompt of a grandchild listed in the child catalog', async () => {
    stubActivation(sa2Path, 'sa-2');
    await service.promptChild(workspace, parentPath, sa2Path, 'to grandchild', 'steer');
    expect(deliverToChild).toHaveBeenCalledWith('sa-2', 'to grandchild', 'steer');
  });

  it('rejects prompt of a great-grandchild', async () => {
    await expect(service.promptChild(workspace, parentPath, sa3Path, 'too deep', 'followUp'))
      .rejects.toThrow('sessionPath is not in the parent catalog');
    expect(deliverToChild).not.toHaveBeenCalled();
  });

  it('rejects prompt of a one-shot child', async () => {
    stubCatalog({ [parentPath]: [entry({ id: 'sa-1', sessionPath: sa1Path, mode: 'one-shot' })] });
    await expect(service.promptChild(workspace, parentPath, sa1Path, 'nope', 'followUp'))
      .rejects.toThrow(/one-shot|只读/);
    expect(deliverToChild).not.toHaveBeenCalled();
    expect(coldResumeAndDeliver).not.toHaveBeenCalled();
  });

  it('cold-resumes a continuable child with no resident activation', async () => {
    vi.mocked(getActivationBySessionPath).mockReturnValue(undefined);
    await service.promptChild(workspace, parentPath, sa1Path, 'resume', 'followUp');
    expect(coldResumeAndDeliver).toHaveBeenCalledWith('sa-1', sa1Path, 'resume', 'followUp');
    expect(deliverToChild).not.toHaveBeenCalled();
  });

  it('rejects interrupt when sessionPath is not in the parent catalog', () => {
    expect(() => service.interruptChild(workspace, parentPath, '/stranger.jsonl'))
      .toThrow('sessionPath is not in the parent catalog');
    expect(interruptResidentChild).not.toHaveBeenCalled();
  });

  it('interrupts a resident child and no-ops when none is resident', () => {
    stubActivation(sa1Path, 'sa-1');
    service.interruptChild(workspace, parentPath, sa1Path);
    expect(authorizeParent).toHaveBeenCalled();
    expect(interruptResidentChild).toHaveBeenCalledWith('sa-1');

    vi.mocked(getActivationBySessionPath).mockReturnValue(undefined);
    vi.mocked(interruptResidentChild).mockClear();
    expect(() => service.interruptChild(workspace, parentPath, sa1Path)).not.toThrow();
    expect(interruptResidentChild).not.toHaveBeenCalled();
  });
});
