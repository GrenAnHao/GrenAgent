import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STARTUP_SCRATCH_KEY,
  acquireDraftScratch,
  markScratchUsed,
  readRememberedScratch,
  rememberScratch,
} from './startupConversation';

const works = 'C:/Users/me/.pi/agent/works';

describe('acquireDraftScratch', () => {
  beforeEach(() => localStorage.clear());
  const io = () => ({
    startupScratchHasSessions: vi.fn(async (_cwd: string) => false),
    createConversation: vi.fn(async () => ({ cwd: works + '/new' })),
  });

  it('没有记忆就直接创建；下次只核对这一个目录', async () => {
    const api = io();
    expect(await acquireDraftScratch(api)).toBe(works + '/new');
    expect(api.startupScratchHasSessions).not.toHaveBeenCalled();
    expect(await acquireDraftScratch(api)).toBe(works + '/new');
    expect(api.startupScratchHasSessions).toHaveBeenCalledExactlyOnceWith(works + '/new');
    expect(api.createConversation).toHaveBeenCalledTimes(1);
  });

  it.each(['used', 'unavailable'])('不复用已占用或无法确认的草稿：%s', async (state) => {
    const api = io();
    rememberScratch(works + '/old');
    if (state === 'used') api.startupScratchHasSessions.mockResolvedValue(true);
    else api.startupScratchHasSessions.mockRejectedValue(new Error('cannot inspect'));
    expect(await acquireDraftScratch(api)).toBe(works + '/new');
    expect(readRememberedScratch()).toBe(works + '/new');
  });
});

describe('scratch 记忆读写', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('rememberScratch / readRememberedScratch 往返', () => {
    expect(readRememberedScratch()).toBe('');
    rememberScratch(`${works}/abc`);
    expect(readRememberedScratch()).toBe(`${works}/abc`);
    expect(localStorage.getItem(STARTUP_SCRATCH_KEY)).toBe(`${works}/abc`);
  });

  it('markScratchUsed 清除匹配的记忆（分隔符/大小写无关）', () => {
    rememberScratch(`${works}/abc`);
    markScratchUsed(`${works}\\ABC`);
    expect(readRememberedScratch()).toBe('');
  });

  it('markScratchUsed 不动不匹配的记忆', () => {
    rememberScratch(`${works}/abc`);
    markScratchUsed(`${works}/other`);
    expect(readRememberedScratch()).toBe(`${works}/abc`);
  });
});
