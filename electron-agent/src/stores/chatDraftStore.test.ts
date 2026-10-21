// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
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

  it('clearDraft 只删自己的 key', () => {
    store().setDraft('a', 'x');
    store().setDraft('b', 'y');
    store().clearDraft('a');
    expect(store().getDraft('a').text).toBe('');
    expect(store().getDraft('b').text).toBe('y');
  });
});
