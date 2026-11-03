import { describe, expect, it } from 'vitest';
import { readComposerOwnerKey } from './composerOwner';

const draftState = {
  draftConversationCwd: '/ws',
  draftConversationId: 'draft:one',
  activeSessionPath: null as string | null,
};

describe('readComposerOwnerKey', () => {
  it('uses the active draft id so two drafts of the same workspace stay apart', () => {
    expect(readComposerOwnerKey('/ws', undefined, draftState)).toBe('draft:one');
    expect(
      readComposerOwnerKey('/ws', undefined, { ...draftState, draftConversationId: 'draft:two' }),
    ).toBe('draft:two');
  });

  it('falls back to the workspace when an old host has no draft id', () => {
    expect(
      readComposerOwnerKey('/ws', undefined, { ...draftState, draftConversationId: null }),
    ).toBe('/ws');
  });

  it('uses the raw session path, not a normalized copy', () => {
    const path = 'D:\\Repo\\.pi\\sessions\\A.JSONL';
    expect(
      readComposerOwnerKey('/ws', undefined, {
        draftConversationCwd: null,
        draftConversationId: null,
        activeSessionPath: path,
      }),
    ).toBe(path);
  });

  it('lets an explicit scope win over the globally active session', () => {
    const snapshot = {
      draftConversationCwd: null,
      draftConversationId: null,
      activeSessionPath: '/ws/global.jsonl',
    };
    // 第二个视图固定看 A：不能因为全局当前是 B 就把 B 的值当成 A 的。
    expect(readComposerOwnerKey('/ws', { sessionPath: '/ws/a.jsonl' }, snapshot)).toBe('/ws/a.jsonl');
    expect(readComposerOwnerKey('/ws', { draftId: 'draft:x' }, snapshot)).toBe('draft:x');
    // 显式空 scope：这个视图没有会话，只能是草稿，不借用全局当前会话。
    expect(readComposerOwnerKey('/ws', { sessionPath: null, draftId: null }, snapshot)).toBe('/ws');
  });

  it('ignores a draft of another workspace', () => {
    expect(
      readComposerOwnerKey('/ws', undefined, {
        draftConversationCwd: '/other',
        draftConversationId: 'draft:other',
        activeSessionPath: '/ws/a.jsonl',
      }),
    ).toBe('/ws/a.jsonl');
  });
});
