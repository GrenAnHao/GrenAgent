import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKnowledgeReadTools } from './readTools';

describe('manifest-bound knowledge tools', () => {
  it('reads authorized pinned content and rejects traversal and changed content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-tools-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'a.txt'), 'hello\n');
      const hash = createHash('sha256').update('hello\n').digest('hex');
      const observations: any[] = [];
      const tools = createKnowledgeReadTools({ root }, [{ path: 'src/a.txt', hash }], value => observations.push(value));
      const read = tools.find(tool => tool.name === 'Read')!;
      expect(await read.execute('1', { path: 'src/a.txt' })).toMatchObject({ content: [{ text: expect.stringContaining('hello') }] });
      expect(observations[0]).toMatchObject({ path: 'src/a.txt', hash, startLine: 1, endLine: 2 });
      await expect(read.execute('2', { path: '../outside' })).rejects.toThrow();
      await expect(read.execute('3', { path: 'docs/repo-wiki/a' })).rejects.toThrow();
      expect(() => createKnowledgeReadTools({ root }, [{ path: '.repowiki-workspace/cache.db', hash }])).toThrow('FORBIDDEN_PATH');
      expect(() => createKnowledgeReadTools({ root }, [{ path: '.cache/generated.txt', hash }])).toThrow('FORBIDDEN_PATH');
      writeFileSync(join(root, 'src', 'a.txt'), 'changed');
      await expect(read.execute('4', { path: 'src/a.txt' })).rejects.toThrow('SNAPSHOT_CHANGED');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('limits search to pinned files and rejects aliases and symlinks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-search-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'a.txt'), 'visible needle\n');
      writeFileSync(join(root, 'src', 'secret.txt'), 'secret needle\n');
      const hash = createHash('sha256').update('visible needle\n').digest('hex');
      const seen: any[] = [];
      const tools = createKnowledgeReadTools({ root }, [{ path: 'src/a.txt', hash }], value => seen.push(value));
      const invoke = (name: string, args: any) => tools.find(tool => tool.name === name)!.execute('id', args);
      expect(JSON.stringify(await invoke('Grep', { pattern: 'needle', context: 0 }))).toContain('visible needle');
      expect(JSON.stringify(await invoke('Grep', { pattern: 'secret', context: 0 }))).not.toContain('secret needle');
      expect(JSON.stringify(await invoke('Glob', { pattern: '*.txt', path: 'src' }))).toContain('src/a.txt');
      expect(JSON.stringify(await invoke('ListDir', { path: 'src' }))).not.toContain('secret.txt');
      expect(seen).toContainEqual(expect.objectContaining({ kind: 'directory', path: 'src', scope: 'src' }));
      await expect(invoke('Read', { path: 'src/A.txt' })).rejects.toThrow('FORBIDDEN_PATH');
      expect(seen.filter(entry => entry.kind === 'search').every(entry => entry.scope)).toBe(true);
      try { symlinkSync(join(root, 'src', 'a.txt'), join(root, 'link.txt'), 'file'); }
      catch (error: any) { if (error.code === 'EPERM') return; throw error; }
      const linked = createKnowledgeReadTools({ root }, [{ path: 'link.txt', hash }]);
      await expect(linked[0].execute('id', { path: 'link.txt' })).rejects.toThrow('FORBIDDEN_PATH');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('records the actual requested line range without marking an intentional segment as truncated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-lines-'));
    try {
      const text = 'one\rtwo\rthree'; writeFileSync(join(root, 'a.txt'), text);
      const seen: any[] = [];
      const [read] = createKnowledgeReadTools({ root }, [{ path: 'a.txt', hash: createHash('sha256').update(text).digest('hex') }], item => seen.push(item));
      const output = await read.execute('id', { path: 'a.txt', offset: 2, limit: 1 });
      expect(output).toMatchObject({ content: [{ text: 'two' }], details: { truncated: false } });
      expect(seen[0]).toMatchObject({ startLine: 2, endLine: 2 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
