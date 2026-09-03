import { describe, expect, it, vi } from 'vitest';
import { scanWorkspaceMarkdown, WikiSync, type WikiSyncClient } from './sync.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 只用 model.id 与 modelRegistry，按真实参数类型收敛，不复制 pi 的完整结构。
type WikiUpdateContext = Parameters<WikiSync['update']>[0];

function client() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const value: WikiSyncClient = {
    async request<T>(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      return null as T;
    },
  };
  return { value, calls };
}

describe('WikiSync', () => {
  it('scans workspace Markdown while excluding runtime directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wiki-sync-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# Readme');
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide');
    await writeFile(join(root, 'node_modules', 'pkg', 'ignored.md'), '# Ignored');
    await expect(scanWorkspaceMarkdown(root)).resolves.toEqual(['README.md', 'docs/guide.md']);
  });

  it('generates a page with the current model and writes source metadata', async () => {
    const c = client();
    const ask = vi.fn(async () => {
      return '# Generated\n\nSummary';
    });
    const sync = new WikiSync(c.value, (ctx) => {
      expect(ctx.model).toEqual({ id: 'current' });
      return ask;
    });
    await sync.update({ cwd: '/repo', model: { id: 'current' }, modelRegistry: {}, signal: undefined } as unknown as WikiUpdateContext, {
      page: 'docs/overview.md', sourcePath: 'README.md', source: '# Source\n\nDetails',
    });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].method).toBe('wiki.replace');
    expect(c.calls[0].params.content).toContain('# Generated');
    expect(c.calls[0].params.sourcePath).toBe('README.md');
  });

  it('keeps the existing page when generation fails', async () => {
    const c = client();
    const sync = new WikiSync(c.value, () => async () => { throw new Error('offline'); });
    await expect(sync.update({ cwd: '/repo', model: { id: 'current' }, modelRegistry: {}, signal: undefined } as unknown as WikiUpdateContext, {
      page: 'docs/overview.md', sourcePath: 'README.md', source: 'new source',
    })).resolves.toBe(false);
    expect(c.calls).toHaveLength(0);
  });
});
