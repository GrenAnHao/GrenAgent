import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readView, openPath } = vi.hoisted(() => ({ readView: vi.fn(), openPath: vi.fn() }));
vi.mock('../../lib/files', () => ({ files: { readView } }));
vi.mock('../../platform/runtime', () => ({ openPath }));

import { useDockStore } from '../../stores/dockStore';
import { useFileOpenRequests } from '../../stores/fileOpenRequests';
import { useLayoutStore } from '../../stores/layoutStore';
import { openWorkspaceFile } from './openWorkspaceFile';

function reset() {
  localStorage.clear();
  useDockStore.setState({ tabs: [], closedTabs: [], activeByRegion: { right: null, bottom: null } });
  useLayoutStore.setState({ rightPanelOpen: false, terminalOpen: false });
  useFileOpenRequests.setState({ byTab: {} });
  readView.mockReset();
  openPath.mockReset();
  openPath.mockResolvedValue(undefined);
}

const text = { kind: 'text', content: 'x', size: 1, truncated: false };

describe('openWorkspaceFile', () => {
  beforeEach(reset);

  it('opens a readable text file in the right-side file tab and does not touch the system', async () => {
    readView.mockResolvedValue(text);
    await expect(openWorkspaceFile('D:/ws/src/a.ts', 'D:/ws')).resolves.toBe('dock');

    const tabs = useDockStore.getState().tabs.filter((t) => t.kind === 'file');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].region).toBe('right');
    expect(useDockStore.getState().activeByRegion.right).toBe(tabs[0].id);
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
    expect(useFileOpenRequests.getState().byTab[tabs[0].id]?.path).toBe('D:/ws/src/a.ts');
    expect(openPath).not.toHaveBeenCalled();
  });

  it('opens a file outside the project in a file tab rooted at its own directory, reusing it across slash styles', async () => {
    readView.mockResolvedValue(text);
    await openWorkspaceFile('D:/ws/a.ts', 'D:\\ws');
    await openWorkspaceFile('E:/extract/docs/r.md', 'E:\\extract');
    await openWorkspaceFile('E:/extract/docs/s.md', 'E:/extract');

    const tabs = useDockStore.getState().tabs.filter((t) => t.kind === 'file');
    expect(tabs.map((t) => (t.payload as { workspace: string }).workspace)).toEqual(['D:\\ws', 'E:\\extract']);
    expect(readView).toHaveBeenCalledWith('E:/extract', 'E:/extract/docs/s.md');
    expect(useFileOpenRequests.getState().byTab[tabs[1].id]?.path).toBe('E:/extract/docs/s.md');
  });

  it('focuses the existing file tab instead of creating another one', async () => {
    readView.mockResolvedValue(text);
    await openWorkspaceFile('D:/ws/a.ts', 'D:/ws');
    await openWorkspaceFile('D:/ws/b.md', 'D:/ws');

    const tabs = useDockStore.getState().tabs.filter((t) => t.kind === 'file');
    expect(tabs).toHaveLength(1);
    expect(useFileOpenRequests.getState().byTab[tabs[0].id]?.path).toBe('D:/ws/b.md');
  });

  it('switches the right region to the file tab without closing the tab that was active', async () => {
    readView.mockResolvedValue(text);
    useDockStore.getState().addTab({ id: 'browser:1', kind: 'browser', region: 'right', title: '浏览器', closable: true, payload: { url: 'about:blank', title: '浏览器' } });
    await openWorkspaceFile('D:/ws/a.ts', 'D:/ws');
    const fileTab = useDockStore.getState().tabs.find((t) => t.kind === 'file');
    expect(useDockStore.getState().activeByRegion.right).toBe(fileTab?.id);
    expect(useDockStore.getState().tabs.some((t) => t.id === 'browser:1')).toBe(true);
  });

  it('falls back to the system program for binary files without opening the tab', async () => {
    readView.mockResolvedValue({ kind: 'binary', size: 9 });
    await expect(openWorkspaceFile('D:/ws/a.zip', 'D:/ws')).resolves.toBe('system');
    expect(openPath).toHaveBeenCalledWith('D:/ws/a.zip');
    expect(useDockStore.getState().tabs).toHaveLength(0);
    expect(useFileOpenRequests.getState().byTab).toEqual({});
  });

  it('falls back to the system program for files over the read limit', async () => {
    readView.mockResolvedValue({ kind: 'text', content: 'head', size: 9_000_000, truncated: true });
    await expect(openWorkspaceFile('D:/ws/big.log', 'D:/ws')).resolves.toBe('system');
    expect(openPath).toHaveBeenCalledWith('D:/ws/big.log');
    expect(useDockStore.getState().tabs).toHaveLength(0);
  });

  it('opens images in the right-side tab without probing them', async () => {
    await expect(openWorkspaceFile('D:/ws/a.png', 'D:/ws')).resolves.toBe('dock');
    expect(readView).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
    expect(useDockStore.getState().tabs.some((t) => t.kind === 'file')).toBe(true);
  });

  it('shows read failures inside the tab instead of falling back to the system program', async () => {
    readView.mockRejectedValue(new Error('File does not exist'));
    await expect(openWorkspaceFile('D:/ws/gone.txt', 'D:/ws')).resolves.toBe('dock');
    expect(openPath).not.toHaveBeenCalled();
    expect(Object.values(useFileOpenRequests.getState().byTab)[0]?.path).toBe('D:/ws/gone.txt');
  });

  it('propagates a system-open failure to the caller', async () => {
    readView.mockResolvedValue({ kind: 'binary', size: 9 });
    openPath.mockRejectedValue(new Error('no handler'));
    await expect(openWorkspaceFile('D:/ws/a.zip', 'D:/ws')).rejects.toThrow('no handler');
  });
});

describe('useFileOpenRequests', () => {
  beforeEach(reset);

  it('keeps a newer request when an older one is consumed', () => {
    const { request, consume } = useFileOpenRequests.getState();
    request('t', '/a');
    const first = useFileOpenRequests.getState().byTab.t;
    request('t', '/b');
    consume('t', first.nonce);
    expect(useFileOpenRequests.getState().byTab.t?.path).toBe('/b');
    consume('t', useFileOpenRequests.getState().byTab.t.nonce);
    expect(useFileOpenRequests.getState().byTab.t).toBeUndefined();
  });
});
