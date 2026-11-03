import { describe, expect, it } from 'vitest';
import { headAction, readGitHead, type GitHeadIo } from './gitHead';

function io(files: Record<string, string>, directories: string[] = []): GitHeadIo {
  return {
    read: (path) => files[path.replaceAll('\\', '/')],
    isDirectory: (path) => directories.includes(path.replaceAll('\\', '/')),
  };
}

describe('readGitHead', () => {
  it('resolves a branch ref and treats the first observation as a record, not a switch', () => {
    const root = 'D:/repo';
    const files = {
      'D:/repo/.git/HEAD': 'ref: refs/heads/main\n',
      'D:/repo/.git/refs/heads/main': 'abc\n',
    };
    const head = readGitHead(root, io(files, ['D:/repo/.git']));
    expect(head).toBe('refs/heads/main\nabc');
    expect(headAction(undefined, head)).toBe('record');
    expect(headAction(head, 'refs/heads/topic\ndef')).toBe('changed');
    expect(headAction(head, head)).toBe('same');
    expect(headAction(head, undefined)).toBe('unknown');
  });

  it('follows a worktree gitdir pointer', () => {
    const files = {
      'D:/repo/.git': 'gitdir: D:/repo/.git/worktrees/feature\n',
      'D:/repo/.git/worktrees/feature/HEAD': '1234abcd\n',
    };
    expect(readGitHead('D:/repo', io(files))).toBe('1234abcd');
  });
});
