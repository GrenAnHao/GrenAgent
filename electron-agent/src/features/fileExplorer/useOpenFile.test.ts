import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readView, readBinary, write } = vi.hoisted(() => ({
  readView: vi.fn(),
  readBinary: vi.fn(),
  write: vi.fn(),
}));
vi.mock('../../lib/files', () => ({ files: { readView, readBinary, write } }));

import { useOpenFile, type TextFile } from './useOpenFile';

const text = (content: string, extra: Partial<{ size: number; truncated: boolean }> = {}) => ({
  kind: 'text' as const,
  content,
  size: extra.size ?? content.length,
  truncated: extra.truncated ?? false,
});

function setup(choice: 'save' | 'discard' | 'cancel' = 'cancel') {
  const confirm = vi.fn(async () => choice);
  const hook = renderHook(() => useOpenFile('/ws', confirm));
  return { confirm, hook, current: () => hook.result.current };
}

const asText = (state: unknown) => state as TextFile;

beforeEach(() => {
  write.mockResolvedValue(undefined);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useOpenFile', () => {
  it('opens markdown in preview mode and plain text read-only, keeping CRLF', async () => {
    readView.mockResolvedValueOnce(text('# Title\r\nbody'));
    const { current } = setup();
    await act(() => current().open('/ws/README.md'));
    expect(current().file).toMatchObject({ status: 'text', kind: 'markdown', mode: 'preview', lineSeparator: '\r\n' });

    readView.mockResolvedValueOnce(text('{"a":1}'));
    await act(() => current().open('/ws/a.json'));
    expect(current().file).toMatchObject({ status: 'text', kind: 'text', mode: 'preview', lineSeparator: '\n' });
    expect(readView).toHaveBeenLastCalledWith('/ws', '/ws/a.json');
  });

  it('marks edits dirty and saves the edited content to disk', async () => {
    readView.mockResolvedValueOnce(text('a'));
    const { current } = setup();
    await act(() => current().open('/ws/a.ts'));
    act(() => current().setMode('edit'));
    act(() => current().setContent('ab'));
    expect(current().dirty).toBe(true);

    let ok = false;
    await act(async () => {
      ok = await current().save();
    });
    expect(ok).toBe(true);
    expect(write).toHaveBeenCalledWith('/ws', '/ws/a.ts', 'ab');
    expect(current().dirty).toBe(false);
    expect(asText(current().file).mode).toBe('edit');
  });

  it('keeps the file when switching is cancelled, and discards or saves on request', async () => {
    readView.mockResolvedValue(text('a'));
    const cancel = setup('cancel');
    await act(() => cancel.current().open('/ws/a.ts'));
    act(() => cancel.current().setContent('changed'));
    await act(() => cancel.current().open('/ws/b.ts'));
    expect(cancel.confirm).toHaveBeenCalledWith('a.ts');
    expect(asText(cancel.current().file).path).toBe('/ws/a.ts');

    const discard = setup('discard');
    await act(() => discard.current().open('/ws/a.ts'));
    act(() => discard.current().setContent('changed'));
    await act(() => discard.current().open('/ws/b.ts'));
    expect(asText(discard.current().file).path).toBe('/ws/b.ts');
    expect(write).not.toHaveBeenCalled();

    const save = setup('save');
    await act(() => save.current().open('/ws/a.ts'));
    act(() => save.current().setContent('changed'));
    await act(() => save.current().open('/ws/b.ts'));
    expect(write).toHaveBeenCalledWith('/ws', '/ws/a.ts', 'changed');
    expect(asText(save.current().file).path).toBe('/ws/b.ts');
  });

  it('never enters edit mode or saves a truncated file', async () => {
    readView.mockResolvedValueOnce(text('head', { size: 9_000_000, truncated: true }));
    const { current } = setup();
    await act(() => current().open('/ws/big.log'));
    act(() => current().setMode('edit'));
    expect(asText(current().file).mode).toBe('preview');
    await act(async () => {
      expect(await current().save()).toBe(false);
    });
  });

  it('reloads silently when clean, prompts when dirty, and respects keep-local', async () => {
    readView.mockResolvedValueOnce(text('v1'));
    const { current } = setup();
    await act(() => current().open('/ws/src/a.ts'));
    const firstVersion = asText(current().file).docVersion;

    // 自己刚保存触发的事件：内容一样，什么都不变。
    readView.mockResolvedValueOnce(text('v1'));
    await act(async () => current().onFilesChanged({ dirs: ['/ws/src'], paths: ['/ws/src/a.ts'] }));
    expect(asText(current().file).docVersion).toBe(firstVersion);

    readView.mockResolvedValueOnce(text('v2'));
    await act(async () => current().onFilesChanged({ dirs: ['/ws/src'], paths: [] }));
    expect(asText(current().file)).toMatchObject({ content: 'v2', original: 'v2', disk: 'same' });
    expect(asText(current().file).docVersion).not.toBe(firstVersion);

    act(() => current().setContent('mine'));
    readView.mockResolvedValueOnce(text('v3'));
    await act(async () => current().onFilesChanged({ dirs: ['/ws/src'], paths: ['/ws/src/a.ts'] }));
    expect(asText(current().file)).toMatchObject({ content: 'mine', disk: 'changed' });

    act(() => current().keepLocal());
    readView.mockResolvedValueOnce(text('v3'));
    await act(async () => current().onFilesChanged({ dirs: ['/ws/src'], paths: ['/ws/src/a.ts'] }));
    expect(asText(current().file).disk).toBe('same');

    readView.mockResolvedValueOnce(text('v3'));
    await act(() => current().reloadFromDisk());
    expect(asText(current().file)).toMatchObject({ content: 'v3', original: 'v3' });
    expect(current().dirty).toBe(false);
  });

  it('does not reread a file when only a sibling in the same directory is named', async () => {
    readView.mockResolvedValueOnce(text('v1'));
    const { current } = setup();
    await act(() => current().open('/ws/src/a.ts'));
    const reads = readView.mock.calls.length;
    await act(async () => current().onFilesChanged({ dirs: ['/ws/src'], paths: ['/ws/src/b.ts'] }));
    expect(readView).toHaveBeenCalledTimes(reads);

    readView.mockResolvedValueOnce(text('v2'));
    await act(async () => current().onFilesChanged({ dirs: ['/ws/src'], paths: [] }));
    expect(asText(current().file).content).toBe('v2');
  });

  it('marks dirty as soon as the editor is touched, and save writes the editor text', async () => {
    readView.mockResolvedValueOnce(text('v1'));
    const { current } = setup();
    await act(() => current().open('/ws/src/a.ts'));
    let live = 'v1';
    act(() => current().bindEditorText(() => live));
    act(() => current().noteEdit());
    expect(current().dirty).toBe(true);
    expect(asText(current().file).content).toBe('v1');
    live = 'v1 changed';
    await act(async () => {
      expect(await current().save()).toBe(true);
    });
    expect(write).toHaveBeenCalledWith('/ws', '/ws/src/a.ts', 'v1 changed');
    expect(current().dirty).toBe(false);
    expect(asText(current().file).content).toBe('v1 changed');
  });

  it('ignores changes in other directories and flags a deleted file', async () => {
    readView.mockResolvedValueOnce(text('v1'));
    const { current } = setup();
    await act(() => current().open('/ws/src/a.ts'));
    await act(async () => current().onFilesChanged({ dirs: ['/ws/lib'], paths: ['/ws/lib/x.ts'] }));
    expect(readView).toHaveBeenCalledTimes(1);

    readView.mockRejectedValueOnce(new Error('File does not exist'));
    await act(async () => current().onFilesChanged({ dirs: ['/ws/src'], paths: ['/ws/src/a.ts'] }));
    expect(asText(current().file).disk).toBe('deleted');
  });

  it('shows binary files as unsupported and images through a blob URL', async () => {
    readView.mockResolvedValueOnce({ kind: 'binary', size: 42 });
    const { current } = setup();
    await act(() => current().open('/ws/app.exe'));
    expect(current().file).toEqual({ status: 'binary', path: '/ws/app.exe', size: 42 });

    readBinary.mockResolvedValueOnce({ mime_type: 'image/png', data: 'iVBORw==', size: 4 });
    await act(() => current().open('/ws/logo.png'));
    expect(current().file).toEqual({ status: 'image', path: '/ws/logo.png', size: 4, url: 'blob:x' });
  });

  it('reports a load failure as an error state', async () => {
    readView.mockRejectedValueOnce(new Error('Path escapes workspace'));
    const { current } = setup();
    await act(() => current().open('/ws/../etc'));
    expect(current().file).toEqual({ status: 'error', path: '/ws/../etc', message: 'Path escapes workspace' });
  });
});
