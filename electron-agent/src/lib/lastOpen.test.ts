import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('草稿重载还原同一身份，而不是复用同项目另一份草稿', async () => {
    writeLastOpen({ workspace: 'D:/proj', sessionPath: null, draftId: 'draft:one' });
    expect(readLastOpen()).toEqual({ workspace: 'D:/proj', sessionPath: null, draftId: 'draft:one' });
    expect(lastOpenFromState({ activeWorkspace: 'D:/proj', activeSessionPath: '', draftConversationCwd: 'D:/proj', draftConversationId: 'draft:one' }))
      .toEqual({ workspace: 'D:/proj', sessionPath: null, draftId: 'draft:one' });
    expect(lastOpenEquals({ workspace: 'D:/proj', sessionPath: null, draftId: 'draft:one' }, { workspace: 'D:/proj', sessionPath: null, draftId: 'draft:two' })).toBe(false);
    expect(await pickStartupTarget({ workspace: 'D:/proj', sessionPath: null, draftId: 'draft:one' }, disk()))
      .toEqual({ kind: 'projectDraft', workspace: 'D:/proj', draftId: 'draft:one' });
  });

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

function disk(row: SessionInfo | null = null, used = false) {
  return {
    lookupStartupSession: vi.fn(async (_path: string) => row),
    startupScratchHasSessions: vi.fn(async (_workspace: string) => used),
    getWorksDir: vi.fn(async () => works),
  };
}

describe('pickStartupTarget', () => {
  it('只查记住的文件；迁移后用文件的当前归属，不必等待 worksDir', async () => {
    const moved = session('D:/new', 'D:/sessions/a.jsonl');
    const io = disk(moved);
    expect(await pickStartupTarget({ workspace: 'D:/old', sessionPath: moved.path }, io)).toEqual({
      kind: 'session', workspace: 'D:/new', session: moved,
    });
    expect(io.lookupStartupSession).toHaveBeenCalledExactlyOnceWith(moved.path);
    expect(io.getWorksDir).not.toHaveBeenCalled();
    expect(io.startupScratchHasSessions).not.toHaveBeenCalled();
  });

  it('已删除、已归档或没有记忆的会话不恢复', async () => {
    const last = { workspace: 'D:/old', sessionPath: 'D:/sessions/a.jsonl' };
    expect(await pickStartupTarget(last, disk())).toBeNull();
    expect(await pickStartupTarget(last, disk(session(last.workspace, last.sessionPath, true)))).toBeNull();
    const io = disk();
    expect(await pickStartupTarget(null, io)).toBeNull();
    expect(io.lookupStartupSession).not.toHaveBeenCalled();
    expect(io.getWorksDir).not.toHaveBeenCalled();
  });

  it('项目草稿不读会话，works 草稿只在原身份存在且目录仍未使用时恢复', async () => {
    const io = disk();
    expect(await pickStartupTarget({ workspace: 'D:/proj', sessionPath: null }, io))
      .toEqual({ kind: 'projectDraft', workspace: 'D:/proj' });
    expect(io.startupScratchHasSessions).not.toHaveBeenCalled();
    const last = { workspace: works + '/conv', sessionPath: null, draftId: 'draft:one' };
    expect(await pickStartupTarget(last, io)).toEqual({ kind: 'projectDraft', workspace: last.workspace, draftId: last.draftId });
    expect(io.startupScratchHasSessions).toHaveBeenCalledExactlyOnceWith(last.workspace);
    expect(await pickStartupTarget(last, disk(null, true))).toBeNull();
    expect(await pickStartupTarget({ ...last, draftId: undefined }, io)).toBeNull();
    expect(io.lookupStartupSession).not.toHaveBeenCalled();
  });

  it('worksDir 暂不可用时保留原有的项目草稿恢复规则', async () => {
    const io = disk();
    io.getWorksDir.mockRejectedValue(new Error('offline'));
    expect(await pickStartupTarget({ workspace: 'D:/proj', sessionPath: null }, io))
      .toEqual({ kind: 'projectDraft', workspace: 'D:/proj' });
  });
});
