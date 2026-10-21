import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from './pi';
import {
  LAST_OPEN_KEY,
  lastOpenEquals,
  lastOpenFromState,
  pickStartupTarget,
  readLastOpen,
  writeLastOpen,
} from './lastOpen';

const works = 'C:/Users/me/.pi/agent/works';
const session = (cwd: string, path: string, archived?: boolean): SessionInfo => ({
  id: path,
  path,
  cwd,
  timestamp: null,
  name: null,
  ...(archived ? { archived: true } : {}),
});

describe('lastOpen 读写', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('往返；坏数据和空工作区读成 null', () => {
    expect(readLastOpen()).toBeNull();
    writeLastOpen({ workspace: 'D:/proj', sessionPath: 'D:/proj/.pi/a.jsonl' });
    expect(readLastOpen()).toEqual({ workspace: 'D:/proj', sessionPath: 'D:/proj/.pi/a.jsonl' });
    writeLastOpen({ workspace: `${works}/abc`, sessionPath: null });
    expect(readLastOpen()).toEqual({ workspace: `${works}/abc`, sessionPath: null });
    localStorage.setItem(LAST_OPEN_KEY, '{garbage');
    expect(readLastOpen()).toBeNull();
    localStorage.setItem(LAST_OPEN_KEY, JSON.stringify({ workspace: '', sessionPath: 'x' }));
    expect(readLastOpen()).toBeNull();
    writeLastOpen(null);
    expect(localStorage.getItem(LAST_OPEN_KEY)).toBeNull();
  });
});

describe('lastOpenFromState', () => {
  it('会话打开时记会话；草稿时会话为 null；还没进工作区时不记', () => {
    expect(lastOpenFromState({ activeWorkspace: 'D:/p', activeSessionPath: 'D:/p/.pi/a.jsonl', draftConversationCwd: null })).toEqual({
      workspace: 'D:/p',
      sessionPath: 'D:/p/.pi/a.jsonl',
    });
    expect(lastOpenFromState({ activeWorkspace: 'D:/p', activeSessionPath: '', draftConversationCwd: 'D:\\P' })).toEqual({
      workspace: 'D:/p',
      sessionPath: null,
    });
    // 草稿标记属于别的工作区：当前工作区仍按它自己的会话记
    expect(lastOpenFromState({ activeWorkspace: 'D:/p', activeSessionPath: 'D:/p/.pi/a.jsonl', draftConversationCwd: 'D:/q' })).toEqual({
      workspace: 'D:/p',
      sessionPath: 'D:/p/.pi/a.jsonl',
    });
    expect(lastOpenFromState({ activeWorkspace: '', activeSessionPath: 'x', draftConversationCwd: null })).toBeNull();
  });

  it('lastOpenEquals 按两个字段比较', () => {
    expect(lastOpenEquals(null, null)).toBe(true);
    expect(lastOpenEquals({ workspace: 'a', sessionPath: null }, null)).toBe(false);
    expect(lastOpenEquals({ workspace: 'a', sessionPath: 'x' }, { workspace: 'a', sessionPath: 'x' })).toBe(true);
    expect(lastOpenEquals({ workspace: 'a', sessionPath: 'x' }, { workspace: 'a', sessionPath: null })).toBe(false);
  });
});

describe('pickStartupTarget', () => {
  const sessions = [
    session('D:/proj', 'D:/proj/.pi/a.jsonl'),
    session(`${works}/conv1`, `${works}/conv1/.pi/b.jsonl`),
    session('D:/old', 'D:/old/.pi/c.jsonl', true),
  ];

  it('记住的会话还在：打开它，工作区以列表里的 cwd 为准（分隔符无关）', () => {
    expect(pickStartupTarget({ workspace: 'D:\\proj', sessionPath: 'D:\\proj\\.pi\\a.jsonl' }, sessions, works)).toEqual({
      kind: 'session',
      workspace: 'D:/proj',
      sessionPath: 'D:/proj/.pi/a.jsonl',
    });
    expect(pickStartupTarget({ workspace: `${works}/conv1`, sessionPath: `${works}/conv1/.pi/b.jsonl` }, sessions, works)).toEqual({
      kind: 'session',
      workspace: `${works}/conv1`,
      sessionPath: `${works}/conv1/.pi/b.jsonl`,
    });
  });

  it('会话已删或已归档：不恢复', () => {
    expect(pickStartupTarget({ workspace: 'D:/proj', sessionPath: 'D:/proj/.pi/gone.jsonl' }, sessions, works)).toBeNull();
    expect(pickStartupTarget({ workspace: 'D:/old', sessionPath: 'D:/old/.pi/c.jsonl' }, sessions, works)).toBeNull();
  });

  it('项目里的空草稿回到那个项目；works 下的空白对话交给原来的 scratch 逻辑', () => {
    expect(pickStartupTarget({ workspace: 'D:/proj', sessionPath: null }, sessions, works)).toEqual({ kind: 'projectDraft', workspace: 'D:/proj' });
    expect(pickStartupTarget({ workspace: `${works}/abc`, sessionPath: null }, sessions, works)).toBeNull();
    // worksDir 取不到时没法判断是不是 works 下的目录，按项目草稿处理
    expect(pickStartupTarget({ workspace: `${works}/abc`, sessionPath: null }, sessions, '')).toEqual({ kind: 'projectDraft', workspace: `${works}/abc` });
  });

  it('没有记忆：null', () => {
    expect(pickStartupTarget(null, sessions, works)).toBeNull();
  });
});
