import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STARTUP_SCRATCH_KEY,
  canReuseScratch,
  markScratchUsed,
  readRememberedScratch,
  rememberScratch,
} from './startupConversation';

const works = 'C:/Users/me/.pi/agent/works';

describe('canReuseScratch', () => {
  it('reuses a remembered scratch that is under works and never persisted', () => {
    expect(canReuseScratch(`${works}/abc`, works, [])).toBe(true);
    expect(canReuseScratch(`${works}/abc`, works, ['D:/proj', null])).toBe(true);
  });

  it('does not reuse once the scratch has been used (appears in sessions)', () => {
    // 大小写 / 分隔符差异也应判定为同一目录（已落盘 → 不复用）。
    expect(canReuseScratch(`${works}/abc`, works, [`${works}\\ABC`])).toBe(false);
  });

  it('does not reuse a path outside the works directory', () => {
    expect(canReuseScratch('D:/some/project', works, [])).toBe(false);
  });

  it('returns false when nothing is remembered', () => {
    expect(canReuseScratch('', works, [])).toBe(false);
    expect(canReuseScratch(null, works, [])).toBe(false);
    expect(canReuseScratch(undefined, works, [])).toBe(false);
  });

  it('falls back to under-check skip when worksDir unknown', () => {
    // worksDir 取不到时不卡 isUnder，仅靠「是否已落盘」判定。
    expect(canReuseScratch('C:/whatever/x', '', [])).toBe(true);
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
