import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRepositoryTool } from './repositoryTools';
import { runWikiSession } from './sessionRuntime';

describe('native wiki repository tools', () => {
  it('reads within the repository and rejects path traversal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-tools-'));
    try {
      mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'a.ts'), 'hello\nworld');
      expect((await executeRepositoryTool(root, 'Read', { path: 'src/a.ts' }, [{ path: 'src/a.ts', hash: createHash('sha256').update('hello\nworld').digest('hex') }])).content).toContain('hello');
      expect((await executeRepositoryTool(root, 'Read', { path: 'src/a.ts' }, [])).error).toBe('FORBIDDEN_PATH');
      writeFileSync(join(root, 'src', 'a.ts'), 'changed');
      expect((await executeRepositoryTool(root, 'Read', { path: 'src/a.ts' }, [{ path: 'src/a.ts', hash: createHash('sha256').update('hello\nworld').digest('hex') }])).error).toBe('SNAPSHOT_CHANGED');
      for (const path of ['../secret', 'C:/secret', 'src\\a.ts', '/etc/passwd']) {
        expect((await executeRepositoryTool(root, 'Read', { path }, [])).error).toBeDefined();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('native wiki session', () => {
  it('returns tool results to the model and records unknown usage when absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-session-')); writeFileSync(join(root, 'a.txt'), 'repository material');
    const usage: unknown[] = []; const events: any[] = []; let turn = 0;
    try {
      const result = await runWikiSession({ operation: { repositoryRoot: root } as never, signal: new AbortController().signal,
        purpose: 'wiki.full.page', systemPrompt: 'system', prompt: 'question', manifest: [{ path: 'a.txt', hash: createHash('sha256').update('repository material').digest('hex') }], usage: value => usage.push(value), trace: { stage: 'page', itemId: 'one', runId: 'run', attempt: 1, round: 1, sessionRestartCount: 0 }, event: value => events.push(value),
        requestModel: async request => { turn++; if (turn === 1) return { text: '', toolCalls: [{ id: '1', name: 'Read', arguments: { path: 'a.txt' } }] };
          expect(request.messages.at(-1)?.content).toContain('repository material'); return { text: 'answer' }; } });
      expect(result.text).toBe('answer'); expect(usage.filter((x: any) => x.state === 'unknown')).toHaveLength(2);
      expect(events.map(e => e.kind)).toEqual(['session-start', 'model-submitted', 'model-completed', 'tool-start', 'tool-finish', 'model-submitted', 'model-completed']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('returns a terminal response that arrives as pause is requested', async () => {
    const controller = new AbortController(); const usage: unknown[] = [];
    const result = await runWikiSession({ operation: { repositoryRoot: '.', model: {} } as never, signal: controller.signal, purpose: 'wiki.full.page',
      systemPrompt: 'system', prompt: 'question', manifest: [], usage: value => usage.push(value),
      requestModel: async () => { controller.abort(); return { text: 'complete', usage: { totalTokens: 7 } }; } });
    expect(result.text).toBe('complete'); expect(usage).toContainEqual({ requestId: expect.any(String), state: 'actual', totalTokens: 7 });
  });
});
