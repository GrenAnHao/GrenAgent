import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSessionProjectTransferMainGate } from './sessionProjectTransferMainGate.js';
import { SessionProjectTransferJournal, readTransferJournalBlocks, sha256Text } from './sessionProjectTransferJournal.js';
import { WorkspaceService } from './workspaceService.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gren-transfer-main-gate-')); roots.push(root);
  const agentDir = join(root, 'agent'); const source = join(root, 'source'); const target = join(root, 'target');
  const path = join(agentDir, 'sessions', 'source', 'main.jsonl');
  await Promise.all([mkdir(join(agentDir, 'sessions', 'source'), { recursive: true }), mkdir(source), mkdir(target)]);
  const content = `${JSON.stringify({type:'session',version:3,id:'main',timestamp:'2026-11-17T00:00:00.000Z',cwd:source})}\n`;
  await writeFile(path, content);
  const workspace = new WorkspaceService(agentDir);
  const journal = new SessionProjectTransferJournal(agentDir);
  const operationId = '22222222-2222-4222-8222-222222222222';
  const prepare = async () => {
    const image = { path, content, bytes:Buffer.byteLength(content), sha256:sha256Text(content) };
    return journal.savePrepared({operationId,sourceWorkspace:source,targetWorkspace:target,sessionId:'main',sessionPath:path,
      leafId:null,revision:'r1',fingerprint:'f1',family:[],registryHash:sha256Text('[]'),registryRecordCount:0,
      before:[image],after:[{...image,beforeSha256:image.sha256}],
      registry:{version:1,rows:[],expectedSourceHash:sha256Text('[]'),expectedTargetHash:sha256Text('[]')},now:1});
  };
  return {agentDir,source,path,workspace,journal,operationId,prepare};
}
describe('main transfer recovery gate', () => {
  it('uses only compact manifests for ordinary read gates, not whole transcript images', async () => {
    const f = await setup(); await f.prepare();
    const load = vi.spyOn(SessionProjectTransferJournal.prototype, 'load').mockRejectedValue(new Error('must not load transcript images'));
    try {
      expect(await readTransferJournalBlocks(f.agentDir)).toEqual([expect.objectContaining({phase:'prepared',sessionPaths:[f.path]})]);
      expect(load).not.toHaveBeenCalled();
    } finally { load.mockRestore(); }
  });
  it('does not start an agent host for a clean session listing', async () => {
    const f = await setup(); const recover = vi.fn(async () => {});
    installSessionProjectTransferMainGate({...f,recover});
    expect(await f.workspace.listSessions(f.source)).toHaveLength(1);
    expect(recover).not.toHaveBeenCalled();
  });
  it('starts cold recovery before exposing a pending family', async () => {
    const f = await setup(); await f.prepare();
    const recover = vi.fn(async () => { await f.journal.remove(f.operationId); });
    installSessionProjectTransferMainGate({...f,recover});
    expect(await f.workspace.listSessions(f.source)).toHaveLength(1);
    expect(recover).toHaveBeenCalledTimes(1);
  });
  it('hides a failed family without hiding unrelated sessions and releases it after recovery', async () => {
    const f = await setup(); await f.prepare();
    const recover = vi.fn(async () => {});
    installSessionProjectTransferMainGate({...f,recover});
    expect(await f.workspace.listSessions(f.source)).toEqual([]);
    expect(() => f.workspace.assertSessionPathsAvailable([f.path])).toThrow('SESSION_TRANSFER_BLOCKED');
    expect(() => f.workspace.assertSessionPathsAvailable([join(f.agentDir,'sessions','other.jsonl')])).not.toThrow();
    await f.journal.remove(f.operationId);
    expect(await f.workspace.listSessions(f.source)).toHaveLength(1);
    expect(() => f.workspace.assertSessionPathsAvailable([f.path])).not.toThrow();
  });
});
