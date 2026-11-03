import { beforeEach, describe, expect, it, vi } from 'vitest';

const { disk } = vi.hoisted(() => ({ disk: new Map<string, string>() }));
vi.mock('../../../lib/idbStorage', () => ({
  createIdbStorage: () => ({
    getItem: async (key: string) => disk.get(key) ?? null,
    setItem: async (key: string, value: string) => { disk.set(key, value); },
    removeItem: async (key: string) => { disk.delete(key); },
    getKeys: async () => [...disk.keys()],
    setItemIfAbsent: async (key: string, value: string) => { if (!disk.has(key)) disk.set(key, value); },
  }),
}));
import type { ImageAttachment } from './ChatInputContext';
import type { PastedText } from './editor/types';
import {
  EMPTY_COMPOSER_FILES,
  mergeComposerFiles,
  reviveComposerFiles,
  stripAttachmentUrls,
  useComposerFilesStore,
} from './composerFiles';

const image = (data: string): ImageAttachment => ({
  type: 'image',
  mimeType: 'image/png',
  data,
  name: `${data}.png`,
  url: `blob:${data}`,
});

const chip = (id: string): PastedText => ({ id, text: id, lines: 1, chars: id.length });

const store = () => useComposerFilesStore.getState();

describe('composerFiles store', () => {
  beforeEach(() => {
    useComposerFilesStore.setState({ byKey: {} });
  });

  it('keeps each key in its own bucket', () => {
    store().addAttachments('a', [image('1')]);
    store().addPastedText('b', chip('p1'));
    expect(store().byKey.a?.attachments).toHaveLength(1);
    expect(store().byKey.a?.pastedTexts).toHaveLength(0);
    expect(store().byKey.b?.pastedTexts).toHaveLength(1);
    expect(store().byKey.b?.attachments).toHaveLength(0);
  });

  it('removes an attachment by index and a pasted chip by id', () => {
    store().addAttachments('a', [image('1'), image('2'), image('3')]);
    store().addPastedText('a', chip('p1'));
    store().addPastedText('a', chip('p2'));
    store().removeAttachment('a', 1);
    store().removePastedText('a', 'p1');
    expect(store().byKey.a?.attachments.map((i) => i.data)).toEqual(['1', '3']);
    expect(store().byKey.a?.pastedTexts.map((p) => p.id)).toEqual(['p2']);
  });

  it('drops a bucket once it is empty so keys do not pile up', () => {
    store().addAttachments('a', [image('1')]);
    store().addPastedText('a', chip('p1'));
    store().removeAttachment('a', 0);
    expect(store().byKey.a).toBeDefined();
    store().removePastedText('a', 'p1');
    expect(store().byKey.a).toBeUndefined();
  });

  it('clear only touches its own key and is a no-op for an unknown key', () => {
    store().addAttachments('a', [image('1')]);
    store().addAttachments('b', [image('2')]);
    const before = store().byKey;
    store().clear('missing');
    expect(store().byKey).toBe(before);
    store().clear('a');
    expect(store().byKey.a).toBeUndefined();
    expect(store().byKey.b?.attachments).toHaveLength(1);
  });

  it('restore puts a snapshot back and ignores an empty one', () => {
    store().restore('a', { attachments: [image('1')], pastedTexts: [chip('p1')] });
    expect(store().byKey.a?.attachments).toHaveLength(1);
    expect(store().byKey.a?.pastedTexts).toHaveLength(1);
    store().restore('b', { attachments: [], pastedTexts: [] });
    expect(store().byKey.b).toBeUndefined();
  });

  it('adopts only the sending draft and routes late attachments to its created session', () => {
    store().addAttachments('draft:source', [image('source')]);
    store().addPastedText('draft:other', chip('other'));
    store().adopt('draft:source', '/proj/a.jsonl');
    expect(store().byKey['draft:source']).toBeUndefined();
    expect(store().byKey['/proj/a.jsonl']?.attachments[0].data).toBe('source');
    store().addPastedText('draft:source', chip('late'));
    expect(store().byKey['/proj/a.jsonl']?.pastedTexts[0].id).toBe('late');
    expect(store().byKey['draft:other']?.pastedTexts[0].id).toBe('other');
  });

  it('removed session attachments cannot be resurrected by a delayed failure rollback', () => {
    store().addAttachments('draft:gone', [image('old')]);
    store().adopt('draft:gone', '/proj/gone.jsonl');
    store().remove('/proj/gone.jsonl');
    store().restore('draft:gone', { attachments: [image('late')], pastedTexts: [] });
    store().addAttachments('/proj/gone.jsonl', [image('late')]);
    expect(store().byKey['/proj/gone.jsonl']).toBeUndefined();
    expect(store().byKey['draft:gone']).toBeUndefined();
  });

  it('a stale window cannot erase attachments saved by another window under a different draft', async () => {
    disk.clear();
    vi.resetModules();
    const windowA = (await import('./composerFiles')).useComposerFilesStore;
    await windowA.persist.rehydrate();
    windowA.getState().addAttachments('draft:window-a', [image('A')]);
    vi.resetModules();
    const windowB = (await import('./composerFiles')).useComposerFilesStore;
    await windowB.persist.rehydrate();
    windowB.getState().addAttachments('draft:window-b', [image('B')]);
    windowA.getState().addPastedText('draft:window-a', chip('A edited'));
    vi.resetModules();
    const reopened = (await import('./composerFiles')).useComposerFilesStore;
    await reopened.persist.rehydrate();
    expect(reopened.getState().byKey['draft:window-a']?.attachments[0].data).toBe('A');
    expect(reopened.getState().byKey['draft:window-b']?.attachments[0].data).toBe('B');
  });

  it('只在旧整表中的附件迁成独立桶，其他窗口更新镜像后仍可恢复', async () => {
    disk.clear();
    disk.set('pi-composer-files', JSON.stringify({ state: { byKey: {
      'draft:legacy-only': { attachments: [image('legacy')], pastedTexts: [] },
    } }, version: 0 }));
    vi.resetModules();
    const upgraded = (await import('./composerFiles')).useComposerFilesStore;
    await upgraded.persist.rehydrate();
    expect(upgraded.getState().byKey['draft:legacy-only']?.attachments[0].data).toBe('legacy');
    // 另一个窗口重写旧诊断镜像；它不拥有尚未编辑的 legacy-only 桶。
    disk.set('pi-composer-files', JSON.stringify({ state: { byKey: {} }, version: 0 }));
    vi.resetModules();
    const reopened = (await import('./composerFiles')).useComposerFilesStore;
    await reopened.persist.rehydrate();
    expect(reopened.getState().byKey['draft:legacy-only']?.attachments[0].data).toBe('legacy');
  });

  it('exposes one frozen empty value so selectors keep a stable reference', () => {
    expect(EMPTY_COMPOSER_FILES.attachments).toHaveLength(0);
    expect(EMPTY_COMPOSER_FILES.pastedTexts).toHaveLength(0);
    expect(Object.isFrozen(EMPTY_COMPOSER_FILES)).toBe(true);
  });
});

describe('composerFiles persistence shape', () => {
  it('落盘时去掉 url，读回来用 data 重建 data URL', () => {
    const stored = stripAttachmentUrls({ a: { attachments: [image('AAAA')], pastedTexts: [chip('p1')] } });
    expect(stored.a.attachments[0]).toEqual({ type: 'image', mimeType: 'image/png', data: 'AAAA', name: 'AAAA.png' });
    expect('url' in stored.a.attachments[0]).toBe(false);
    const revived = reviveComposerFiles(JSON.parse(JSON.stringify(stored)));
    expect(revived.a.attachments[0].url).toBe('data:image/png;base64,AAAA');
    expect(revived.a.pastedTexts).toEqual([chip('p1')]);
  });

  it('形状不对的条目和空桶丢掉', () => {
    expect(reviveComposerFiles(undefined)).toEqual({});
    expect(reviveComposerFiles({ a: null, b: { attachments: [{ foo: 1 }], pastedTexts: [{ id: 'x' }] } })).toEqual({});
    const revived = reviveComposerFiles({ c: { attachments: [{ mimeType: 'image/jpeg', data: 'BB' }] } });
    expect(revived.c.attachments[0]).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'BB',
      name: 'image',
      url: 'data:image/jpeg;base64,BB',
    });
    expect(revived.c.pastedTexts).toEqual([]);
  });

  it('hydration 合并时内存里已有的桶优先，其余 key 从存档补上', () => {
    const persisted = { a: { attachments: [image('old')], pastedTexts: [] }, b: { attachments: [image('b')], pastedTexts: [] } };
    const current = { a: { attachments: [image('new')], pastedTexts: [] } };
    const merged = mergeComposerFiles(persisted, current);
    expect(merged.a.attachments[0].data).toBe('new');
    expect(merged.b.attachments[0].data).toBe('b');
  });
});
