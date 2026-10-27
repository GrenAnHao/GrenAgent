import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const browser = vi.hoisted(() => ({
  openInAppBrowser: vi.fn(() => true),
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
const toast = vi.hoisted(() => ({ warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() }));

vi.mock('../../lib/files', () => ({ files: api }));
vi.mock('../dock/browser/openInAppBrowser', () => ({ openInAppBrowser: browser.openInAppBrowser }));
vi.mock('../../platform/runtime', async (original) => ({
  ...(await original<typeof import('../../platform/runtime')>()),
  openUrl: browser.openUrl,
  revealItemInDir: browser.revealItemInDir,
}));
// 预览的真实渲染（lobe Markdown）在 jsdom 里太重：换成固定的一组链接，链接拦截逻辑在 MarkdownPreview 自己身上。
vi.mock('../chat/LazyMarkdown', () => ({
  LazyMarkdown: () => (
    <article>
      <h2>Section Two</h2>
      <p>
        <a href="./docs/guide.md">relative</a>
        <a href="docs/my%20notes.md?plain=1#top">spaced</a>
        <a href="./docs/">dir</a>
        <a href="./gone.md">missing</a>
        <a href="../../outside.md">outside</a>
        <a href="https://example.com/x">web</a>
        <a href="mailto:a@b.c">mail</a>
        <a href="#section-two">anchor</a>
        <a href="#nowhere">badanchor</a>
        <a href="./docs/guide.md">
          <img alt="badge" src="https://img.test/b.svg" />
        </a>
      </p>
    </article>
  ),
}));
vi.mock('../fileExplorer/CodeEditor', () => ({ default: () => <div data-testid="mock-editor" /> }));

import { registerComposerInsertFile } from '../chat/input/composerBridge';
import { useFileOpenRequests } from '../../stores/fileOpenRequests';
import { useFilePathModeStore } from '../../stores/filePathModeStore';
import { FileTreeBody } from './FileTreeBody';

const tab = {
  id: 'file:right:/repo',
  kind: 'file' as const,
  region: 'right' as const,
  title: '文件管理器',
  closable: true,
  order: 0,
  payload: { workspace: '/repo' },
};
const entry = (path: string, isDir = false) => ({ name: path.split('/').pop()!, path, isDir, size: isDir ? null : 10 });

const clipboard = { writeText: vi.fn(() => Promise.resolve()) };

beforeEach(() => {
  const noop = () => {};
  vi.mocked(App.useApp).mockReturnValue({
    message: { ...toast, loading: noop, open: noop, destroy: noop },
    notification: {},
    modal: { confirm: noop },
  } as never);
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  HTMLElement.prototype.scrollTo = vi.fn();
  useFilePathModeStore.setState({ mode: 'relative' });
  api.listDir.mockImplementation(async (_ws: string, dir: string) => {
    if (dir === '' || dir === '/repo') {
      return { dir: '/repo', truncated: false, entries: [entry('/repo/docs', true), entry('/repo/src', true), entry('/repo/README.md')] };
    }
    if (dir === '/repo/docs') return { dir, truncated: false, entries: [entry('/repo/docs/guide.md'), entry('/repo/docs/my notes.md')] };
    if (dir === '/repo/src') return { dir, truncated: false, entries: [entry('/repo/src/app.ts')] };
    throw new Error(`unexpected dir ${dir}`);
  });
  api.readView.mockImplementation(async () => ({ kind: 'text', content: '# x', size: 3, truncated: false }));
  api.watchDirs.mockResolvedValue(undefined);
  api.unwatchDirs.mockResolvedValue(undefined);
  api.onChanged.mockResolvedValue(() => {});
});

afterEach(() => {
  useFileOpenRequests.setState({ byTab: {} });
  cleanup();
  vi.clearAllMocks();
});

async function openReadme() {
  render(
    <App>
      <FileTreeBody tab={tab} active />
    </App>,
  );
  fireEvent.click(await screen.findByText('README.md'));
  await screen.findByText('relative');
  api.readView.mockClear();
}

/** 点链接，返回 preventDefault 是否生效（fireEvent 在被阻止默认行为时返回 false）。 */
function clickLink(text: string, init: MouseEventInit = {}): boolean {
  return !fireEvent.click(screen.getByText(text), init);
}

describe('markdown 预览里的链接', () => {
  it('相对链接：阻止应用跳转，在文件管理器里打开对应文件，并展开所在目录', async () => {
    await openReadme();
    expect(clickLink('relative')).toBe(true);
    await waitFor(() => expect(api.readView).toHaveBeenCalledWith('/repo', '/repo/docs/guide.md'));
    await waitFor(() => expect(screen.getByText('my notes.md')).toBeTruthy());
    expect(browser.openInAppBrowser).not.toHaveBeenCalled();
  });

  it('含空格 + query + hash 的路径：解码后打开', async () => {
    await openReadme();
    clickLink('spaced');
    await waitFor(() => expect(api.readView).toHaveBeenCalledWith('/repo', '/repo/docs/my notes.md'));
  });

  it('图片外面包着的链接：点图片和点文字一样', async () => {
    await openReadme();
    expect(!fireEvent.click(screen.getByAltText('badge'))).toBe(true);
    await waitFor(() => expect(api.readView).toHaveBeenCalledWith('/repo', '/repo/docs/guide.md'));
  });

  it('目录链接：只在文件树里展开，不读文件', async () => {
    await openReadme();
    clickLink('dir');
    await waitFor(() => expect(screen.getByText('guide.md')).toBeTruthy());
    expect(api.readView).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('docs'));
  });

  it('不存在的文件：提示，当前文档不动', async () => {
    await openReadme();
    expect(clickLink('missing')).toBe(true);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('gone.md')));
    expect(api.readView).not.toHaveBeenCalled();
    expect(screen.getByText('relative')).toBeTruthy();
  });

  it('指向项目之外 / 不支持的协议：提示，不跳转', async () => {
    await openReadme();
    expect(clickLink('outside')).toBe(true);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('项目之外')));
    expect(clickLink('mail')).toBe(true);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('mailto')));
    expect(api.readView).not.toHaveBeenCalled();
  });

  it('外链：在内置浏览器打开；Ctrl 点击改用系统浏览器', async () => {
    await openReadme();
    expect(clickLink('web')).toBe(true);
    await waitFor(() => expect(browser.openInAppBrowser).toHaveBeenCalledWith('https://example.com/x'));
    clickLink('web', { ctrlKey: true });
    await waitFor(() => expect(browser.openUrl).toHaveBeenCalledWith('https://example.com/x'));
    expect(browser.openInAppBrowser).toHaveBeenCalledTimes(1);
  });

  it('锚点：在预览里滚动，不打开任何东西；找不到时提示', async () => {
    await openReadme();
    expect(clickLink('anchor')).toBe(true);
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
    expect(browser.openInAppBrowser).not.toHaveBeenCalled();
    expect(api.readView).not.toHaveBeenCalled();
    expect(clickLink('badanchor')).toBe(true);
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('nowhere'));
  });
});

describe('工具栏：后退 / 前进 / 刷新', () => {
  // 每个打开过的文件标签都挂着一份查看器（藏起来的不卸载），工具栏按钮只认当前标签里的那份。
  const activePane = () => document.querySelector<HTMLElement>('[data-testid="file-tab-pane"][data-active="true"]')!;
  const activePath = () => activePane()?.dataset.path;
  const btn = (id: string) => within(activePane()).getByTestId(id) as HTMLButtonElement;

  it('面包屑只显示末尾两级，前面折成省略号', async () => {
    await openReadme();
    expect(btn('file-viewer-path').textContent).toBe('README.md');
    fireEvent.click(screen.getByText('docs'));
    await screen.findByText('guide.md');
    fireEvent.click(screen.getByText('guide.md'));
    await waitFor(() => expect(btn('file-viewer-path').textContent).toBe('docs/guide.md'));
    api.listDir.mockImplementation(async (_ws: string, dir: string) => ({
      dir: dir || '/repo',
      truncated: false,
      entries: dir === '/repo/docs/a/b' ? [entry('/repo/docs/a/b/deep.md')] : [entry('/repo/README.md')],
    }));
    useFileOpenRequests.getState().request(tab.id, '/repo/docs/a/b/deep.md');
    await waitFor(() => expect(btn('file-viewer-path').textContent).toBe('…/b/deep.md'));
  });

  it('点过两个文件后可以后退、再前进（切回已开着的标签，不重新读盘）', async () => {
    await openReadme();
    expect(btn('file-nav-back').disabled).toBe(true);
    expect(btn('file-nav-forward').disabled).toBe(true);
    clickLink('relative');
    await waitFor(() => expect(api.readView).toHaveBeenCalledWith('/repo', '/repo/docs/guide.md'));
    await waitFor(() => expect(btn('file-nav-back').disabled).toBe(false));

    api.readView.mockClear();
    fireEvent.click(btn('file-nav-back'));
    await waitFor(() => expect(activePath()).toBe('/repo/README.md'));
    await waitFor(() => expect(btn('file-nav-forward').disabled).toBe(false));
    expect(btn('file-nav-back').disabled).toBe(true);

    fireEvent.click(btn('file-nav-forward'));
    await waitFor(() => expect(activePath()).toBe('/repo/docs/guide.md'));
    await waitFor(() => expect(btn('file-nav-forward').disabled).toBe(true));
    expect(api.readView).not.toHaveBeenCalled();
  });

  it('后退到已经关掉的文件：重新开一个标签', async () => {
    await openReadme();
    clickLink('relative');
    await waitFor(() => expect(activePath()).toBe('/repo/docs/guide.md'));
    const readmeTab = screen.getAllByTestId('file-tab').find((el) => el.dataset.path === '/repo/README.md')!;
    fireEvent.click(within(readmeTab).getByTestId('file-tab-close'));
    await waitFor(() => expect(screen.getAllByTestId('file-tab')).toHaveLength(1));
    api.readView.mockClear();
    fireEvent.click(btn('file-nav-back'));
    await waitFor(() => expect(activePath()).toBe('/repo/README.md'));
    await waitFor(() => expect(api.readView).toHaveBeenCalledWith('/repo', '/repo/README.md'));
    expect(screen.getAllByTestId('file-tab').map((el) => el.dataset.path)).toEqual(['/repo/docs/guide.md', '/repo/README.md']);
  });

  it('Alt+← / Alt+→ 与按钮等效', async () => {
    await openReadme();
    clickLink('relative');
    await waitFor(() => expect(btn('file-nav-back').disabled).toBe(false));
    fireEvent.keyDown(screen.getByTestId('file-explorer'), { key: 'ArrowLeft', altKey: true });
    await waitFor(() => expect(activePath()).toBe('/repo/README.md'));
    fireEvent.keyDown(screen.getByTestId('file-explorer'), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(activePath()).toBe('/repo/docs/guide.md'));
  });

  it('打开失败的文件后工具栏还在，可以退回去', async () => {
    await openReadme();
    api.readView.mockRejectedValueOnce(new Error('File does not exist'));
    useFileOpenRequests.getState().request(tab.id, '/repo/src/missing.ts');
    await waitFor(() => expect(within(activePane()).getByTestId('file-viewer-error')).toBeTruthy());
    expect(btn('file-nav-back').disabled).toBe(false);
    fireEvent.click(btn('file-nav-back'));
    await waitFor(() => expect(activePath()).toBe('/repo/README.md'));
  });

  it('刷新：重新列已加载的目录并重读当前文件，磁盘上新增的文件出现在树里', async () => {
    await openReadme();
    api.listDir.mockClear();
    api.readView.mockClear();
    api.listDir.mockImplementation(async () => ({
      dir: '/repo',
      truncated: false,
      entries: [entry('/repo/docs', true), entry('/repo/README.md'), entry('/repo/NEW.md')],
    }));
    api.readView.mockImplementation(async () => ({ kind: 'text', content: '# changed', size: 9, truncated: false }));
    fireEvent.click(btn('file-nav-refresh'));
    expect(await screen.findByText('NEW.md')).toBeTruthy();
    expect(api.listDir).toHaveBeenCalledWith('/repo', '/repo');
    await waitFor(() => expect(api.readView).toHaveBeenCalledWith('/repo', '/repo/README.md'));
  });

  it('鼠标侧键：后退键后退、前进键前进，并阻止默认行为', async () => {
    await openReadme();
    clickLink('relative');
    await waitFor(() => expect(btn('file-nav-back').disabled).toBe(false));
    const root = screen.getByTestId('file-explorer');

    expect(!fireEvent.mouseDown(root, { button: 3 })).toBe(true);
    expect(!fireEvent.mouseUp(root, { button: 3 })).toBe(true);
    await waitFor(() => expect(activePath()).toBe('/repo/README.md'));
    await waitFor(() => expect(btn('file-nav-forward').disabled).toBe(false));

    // 去重窗口（250ms）之后才能再触发同方向；前进是另一个方向，不受影响。
    fireEvent.mouseUp(root, { button: 4 });
    await waitFor(() => expect(activePath()).toBe('/repo/docs/guide.md'));
  });

  it('左键、右键、中键不触发导航', async () => {
    await openReadme();
    clickLink('relative');
    await waitFor(() => expect(btn('file-nav-back').disabled).toBe(false));
    for (const button of [0, 1, 2]) fireEvent.mouseUp(screen.getByTestId('file-explorer'), { button });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(activePath()).toBe('/repo/docs/guide.md');
  });

  it('系统前进 / 后退（app-command）按焦点认领的文件浏览器导航', async () => {
    await openReadme();
    clickLink('relative');
    await waitFor(() => expect(btn('file-nav-back').disabled).toBe(false));
    // jsdom 没有布局，getClientRects 恒为空；总线用它判断「看得见」，这里装成看得见。
    (screen.getByTestId('file-explorer') as HTMLElement).getClientRects = (() => [{}]) as never;
    (btn('file-viewer') as HTMLElement).focus();
    const { routeNavigation } = await import('../fileExplorer/fileNavBus');
    act(() => void routeNavigation('back', Date.now() + 10_000));
    await waitFor(() => expect(activePath()).toBe('/repo/README.md'));
  });

  it('F5 刷新', async () => {
    await openReadme();
    api.listDir.mockClear();
    fireEvent.keyDown(screen.getByTestId('file-explorer'), { key: 'F5' });
    await waitFor(() => expect(api.listDir).toHaveBeenCalled());
  });
});

describe('文件树右键菜单', () => {
  async function openMenu(name: string) {
    render(
      <App>
        <FileTreeBody tab={tab} active />
      </App>,
    );
    const row = (await screen.findByText(name)).closest('[data-tree-row]') as HTMLElement;
    fireEvent.contextMenu(row);
    await screen.findByText('添加到对话');
    return row;
  }
  const clickItem = async (text: string) => {
    fireEvent.click(screen.getByText(text));
    await waitFor(() => expect(document.querySelector('[data-tree-row][data-menu-open="true"]')).toBeNull());
  };

  afterEach(() => registerComposerInsertFile(null));

  it('右键一行：菜单是「添加到对话 / 在…显示 / 复制路径 / 复制相对路径」，那一行标出来，不打开文件', async () => {
    const row = await openMenu('README.md');
    const labels = [...document.querySelectorAll('.ant-dropdown-menu-item')].map((el) => el.textContent);
    expect(labels).toEqual(['添加到对话', expect.stringMatching(/显示|文件夹/), '复制路径', '复制相对路径']);
    expect(document.querySelectorAll('.ant-dropdown-menu-item-divider')).toHaveLength(2);
    expect(row.dataset.menuOpen).toBe('true');
    expect(api.readView).not.toHaveBeenCalled();
  });

  it('复制路径 / 复制相对路径', async () => {
    await openMenu('README.md');
    await clickItem('复制路径');
    await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith('/repo/README.md'));
    fireEvent.click(screen.getByText('src'));
    fireEvent.contextMenu((await screen.findByText('app.ts')).closest('[data-tree-row]')!);
    await clickItem('复制相对路径');
    await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith('src/app.ts'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已复制：src/app.ts'));
  });

  it('在系统文件管理器中显示：交给主进程定位这一项', async () => {
    await openMenu('docs');
    fireEvent.click(document.querySelectorAll('.ant-dropdown-menu-item')[1]);
    await waitFor(() => expect(browser.revealItemInDir).toHaveBeenCalledWith('/repo/docs'));
  });

  it('添加到对话：把文件 / 目录交给输入框；输入框不在时提示', async () => {
    const insert = vi.fn();
    registerComposerInsertFile(insert);
    await openMenu('docs');
    await clickItem('添加到对话');
    expect(insert).toHaveBeenCalledWith({ absolute: '/repo/docs', relative: 'docs', workspace: '/repo', name: 'docs', isDirectory: true });

    registerComposerInsertFile(null);
    fireEvent.contextMenu(screen.getByText('README.md').closest('[data-tree-row]')!);
    await clickItem('添加到对话');
    expect(toast.warning).toHaveBeenCalledWith('当前没有可以添加的对话输入框');
  });
});

describe('文件树路径栏', () => {
  it('没有选中也没有悬停时给提示，复制不可点', async () => {
    render(
      <App>
        <FileTreeBody tab={tab} active />
      </App>,
    );
    await screen.findByText('README.md');
    expect(screen.getByTestId('file-path-text').textContent).toContain('悬停或选择');
    expect((screen.getByTestId('file-path-copy') as HTMLButtonElement).disabled).toBe(true);
  });

  it('悬停显示该行路径，选中后显示选中项；离开面板回到选中项', async () => {
    await openReadme();
    expect(screen.getByTestId('file-path-text').getAttribute('data-full-path')).toBe('README.md');
    fireEvent.click(screen.getByText('src'));
    fireEvent.pointerEnter((await screen.findByText('app.ts')).closest('[data-tree-row]')!);
    expect(screen.getByTestId('file-path-text').getAttribute('data-full-path')).toBe('src/app.ts');
    expect(screen.getByTestId('file-path-text').dataset.hover).toBe('true');
    fireEvent.pointerLeave(screen.getByTestId('file-explorer-tree'));
    expect(screen.getByTestId('file-path-text').getAttribute('data-full-path')).toBe('README.md');
  });

  it('可切到绝对路径，偏好写进 store；复制的是栏里当前这一行', async () => {
    await openReadme();
    fireEvent.click(screen.getByTestId('file-path-mode'));
    expect(useFilePathModeStore.getState().mode).toBe('absolute');
    expect(screen.getByTestId('file-path-text').getAttribute('data-full-path')).toBe('/repo/README.md');
    await act(async () => {
      fireEvent.click(screen.getByTestId('file-path-copy'));
    });
    expect(clipboard.writeText).toHaveBeenCalledWith('/repo/README.md');
  });

  it('悬停的目录也能看路径并复制（鼠标移到路径栏上仍保留悬停项）', async () => {
    await openReadme();
    fireEvent.pointerEnter(screen.getByText('docs').closest('[data-tree-row]')!);
    expect(screen.getByTestId('file-path-text').getAttribute('data-full-path')).toBe('docs');
    await act(async () => {
      fireEvent.click(screen.getByTestId('file-path-copy'));
    });
    expect(clipboard.writeText).toHaveBeenCalledWith('docs');
  });
});
