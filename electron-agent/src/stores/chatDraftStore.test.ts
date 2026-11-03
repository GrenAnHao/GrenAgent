// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatDraftStore } from './chatDraftStore';

const store = () => useChatDraftStore.getState();
const json = { root: { type: 'root', children: [{ type: 'command-pill', name: 'refactor' }] } };

describe('chatDraftStore', () => {
  beforeEach(() => {
    useChatDraftStore.setState({ drafts: {} });
  });

  it('老的字符串草稿读成 { text }，新草稿带 json', () => {
    useChatDraftStore.setState({ drafts: { old: '旧文本' } });
    expect(store().getDraft('old')).toEqual({ text: '旧文本' });
    store().setDraft('new', { text: '/refactor "a"', json });
    expect(store().getDraft('new')).toEqual({ text: '/refactor "a"', json });
    expect(store().getDraft('missing')).toEqual({ text: '' });
  });

  it('内容没变不写，变了才换引用；空草稿删 key', () => {
    store().setDraft('k', { text: 'a', json });
    const before = store().drafts;
    store().setDraft('k', { text: 'a', json: structuredClone(json) });
    expect(store().drafts).toBe(before);
    store().setDraft('k', { text: 'a' });
    expect(store().drafts).not.toBe(before);
    expect(store().getDraft('k')).toEqual({ text: 'a' });
    store().setDraft('k', '');
    expect('k' in store().drafts).toBe(false);
  });

  it('字符串草稿覆盖带 json 的草稿时 json 一起丢掉', () => {
    store().setDraft('k', { text: 'a', json });
    store().setDraft('k', 'a');
    expect(store().getDraft('k')).toEqual({ text: 'a' });
  });

  it('首发过户后迟到的草稿保存归新会话，另一个草稿不动', () => {
    store().setDraft('draft:source', { text: '/refactor "a"', json });
    store().setDraft('draft:other', 'other');
    store().adopt('draft:source', '/proj/a.jsonl');
    expect(store().getDraft('/proj/a.jsonl')).toEqual({ text: '/refactor "a"', json });
    expect(store().drafts['draft:source']).toBeUndefined();
    store().setDraft('draft:source', 'late edit');
    expect(store().getDraft('/proj/a.jsonl').text).toBe('late edit');
    expect(store().getDraft('draft:other').text).toBe('other');
  });

  it('删除会话后迟到的保存不能复活它，其他会话存档保留', () => {
    store().setDraft('draft:deleted-source', 'sent');
    store().adopt('draft:deleted-source', '/proj/deleted.jsonl');
    store().setDraft('/proj/other.jsonl', 'keep');
    store().remove('/proj/deleted.jsonl');
    store().setDraft('draft:deleted-source', 'late completion');
    store().setDraft('/proj/deleted.jsonl', 'late unmount');
    expect(store().drafts['/proj/deleted.jsonl']).toBeUndefined();
    expect(store().getDraft('/proj/other.jsonl').text).toBe('keep');
  });

  it('另一窗口保存不同草稿后，持有旧快照的窗口不能覆盖它的磁盘存档', async () => {
    store().setDraft('draft:window-a', 'A');
    const staleWindow = { ...store().drafts };
    store().setDraft('draft:window-b', 'B stays');
    // A 窗口仍持有 B 创建之前的内存快照。
    useChatDraftStore.setState({ drafts: staleWindow });
    store().setDraft('draft:window-a', 'A edited');
    vi.resetModules();
    const reloaded = await import('./chatDraftStore');
    expect(reloaded.useChatDraftStore.getState().getDraft('draft:window-b').text).toBe('B stays');
    expect(reloaded.useChatDraftStore.getState().getDraft('draft:window-a').text).toBe('A edited');
  });

  it('clearDraft 只删自己的 key', () => {
    store().setDraft('a', 'x');
    store().setDraft('b', 'y');
    store().clearDraft('a');
    expect(store().getDraft('a').text).toBe('');
    expect(store().getDraft('b').text).toBe('y');
  });
});
