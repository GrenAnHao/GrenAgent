import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AgentDataStorage } from '../storage';
import { KnowledgeBuildStore } from './store';
import { DEFAULT_KNOWLEDGE_BUDGETS } from '../../../shared/knowledgeKernelContracts';

it('retains paid/tool/time reservations after killing a process before its item ACK', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-crash-')); const path = join(dir, 'db'); const ready = join(dir, 'ready');
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./crashFixture.ts', import.meta.url)), path, ready], { windowsHide: true, stdio: 'pipe' }); let stderr = ''; child.stderr.on('data', data => { stderr += String(data); });
  try {
    await expect.poll(() => { if (child.exitCode !== null) throw new Error(stderr); return existsSync(ready); }, { timeout: 15000 }).toBe(true);
    child.kill('SIGKILL'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
    const storage = new AgentDataStorage(path); storage.migrate(); const store = new KnowledgeBuildStore(storage.db, { controllerEpoch: 'after-crash' });
    try { const { taskId } = JSON.parse(readFileSync(ready, 'utf8')); const remaining = store.budgetRemaining(taskId, 'generate', 'page'); expect(remaining.unit).toMatchObject({ maxAttempts: 0, maxToolCalls: 0, maxReadBytes: 0, activeTimeMs: 0, maxModelRequests: DEFAULT_KNOWLEDGE_BUDGETS.unit.maxModelRequests - 1 }); expect(store.listCheckpoints(taskId)).toEqual([]); expect(store.getExecutionRequest('last-read')).toMatchObject({ state: 'unknown', reserved: { totalTokens: 1024 } }); } finally { storage.close(); }
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
}, 20000);
