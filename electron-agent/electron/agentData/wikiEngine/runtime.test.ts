import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDataClient } from '../client';
import { AgentDataRuntime } from '../runtime';

describe('AgentDataRuntime wiki engine wiring', () => {
  const runtimes: AgentDataRuntime[] = [];
  const clients: AgentDataClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    for (const runtime of runtimes.splice(0)) {
      runtime.close();
      await runtime.waitClosed();
    }
  });

  it('creates a wiki, writes raw, and reads a page without old library jobs or wiki audits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-runtime-'));
    const completeSimple = vi.fn(async () => 'unused');
    const runtime = new AgentDataRuntime({
      dataPath: join(root, 'agent-data.db'),
      wikiRootDir: join(root, 'wiki'),
      completeSimple: ({ systemPrompt, user }) => completeSimple({ systemPrompt, user }),
    });
    runtimes.push(runtime);
    const endpoint = await runtime.start();
    const client = new AgentDataClient(endpoint);
    clients.push(client);

    const created = await runtime.requestAdmin<{ wikiId: string; status: string }>('wiki.create', { name: '产品手册' });
    expect(created.status).toBe('draft');
    expect(created.wikiId).toBeTruthy();

    await runtime.requestAdmin('wiki.rawWrite', { wikiId: created.wikiId, filename: 'note.md', content: '第一版原文' });
    await runtime.requestAdmin('wiki.pageWrite', { wikiId: created.wikiId, ref: 'concepts/auth', content: '# 权限模型' });
    const page = await runtime.requestAdmin<string>('wiki.pageRead', { wikiId: created.wikiId, ref: 'concepts/auth' });
    expect(page).toContain('# 权限模型');
    expect(page).toContain('locked: true');

    const jobs = await client.request<Array<{ kind: string }>>('admin.jobs.list');
    expect(jobs.every((job) => !job.kind.startsWith('wiki.'))).toBe(true);
    expect(jobs.some((job) => job.kind === 'wiki.ingest')).toBe(false);

    const audit = await client.request<Array<{ action: string }>>('admin.audit.list');
    expect(audit.every((event) => !event.action.startsWith('wiki.'))).toBe(true);

    await expect(runtime.requestAdmin('wiki.libraries.list', {})).rejects.toThrow(/METHOD_NOT_FOUND|unknown management method/);
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
