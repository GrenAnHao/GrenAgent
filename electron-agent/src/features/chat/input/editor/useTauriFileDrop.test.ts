// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { $createParagraphNode, $getRoot, createEditor } from 'lexical';
import type { IEditor } from '@lobehub/editor';
import type { GrenRuntimeBridge } from '../../../../platform/runtime';
import { useTauriFileDrop } from './useTauriFileDrop';

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

vi.mock('electron', () => electron);
vi.mock('@lobehub/editor', () => ({ INSERT_MENTION_COMMAND: 'INSERT_MENTION_COMMAND' }));
vi.mock('./useFileMention', () => ({
  loadFiles: async () => ({
    root: 'C:/repo',
    files: [{ path: 'src', isDirectory: true }],
    expiresAt: Infinity,
  }),
}));

let bridge: GrenRuntimeBridge;

beforeAll(async () => {
  await import('../../../../../electron/preload');
  bridge = electron.contextBridge.exposeInMainWorld.mock.calls[0][1];
});

beforeEach(() => {
  window.gren = bridge;
  vi.stubGlobal('devicePixelRatio', 2);
  electron.webUtils.getPathForFile.mockReturnValue('C:\\outside\\sample.png');
  electron.ipcRenderer.invoke.mockImplementation(async (_channel, request) => {
    switch (request.command) {
      case 'register_dropped_files': return;
      case 'read_dropped_file':
      case 'read_file_binary': return { mime_type: 'image/png', data: 'aW1hZ2U=', size: 5 };
      case 'import_dropped_file': return '.pi/dropped/hash/sample.bin';
      default: throw new Error(`Unexpected command: ${request.command}`);
    }
  });
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  delete window.gren;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function mountInput() {
  const zone = document.createElement('div');
  const target = document.createElement('div');
  target.contentEditable = 'true';
  zone.append(target);
  document.body.append(zone);
  vi.spyOn(zone, 'getBoundingClientRect').mockReturnValue({
    left: 100, right: 400, top: 100, bottom: 300,
  } as DOMRect);

  const lexical = createEditor({ onError: (error) => { throw error; } });
  lexical.update(() => $getRoot().append($createParagraphNode()), { discrete: true });
  const editor = {
    focus: () => lexical.update(() => $getRoot().selectEnd(), { discrete: true }),
    getLexicalEditor: () => lexical,
    dispatchCommand: vi.fn(),
  };
  const onImages = vi.fn();
  const onPastedText = vi.fn();
  const zoneRef = { current: zone };
  const hook = renderHook(() => useTauriFileDrop({
    editor: editor as unknown as IEditor,
    workspace: 'C:/repo', zoneRef, onImages, onPastedText,
  }));
  return {
    ...hook, zone, target, editor, onImages, onPastedText,
    text: () => lexical.getEditorState().read(() => $getRoot().getTextContent()),
  };
}

function drag(target: HTMLElement, type: string, options: {
  files?: File[];
  text?: string;
  types?: string[];
  x?: number;
  y?: number;
  relatedTarget?: EventTarget | null;
} = {}) {
  const transfer = {
    files: options.files ?? [],
    types: options.types ?? (options.files ? ['Files'] : ['text/plain']),
    getData: (format: string) => format === 'text/plain' ? options.text ?? '' : '',
    dropEffect: 'none',
  };
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true,
    clientX: options.x ?? 350, clientY: options.y ?? 250,
    relatedTarget: options.relatedTarget,
  });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  act(() => { target.dispatchEvent(event); });
  return { event, transfer };
}

function selectMessage(text: string) {
  const source = document.createElement('p');
  source.textContent = text;
  document.body.append(source);
  const range = document.createRange();
  range.selectNodeContents(source);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  return source;
}

function mockBinary(mime: string, content: string) {
  electron.ipcRenderer.invoke.mockImplementation(async (_channel, request) => {
    if (request.command === 'register_dropped_files') return;
    if (request.command === 'import_dropped_file') return '.pi/dropped/hash/sample.bin';
    return { mime_type: mime, data: btoa(content), size: content.length };
  });
}

describe('Electron input drag and drop through preload', () => {
  it('attaches a dropped file once at the correct position on a scaled display', async () => {
    const input = mountInput();
    const file = new File(['image'], 'sample.png', { type: 'image/png' });
    const defaultDrop = vi.fn();
    input.target.addEventListener('drop', defaultDrop);

    const over = drag(input.target, 'dragover', { files: [file] });
    expect(input.result.current.dragOver).toBe(true);
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.transfer.dropEffect).toBe('copy');
    const drop = drag(input.target, 'drop', { files: [file] });

    await waitFor(() => expect(input.onImages).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ name: 'sample.png', mimeType: 'image/png', data: 'aW1hZ2U=' }),
    ]));
    expect(electron.webUtils.getPathForFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(electron.ipcRenderer.invoke.mock.calls[0][1]).toEqual({
      command: 'register_dropped_files', args: { paths: ['C:\\outside\\sample.png'] },
    });
    expect(drop.event.defaultPrevented).toBe(true);
    expect(defaultDrop).not.toHaveBeenCalled();
    expect(input.result.current.dragOver).toBe(false);
  });

  it('reads every file in a multi-file drop', async () => {
    const input = mountInput();
    electron.webUtils.getPathForFile.mockImplementation((file: File) => `C:/outside/${file.name}`);
    drag(input.target, 'drop', { files: [new File(['a'], 'a.png'), new File(['b'], 'b.png')] });
    await waitFor(() => expect(input.onImages).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ name: 'a.png' }), expect.objectContaining({ name: 'b.png' }),
    ]));
  });

  it('turns a workspace text file into a path reference, not its content', async () => {
    const input = mountInput();
    electron.webUtils.getPathForFile.mockReturnValue('C:\\repo\\readme.md');
    mockBinary('text/plain', '# readme\nline 2');
    drag(input.target, 'drop', { files: [new File(['# readme'], 'readme.md')] });
    await waitFor(() => expect(input.onPastedText).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ source: 'readme.md', referenceOnly: true, text: '', lines: 2 }),
    ));
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalledWith('gren:invoke', expect.objectContaining({
      command: 'import_dropped_file',
    }));
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('gren:invoke', {
      command: 'read_file_binary', args: { workspace: 'C:/repo', path: 'readme.md' },
    });
  });

  it('imports every external text file in a multi-file drop as a reference, small ones included', async () => {
    const input = mountInput();
    electron.webUtils.getPathForFile.mockImplementation((file: File) => `C:/outside/${file.name}`);
    electron.ipcRenderer.invoke.mockImplementation(async (_channel, request) => {
      if (request.command === 'register_dropped_files') return;
      if (request.command === 'import_dropped_file') return `.pi/dropped/h/${request.args.path.split('/').pop()}`;
      return { mime_type: 'text/markdown', data: btoa('a\nb\nc'), size: 5 };
    });
    drag(input.target, 'drop', { files: [new File(['a'], 'one.md'), new File(['b'], 'two.md'), new File(['c'], 'three.md')] });
    await waitFor(() => expect(input.onPastedText).toHaveBeenCalledTimes(3));
    expect(input.onPastedText.mock.calls.map(([chip]) => chip)).toEqual([
      expect.objectContaining({ source: '.pi/dropped/h/one.md', referenceOnly: true, text: '', lines: 3 }),
      expect.objectContaining({ source: '.pi/dropped/h/two.md', referenceOnly: true, text: '' }),
      expect.objectContaining({ source: '.pi/dropped/h/three.md', referenceOnly: true, text: '' }),
    ]);
  });

  it('imports a large external text file as a reference', async () => {
    const input = mountInput();
    electron.webUtils.getPathForFile.mockReturnValue('C:/outside/large.txt');
    mockBinary('text/plain', 'x'.repeat(33_000));
    drag(input.target, 'drop', { files: [new File(['large'], 'large.txt')] });
    await waitFor(() => expect(input.onPastedText).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ source: '.pi/dropped/hash/sample.bin', referenceOnly: true, text: '' }),
    ));
  });

  it('imports an external binary file as a file mention', async () => {
    const input = mountInput();
    electron.webUtils.getPathForFile.mockReturnValue('C:/outside/sample.bin');
    mockBinary('application/octet-stream', 'binary');
    drag(input.target, 'drop', { files: [new File(['binary'], 'sample.bin')] });
    await waitFor(() => expect(input.editor.dispatchCommand).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({
        metadata: expect.objectContaining({ path: '.pi/dropped/hash/sample.bin', isDirectory: false }),
      }),
    ));
  });

  it('references a workspace directory without reading it as a file', async () => {
    const input = mountInput();
    electron.webUtils.getPathForFile.mockReturnValue('C:/repo/src');
    drag(input.target, 'drop', { files: [new File([], 'src')] });
    await waitFor(() => expect(input.editor.dispatchCommand).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({
        metadata: expect.objectContaining({ path: 'src', isDirectory: true }),
      }),
    ));
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(1);
  });

  it('inserts selected message text once', async () => {
    const input = mountInput();
    const source = selectMessage('selected message');
    drag(source, 'dragstart');
    drag(input.target, 'dragover');
    expect(input.result.current.dragKind).toBe('text');
    drag(input.target, 'drop', { text: 'selected message' });
    drag(source, 'dragend');
    await waitFor(() => expect(input.text()).toBe('selected message'));
    expect(input.onPastedText).not.toHaveBeenCalled();
  });

  it('leaves dragging existing editor text to the editor', () => {
    const input = mountInput();
    const lexical = input.editor.getLexicalEditor();
    vi.spyOn(input.editor, 'getLexicalEditor').mockReturnValue({
      getRootElement: () => input.target,
      update: lexical.update.bind(lexical),
    } as typeof lexical);
    input.target.textContent = 'move these words';
    const range = document.createRange();
    range.selectNodeContents(input.target);
    window.getSelection()?.addRange(range);
    const defaultDrop = vi.fn();
    input.target.addEventListener('drop', defaultDrop);

    drag(input.target, 'dragstart', { text: 'move these words' });
    const over = drag(input.target, 'dragover');
    const drop = drag(input.target, 'drop', { text: 'move these words' });

    expect(input.result.current.dragOver).toBe(false);
    expect(over.event.defaultPrevented).toBe(false);
    expect(drop.event.defaultPrevented).toBe(false);
    expect(defaultDrop).toHaveBeenCalledTimes(1);
    expect(input.onImages).not.toHaveBeenCalled();
    expect(input.onPastedText).not.toHaveBeenCalled();
  });

  it('inserts plain text dragged from another application', async () => {
    const input = mountInput();
    drag(input.target, 'dragover');
    expect(input.result.current.dragKind).toBe('text');
    drag(input.target, 'drop', { text: 'external text' });
    await waitFor(() => expect(input.text()).toBe('external text'));
  });

  it('folds long dragged text into a text chip', async () => {
    const input = mountInput();
    const text = 'line\n'.repeat(20);
    drag(input.target, 'drop', { text });
    await waitFor(() => expect(input.onPastedText).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text }),
    ));
    expect(input.text()).toBe('');
  });

  it('attaches an in-app image instead of its URL or an old text selection', async () => {
    const input = mountInput();
    selectMessage('old selection');
    const source = document.createElement('div');
    source.draggable = true;
    const image = document.createElement('img');
    image.src = 'data:image/png;base64,aW1hZ2U=';
    source.append(image);
    document.body.append(source);
    drag(source, 'dragstart');
    drag(input.target, 'dragover');
    expect(input.result.current.dragKind).toBe('image');
    drag(input.target, 'drop', { text: image.src });
    await waitFor(() => expect(input.onImages).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ mimeType: 'image/png', data: 'aW1hZ2U=' }),
    ]));
    expect(input.text()).toBe('');
  });

  it('does not import files outside the input or navigate to the dropped file', () => {
    const input = mountInput();
    drag(input.target, 'dragover');
    const drop = drag(document.body, 'drop', { files: [new File([], 'sample.png')], x: 20, y: 20 });
    expect(drop.event.defaultPrevented).toBe(true);
    expect(input.result.current.dragOver).toBe(false);
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(input.onImages).not.toHaveBeenCalled();
  });

  it('preserves default text drops outside the input and ignores unrelated drag types', () => {
    const input = mountInput();
    const outside = drag(document.body, 'drop', { text: 'outside', x: 20, y: 20 });
    expect(outside.event.defaultPrevented).toBe(false);
    const unrelated = drag(input.target, 'dragover', { types: ['application/x-tab'] });
    expect(unrelated.event.defaultPrevented).toBe(false);
    expect(input.result.current.dragOver).toBe(false);
  });

  it('keeps the hint between children and clears it on leaving or cancelling', () => {
    const input = mountInput();
    drag(input.target, 'dragenter');
    expect(input.result.current.dragOver).toBe(true);
    drag(input.target, 'dragleave', { relatedTarget: input.zone });
    expect(input.result.current.dragOver).toBe(true);
    drag(input.target, 'dragleave');
    expect(input.result.current.dragOver).toBe(false);
    drag(input.target, 'dragover');
    drag(input.target, 'dragend');
    expect(input.result.current.dragOver).toBe(false);
  });

  it('removes listeners when the editor is unmounted', async () => {
    const first = mountInput();
    await act(async () => {});
    first.unmount();
    const second = mountInput();
    drag(second.target, 'drop', { files: [new File(['image'], 'sample.png')] });
    await waitFor(() => expect(second.onImages).toHaveBeenCalledTimes(1));
    expect(first.onImages).not.toHaveBeenCalled();
    expect(electron.webUtils.getPathForFile).toHaveBeenCalledTimes(1);
  });
});
