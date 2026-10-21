import { beforeEach, describe, expect, it } from 'vitest';
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
