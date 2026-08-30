import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceApprovalService } from './workspaceApprovalService';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createService(): Promise<{ dataDir: string; workspace: string; service: WorkspaceApprovalService }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'electron-agent-approval-'));
  const workspace = join(dataDir, 'workspace');
  await mkdir(workspace);
  directories.push(dataDir);
  return { dataDir, workspace, service: new WorkspaceApprovalService(dataDir) };
}

describe('WorkspaceApprovalService', () => {
  it('approves canonical workspace paths and persists them across restart', async () => {
    const { dataDir, workspace, service } = await createService();
    await expect(service.isApproved(workspace)).resolves.toBe(false);
    await service.approve(join(workspace, '..', 'workspace'));
    await expect(new WorkspaceApprovalService(dataDir).isApproved(workspace)).resolves.toBe(true);
  });

  it('rejects approval requests for missing paths', async () => {
    const { service, workspace } = await createService();
    await expect(service.approve(join(workspace, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
