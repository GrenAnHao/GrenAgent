import { describe, expect, it } from 'vitest';
import { isolatedErrorCode, isolatedErrorText, isolatedPathOf } from './isolatedWorkspace';

describe('isolatedPathOf', () => {
  it('recognises <repo>/.gren/worktrees/<id> with either separator', () => {
    expect(isolatedPathOf('D:\\repo\\.gren\\worktrees\\abc12345')).toEqual({ parentRoot: 'D:\\repo', id: 'abc12345', branch: 'gren/abc12345' });
    expect(isolatedPathOf('/home/u/repo/.gren/worktrees/abc12345/')).toEqual({ parentRoot: '/home/u/repo', id: 'abc12345', branch: 'gren/abc12345' });
  });

  it('rejects other shapes: subdirectories of W, B-track worktrees, bad ids', () => {
    expect(isolatedPathOf('/repo/.gren/worktrees/abc12345/src')).toBeNull();
    expect(isolatedPathOf('/repo/.agents/worktrees/worktree-1')).toBeNull();
    expect(isolatedPathOf('/repo/.gren/worktrees/ABC')).toBeNull();
    expect(isolatedPathOf('/repo')).toBeNull();
    expect(isolatedPathOf(null)).toBeNull();
  });
});

describe('isolated error helpers', () => {
  it('pulls out the machine code and strips IPC noise for display', () => {
    const e = new Error("Error invoking remote method 'gren:invoke': Error: ISOLATED_BUSY: 独立工作区 x 里还有会话在运行");
    expect(isolatedErrorCode(e)).toBe('ISOLATED_BUSY');
    expect(isolatedErrorText(e)).toBe('独立工作区 x 里还有会话在运行');
    expect(isolatedErrorCode(new Error('boom'))).toBeUndefined();
  });
});
