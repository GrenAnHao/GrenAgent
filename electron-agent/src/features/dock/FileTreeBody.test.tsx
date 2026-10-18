import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilesChangedEvent } from '../../lib/files';

const api = vi.hoisted(() => ({
  listDir: vi.fn(),
  readView: vi.fn(),
  readBinary: vi.fn(),
  write: vi.fn(),
  openExternal: vi.fn(),
  watchDirs: vi.fn(),
  unwatchDirs: vi.fn(),
  onChanged: vi.fn(),
}));
vi.mock('../../lib/files', () => ({ files: api }));
vi.mock('../chat/LazyMarkdown', () => ({
  LazyMarkdown: ({ children }: { children: string }) => <div data-testid="md-render">{children}</div>,
}));
vi.mock('../fileExplorer/CodeEditor', () => ({
  default: (props: { value: string; docVersion: number; readOnly: boolean; onChange: (doc: string) => void }) => (
    <textarea
      key={props.docVersion}
      data-testid="mock-editor"
      data-readonly={String(props.readOnly)}
      defaultValue={props.value}
      readOnly={props.readOnly}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));

import { useFileOpenRequests } from '../../stores/fileOpenRequests';
import { canCloseDockTab } from './dockCloseGuards';
import { FileTreeBody } from './FileTreeBody';

const tab = {
  id: 'file:right:/repo',
  kind: 'file' as const,
  region: 'right' as const,
  title: '文件',
  closable: true,
  order: 0,
  payload: { workspace: '/repo' },
};

const entry = (path: string, isDir = false) => ({ name: path.split('/').pop()!, path, isDir, size: isDir ? null : 10 });

let emitChange: (event: FilesChangedEvent) => void = () => {};

/** 全局测试桩里 modal.confirm 会直接点确定；这里改成记下配置，由用例决定点哪个按钮。 */
interface ConfirmConfig {
  title?: ReactNode;
  onOk?: () => void;
  onCancel?: () => void;
  footer?: (origin: ReactNode, parts: { OkBtn: () => ReactNode; CancelBtn: () => ReactNode }) => ReactNode;
}
const confirms: ConfirmConfig[] = [];

beforeEach(() => {
  confirms.length = 0;
  const noop = () => {};
  vi.mocked(App.useApp).mockReturnValue({
    message: { success: noop, error: noop, info: noop, warning: noop, loading: noop, open: noop, destroy: noop },
    notification: { success: noop, error: noop, info: noop, warning: noop, open: noop, destroy: noop },
    modal: {
      confirm: (config: ConfirmConfig) => {
        confirms.push(config);
        return { destroy: noop, update: noop };
      },
    },
  } as never);
  api.listDir.mockImplementation(async (_ws: string, dir: string) => {
    if (dir === '') return { dir: '/repo', truncated: false, entries: [entry('/repo/src', true), entry('/repo/README.md'), entry('/repo/a.ts')] };
    if (dir === '/repo/src') return { dir, truncated: false, entries: [entry('/repo/src/b.ts')] };
    throw new Error(`unexpected dir ${dir}`);
  });
  api.readView.mockImplementation(async (_ws: string, path: string) => {
    if (path.endsWith('.md')) return { kind: 'text', content: '# Hello', size: 7, truncated: false };
    if (path.endsWith('.bin')) return { kind: 'binary', size: 99 };
    if (path.endsWith('.log')) return { kind: 'text', content: 'head', size: 6_000_000, truncated: true };
    return { kind: 'text', content: 'const a = 1;', size: 12, truncated: false };
  });
  api.write.mockResolvedValue(undefined);
  api.watchDirs.mockResolvedValue(undefined);
  api.unwatchDirs.mockResolvedValue(undefined);
  api.onChanged.mockImplementation(async (handler: (event: FilesChangedEvent) => void) => {
    emitChange = handler;
    return () => {};
  });
});

afterEach(() => {
  useFileOpenRequests.setState({ byTab: {} });
  cleanup();
  vi.clearAllMocks();
});

function renderBody() {
  return render(
    <App>
      <FileTreeBody tab={tab} active />
    </App>,
  );
}

async function openFile(name: string) {
  fireEvent.click(await screen.findByText(name));
}

describe('FileTreeBody (file explorer)', () => {
  it('lists only the root first and lists a folder when it is expanded', async () => {
    renderBody();
    expect(await screen.findByText('README.md')).toBeTruthy();
    expect(api.listDir).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('b.ts')).toBeNull();

    fireEvent.click(screen.getByText('src'));
    expect(await screen.findByText('b.ts')).toBeTruthy();
    expect(api.listDir).toHaveBeenLastCalledWith('/repo', '/repo/src');
  });

  it('previews markdown by default and switches to the editor', async () => {
    renderBody();
    await openFile('README.md');
    expect((await screen.findByTestId('md-render')).textContent).toBe('# Hello');
    expect(screen.queryByTestId('mock-editor')).toBeNull();

    fireEvent.keyDown(screen.getByTestId('file-explorer'), { key: 'e', ctrlKey: true });
    const editor = (await screen.findByTestId('mock-editor')) as HTMLTextAreaElement;
    expect(editor.dataset.readonly).toBe('false');
  });

  it('opens code read-only, then edits and saves with Ctrl+S', async () => {
    renderBody();
    await openFile('a.ts');
    const editor = (await screen.findByTestId('mock-editor')) as HTMLTextAreaElement;
    expect(editor.dataset.readonly).toBe('true');
    expect((screen.getByTestId('file-save') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText('编辑'));
    await waitFor(() => expect(editor.dataset.readonly).toBe('false'));
    fireEvent.change(editor, { target: { value: 'const a = 2;' } });
    expect(screen.getByTestId('file-dirty-dot')).toBeTruthy();

    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    await waitFor(() => expect(api.write).toHaveBeenCalledWith('/repo', '/repo/a.ts', 'const a = 2;'));
    await waitFor(() => expect(screen.queryByTestId('file-dirty-dot')).toBeNull());
  });

  it('asks before switching away from unsaved changes and before closing the tab', async () => {
    renderBody();
    await openFile('a.ts');
    const editor = (await screen.findByTestId('mock-editor')) as HTMLTextAreaElement;
    fireEvent.click(screen.getByText('编辑'));
    await waitFor(() => expect(editor.dataset.readonly).toBe('false'));
    fireEvent.change(editor, { target: { value: 'changed' } });
    expect(screen.getByTestId('file-dirty-dot')).toBeTruthy();

    let closing: Promise<boolean> = Promise.resolve(true);
    act(() => {
      closing = canCloseDockTab(tab.id);
    });
    expect(confirms[0]?.title).toBe('a.ts 有未保存的修改');
    act(() => confirms[0].onCancel?.());
    await expect(closing).resolves.toBe(false);

    await openFile('README.md');
    await waitFor(() => expect(confirms).toHaveLength(2));
    // 渲染真实的对话框底栏，点「放弃修改」。
    const footer = render(<>{confirms[1].footer?.(null, { OkBtn: () => <button>保存</button>, CancelBtn: () => <button>取消</button> })}</>);
    fireEvent.click(footer.getByTestId('file-unsaved-discard'));
    expect((await screen.findByTestId('md-render')).textContent).toBe('# Hello');
    expect(api.write).not.toHaveBeenCalled();
  });

  it('shows binary files as unsupported and truncated files read-only with a tag', async () => {
    api.listDir.mockImplementationOnce(async () => ({
      dir: '/repo',
      truncated: false,
      entries: [entry('/repo/app.bin'), entry('/repo/big.log')],
    }));
    renderBody();
    await openFile('app.bin');
    expect(await screen.findByTestId('file-unsupported')).toBeTruthy();

    await openFile('big.log');
    expect(await screen.findByTestId('file-truncated-tag')).toBeTruthy();
    expect(screen.getByTestId('file-truncated')).toBeTruthy();
    expect(screen.getByTestId('file-mode-switch').className).toContain('disabled');
  });

  it('re-lists a loaded directory when the watcher reports a change, and watches it', async () => {
    renderBody();
    fireEvent.click(await screen.findByText('src'));
    await screen.findByText('b.ts');
    await waitFor(() => expect(api.watchDirs).toHaveBeenLastCalledWith('/repo', tab.id, ['/repo', '/repo/src']), { timeout: 2000 });

    api.listDir.mockImplementationOnce(async (_ws: string, dir: string) => ({ dir, truncated: false, entries: [entry('/repo/src/b.ts'), entry('/repo/src/c.ts')] }));
    act(() => emitChange({ watchId: tab.id, workspace: '/repo', dirs: ['/repo/src'], paths: ['/repo/src/c.ts'] }));
    expect(await screen.findByText('c.ts')).toBeTruthy();

    act(() => emitChange({ watchId: 'someone-else', workspace: '/repo', dirs: ['/repo'], paths: [] }));
    expect(api.listDir).toHaveBeenCalledTimes(3);
  });

  it('opens a file requested from outside, expands its folders and highlights it in the tree', async () => {
    act(() => useFileOpenRequests.getState().request(tab.id, '/repo/src/b.ts'));
    renderBody();
    expect((await screen.findByTestId('mock-editor') as HTMLTextAreaElement).value).toBe('const a = 1;');
    expect(api.readView).toHaveBeenCalledWith('/repo', '/repo/src/b.ts');
    const tree = await screen.findByTestId('file-tree');
    await waitFor(() => expect(tree.querySelector('[data-tree-row][data-selected="true"]')?.textContent).toContain('b.ts'));
    expect(useFileOpenRequests.getState().byTab[tab.id]).toBeUndefined();
  });

  it('keeps the file, tree width and collapsed state when the same file is requested again', async () => {
    localStorage.setItem('hermes-file-explorer-tree-width', '300');
    renderBody();
    await openFile('a.ts');
    await screen.findByTestId('mock-editor');
    const callsBefore = api.readView.mock.calls.length;

    act(() => useFileOpenRequests.getState().request(tab.id, '/repo/a.ts'));
    await waitFor(() => expect(useFileOpenRequests.getState().byTab[tab.id]).toBeUndefined());
    expect(api.readView.mock.calls.length).toBe(callsBefore);
    expect(screen.getAllByTestId('mock-editor')).toHaveLength(1);
    expect((screen.getByTestId('file-explorer-tree') as HTMLElement).style.width).toBe('300px');
    localStorage.removeItem('hermes-file-explorer-tree-width');
  });

  it('asks about unsaved changes before an external request replaces the open file', async () => {
    renderBody();
    await openFile('a.ts');
    const editor = (await screen.findByTestId('mock-editor')) as HTMLTextAreaElement;
    fireEvent.click(screen.getByText('编辑'));
    await waitFor(() => expect(editor.dataset.readonly).toBe('false'));
    fireEvent.change(editor, { target: { value: 'changed' } });

    act(() => useFileOpenRequests.getState().request(tab.id, '/repo/README.md'));
    await waitFor(() => expect(confirms).toHaveLength(1));
    act(() => confirms[0].onCancel?.());
    await waitFor(() => expect(useFileOpenRequests.getState().byTab[tab.id]).toBeUndefined());
    expect(screen.queryByTestId('md-render')).toBeNull();
    expect((screen.getByTestId('mock-editor') as HTMLTextAreaElement).value).toBe('changed');
  });

  it('shows retry when the root cannot be listed', async () => {
    api.listDir.mockRejectedValueOnce(new Error('boom'));
    renderBody();
    expect(await screen.findByTestId('file-tree-error')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    expect(await screen.findByText('README.md')).toBeTruthy();
  });
});
