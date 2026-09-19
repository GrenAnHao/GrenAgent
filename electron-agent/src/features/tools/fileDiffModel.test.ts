import { describe, expect, it } from 'vitest';
import { fileCardVerb, fileDiffModel, isFileMutation, isFileRead } from './fileDiffModel';

describe('fileDiffModel', () => {
  it('recognizes read/write/edit aliases', () => {
    expect(isFileRead('read_file')).toBe(true);
    expect(isFileMutation('write_file')).toBe(true);
    expect(isFileMutation('search_replace')).toBe(true);
    expect(isFileMutation('read')).toBe(false);
    expect(fileCardVerb('write_file')).toBe('写入');
    expect(fileCardVerb('bash')).toBeNull();
  });

  it('write intended is all additions and drops a trailing empty line', () => {
    const diff = fileDiffModel(
      'write',
      { path: 'a.txt', content: 'one\ntwo\n' },
      {},
      'running',
    );
    expect(diff?.path).toBe('a.txt');
    expect(diff?.rows).toEqual([
      { marker: '+', text: 'one' },
      { marker: '+', text: 'two' },
    ]);
    expect(diff?.added).toBe(2);
    expect(diff?.deleted).toBe(0);
  });

  it('edit intended uses old_string / new_string', () => {
    const diff = fileDiffModel(
      'edit',
      { file_path: 'a.ts', old_string: 'foo', new_string: 'bar' },
      {},
      'running',
    );
    expect(diff?.path).toBe('a.ts');
    expect(diff?.rows).toEqual([
      { marker: '-', text: 'foo' },
      { marker: '+', text: 'bar' },
    ]);
  });

  it('prefers details.diff when the tool completed', () => {
    const diff = fileDiffModel(
      'edit',
      { path: 'a.ts', oldText: 'foo', newText: 'bar' },
      { details: { diff: ' 1 keep\n-2 foo\n+2 bar\n 3 next' } },
      'done',
    );
    expect(diff?.rows.map((row) => row.marker + row.text)).toEqual([' keep', '-foo', '+bar', ' next']);
    expect(diff?.added).toBe(1);
    expect(diff?.deleted).toBe(1);
  });

  it('parses standard unified diff when the tool completed', () => {
    const diff = fileDiffModel(
      'edit',
      { path: 'a.ts', oldText: 'foo', newText: 'bar' },
      { details: { diff: '@@ -1 +1 @@\n-a\n+b\n' } },
      'done',
    );
    expect(diff?.rows).toEqual([
      { marker: '-', text: 'a' },
      { marker: '+', text: 'b' },
    ]);
    expect(diff?.added).toBe(1);
    expect(diff?.deleted).toBe(1);
  });

  it('returns null on error or identical-content result text', () => {
    expect(fileDiffModel('write', { path: 'a.txt', content: 'x' }, {}, 'error')).toBeNull();
    expect(
      fileDiffModel(
        'edit',
        { path: 'a.ts', oldText: 'same', newText: 'same' },
        { content: [{ type: 'text', text: 'No changes made. The replacement produced identical content.' }] },
        'done',
      ),
    ).toBeNull();
  });

  it('keeps intended write when details.diff is missing after success', () => {
    const diff = fileDiffModel('write', { path: 'a.txt', content: 'hello' }, { content: [] }, 'done');
    expect(diff?.rows).toEqual([{ marker: '+', text: 'hello' }]);
  });
});
