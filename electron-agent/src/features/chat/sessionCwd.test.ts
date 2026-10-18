import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/agentReducer';
import { groupMessages, type TimelineSegment } from './groupMessages';
import { cwdAfterTool, resolveSessionFile } from './sessionCwd';
import { changesForTurn, presentedForTurn } from './turnDeliverables';

const PROJECT = 'D:\\OneDrive\\Project Files\\Engineering Decision Management';
const SESSION_CWD = 'E:\\linghoumiaohui-kefu-extract';

describe('cwdAfterTool', () => {
  it('reads the new directory from working_directory and create_worktree results', () => {
    expect(cwdAfterTool('working_directory', 'done', { details: { cwd: SESSION_CWD, previous: PROJECT, changed: true } })).toBe(SESSION_CWD);
    expect(cwdAfterTool('working_directory', 'done', { details: { cwd: PROJECT, original: PROJECT } })).toBe(PROJECT);
    expect(cwdAfterTool('create_worktree', 'done', { details: { path: 'D:/ws/.agents/worktrees/x', previous: PROJECT } })).toBe('D:/ws/.agents/worktrees/x');
  });

  it('ignores failures, unrelated tools and results without a directory', () => {
    expect(cwdAfterTool('working_directory', 'error', { details: { cwd: SESSION_CWD } })).toBeUndefined();
    expect(cwdAfterTool('working_directory', 'running', undefined)).toBeUndefined();
    expect(cwdAfterTool('write', 'done', { details: { cwd: SESSION_CWD } })).toBeUndefined();
    expect(cwdAfterTool('working_directory', 'done', { details: {} })).toBeUndefined();
  });
});

describe('resolveSessionFile', () => {
  it('resolves a relative path against the working directory the session was in, not the project root', () => {
    expect(resolveSessionFile(PROJECT, SESSION_CWD, 'docs/a.md')).toEqual({
      absolute: 'E:/linghoumiaohui-kefu-extract/docs/a.md',
      root: SESSION_CWD,
    });
  });

  it('falls back to the project workspace when the session never moved', () => {
    expect(resolveSessionFile('D:/ws', undefined, 'src/a.ts')).toEqual({ absolute: 'D:/ws/src/a.ts', root: 'D:/ws' });
  });

  it('keeps the project workspace as the root for files inside it, even after moving into a worktree under it', () => {
    const worktree = 'D:/ws/.agents/worktrees/x';
    expect(resolveSessionFile('D:/ws', worktree, 'a.ts')).toEqual({ absolute: 'D:/ws/.agents/worktrees/x/a.ts', root: 'D:/ws' });
    expect(resolveSessionFile('D:/ws', worktree, 'D:/ws/b.ts')).toEqual({ absolute: 'D:/ws/b.ts', root: 'D:/ws' });
  });

  it('resolves absolute paths outside the project; the root is the session directory when it contains the file, else the file folder', () => {
    expect(resolveSessionFile(PROJECT, SESSION_CWD, 'E:/linghoumiaohui-kefu-extract/_analyze/x.js')).toEqual({
      absolute: 'E:/linghoumiaohui-kefu-extract/_analyze/x.js',
      root: SESSION_CWD,
    });
    expect(resolveSessionFile(PROJECT, undefined, 'F:\\other\\notes\\n.txt')).toEqual({ absolute: 'F:/other/notes/n.txt', root: 'F:/other/notes' });
  });

  it('compares directories case-insensitively and across slash styles', () => {
    expect(resolveSessionFile('D:\\Work\\Proj', undefined, 'd:/work/proj/a.ts')?.root).toBe('D:\\Work\\Proj');
  });

  it('still rejects parent escapes and missing context', () => {
    expect(resolveSessionFile('D:/ws', undefined, '../secret.txt')).toBeNull();
    expect(resolveSessionFile('D:/ws', 'E:/x', 'a/../../b')).toBeNull();
    expect(resolveSessionFile('', undefined, 'a.txt')).toBeNull();
    expect(resolveSessionFile('D:/ws', undefined, '  ')).toBeNull();
  });
});

const assistant = (id: string): ChatMessage => ({ kind: 'assistant', id, text: '', thinking: '', streaming: false });
const tool = (id: string, toolName: string, args: unknown, result: unknown = { content: [] }, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ kind: 'tool', id, toolCallId: `c-${id}`, toolName, args, result, status: 'done', ...extra }) as ChatMessage;

function segments(messages: ChatMessage[]): TimelineSegment[] {
  return groupMessages(messages).flatMap((item) => (item.kind === 'turn' ? item.segments : []));
}

describe('session working directory across tool calls (reported session)', () => {
  // 会话头 cwd 是项目目录；模型先把分析脚本用绝对路径写到 E 盘，再 working_directory 切过去，
  // 之后 present / edit 用的相对路径都相对 E 盘。
  const messages: ChatMessage[] = [
    assistant('a1'),
    tool('w1', 'write', { path: 'E:/linghoumiaohui-kefu-extract/_analyze/scan.js', content: 'x' }),
    tool('present-early', 'present', { files: [{ path: 'docs/r.md' }] }, { details: {} }, { status: 'error' }),
    tool('cd', 'working_directory', { cd: 'E:/linghoumiaohui-kefu-extract' }, {
      details: { cwd: SESSION_CWD, previous: PROJECT, changed: true, original: PROJECT },
    }),
    tool('e1', 'edit', { path: 'docs/r.md', edits: [{ oldText: 'a', newText: 'b' }] }),
    tool('p1', 'present', { files: [{ path: 'docs/r.md' }] }, { details: { files: [{ path: 'docs/r.md' }] } }),
    { kind: 'user', id: 'u2', text: 'next' } as ChatMessage,
    assistant('a2'),
    tool('p2', 'present', { files: [{ path: '_analyze/behavior/audit.js' }] }, { details: { files: [{ path: '_analyze/behavior/audit.js' }] } }),
  ];

  it('stamps tools with the directory in effect when they ran, and keeps it across turns', () => {
    const tools = segments(messages).filter((s) => s.kind === 'tool');
    const byId = Object.fromEntries(tools.map((s) => [s.id, s.kind === 'tool' ? s.cwd : undefined]));
    expect(byId.w1).toBeUndefined();
    expect(byId['present-early']).toBeUndefined();
    expect(byId.cd).toBeUndefined();
    expect(byId.e1).toBe(SESSION_CWD);
    expect(byId.p1).toBe(SESSION_CWD);
    expect(byId.p2).toBe(SESSION_CWD);
  });

  it('resolves presented files in the session directory, which is where they really are', () => {
    const turns = groupMessages(messages).filter((item) => item.kind === 'turn');
    const first = presentedForTurn(turns[0].kind === 'turn' ? turns[0].segments : []);
    const second = presentedForTurn(turns[1].kind === 'turn' ? turns[1].segments : []);
    expect(first).toEqual([{ path: 'docs/r.md', display: 'r.md', cwd: SESSION_CWD }]);
    expect(resolveSessionFile(PROJECT, first[0].cwd, first[0].path)).toEqual({
      absolute: 'E:/linghoumiaohui-kefu-extract/docs/r.md',
      root: SESSION_CWD,
    });
    expect(resolveSessionFile(PROJECT, second[0].cwd, second[0].path)?.absolute).toBe('E:/linghoumiaohui-kefu-extract/_analyze/behavior/audit.js');
  });

  it('opens new-style present results (absolute paths) without needing the tracked directory', () => {
    const turn = segments([
      assistant('a'),
      tool('p', 'present', { files: [{ path: 'docs/r.md' }] }, {
        details: { files: [{ path: 'E:\\extract\\docs\\r.md' }, { path: 'F:\\elsewhere\\n.txt' }] },
      }),
    ]);
    const [inSession, elsewhere] = presentedForTurn(turn);
    expect(inSession.display).toBe('r.md');
    // 没有跟踪到切换记录时，文件所在目录就是能读到它的根。
    expect(resolveSessionFile(PROJECT, inSession.cwd, inSession.path)).toEqual({ absolute: 'E:/extract/docs/r.md', root: 'E:/extract/docs' });
    expect(resolveSessionFile(PROJECT, elsewhere.cwd, elsewhere.path)).toEqual({ absolute: 'F:/elsewhere/n.txt', root: 'F:/elsewhere' });
    // 跟踪到会话目录时，根优先取会话目录（文件树能看到整个项目）。
    expect(resolveSessionFile(PROJECT, 'E:\\extract', inSession.path)?.root).toBe('E:\\extract');
  });

  it('keeps the same relative path in different directories as different changed files', () => {
    const turn = segments([
      assistant('a'),
      tool('w-a', 'write', { path: 'a.txt', content: 'one' }),
      tool('cd', 'working_directory', {}, { details: { cwd: SESSION_CWD } }),
      tool('w-b', 'write', { path: 'a.txt', content: 'two' }),
    ]);
    const files = changesForTurn(turn);
    expect(files.map((f) => [f.path, f.cwd])).toEqual([['a.txt', undefined], ['a.txt', SESSION_CWD]]);
  });

  it('does not let a nested (sub-agent) working_directory move the main session', () => {
    const turn = segments([
      assistant('a'),
      tool('child-cd', 'working_directory', {}, { details: { cwd: 'F:/child' } }, { parentToolCallId: 'parent' }),
      tool('w', 'write', { path: 'a.txt', content: 'x' }),
    ]);
    expect(turn.find((s) => s.id === 'w')).not.toHaveProperty('cwd');
  });

  it('a failed cd does not move the directory', () => {
    const turn = segments([
      assistant('a'),
      tool('cd', 'working_directory', { cd: 'nope' }, { details: { cwd: SESSION_CWD } }, { status: 'error' }),
      tool('w', 'write', { path: 'a.txt', content: 'x' }),
    ]);
    expect(turn.find((s) => s.id === 'w')).not.toHaveProperty('cwd');
  });
});
