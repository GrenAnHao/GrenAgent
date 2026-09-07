// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WikiPanel } from './WikiPanel';
import { agentDataApi } from '../../lib/agentData';
import { mockWikiApi, renderWiki as render } from './wiki/wikiTestSupport';
import { deferred, library, page } from './wiki/wikiTestData';
import { StrictMode } from 'react';

vi.mock('./useProjectOptions', () => ({ useProjectOptions: () => [{ cwd: 'D:/a', name: 'A' }, { cwd: 'D:/b', name: 'B' }] }));
vi.mock('./AgentDataTaskProvider', () => ({ useAgentDataTaskMonitor: () => ({ jobs: [], track: vi.fn(), watchedTaskVersion: 0 }) }));
vi.mock('../chat/LazyMarkdown', () => ({ LazyMarkdown: ({ children }: { children: string }) => <pre>{children}</pre> }));

describe('WikiPanel library navigation', () => {
  beforeEach(mockWikiApi);
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('opens an initial targeted page under StrictMode', async () => {
    render(<StrictMode><WikiPanel navigation={{ view: 'wiki', kbId: 'k', pageId: 'p' }} navigationRequest={1} /></StrictMode>);
    await waitFor(() => expect(screen.getByLabelText('Markdown 正文')).toHaveValue(page.content));
  });

  it('navigates by library plus page id and defers hidden requests', async () => {
    vi.mocked(agentDataApi.wiki.libraries.read).mockImplementation(async (kbId) => ({ ...library, kbId }));
    vi.mocked(agentDataApi.wiki.pages.read).mockImplementation(async (kbId, pageId) => ({ ...page, kbId, pageId, content: `${kbId} 正文` }));
    const { rerender } = render(<WikiPanel visible={false} navigation={{ view: 'wiki', kbId: 'k', pageId: 'p' }} navigationRequest={1} />);
    expect(agentDataApi.wiki.pages.read).not.toHaveBeenCalled();
    rerender(<WikiPanel navigation={{ view: 'wiki', kbId: 'k', pageId: 'p' }} navigationRequest={1} />);
    await waitFor(() => expect(screen.getByLabelText('Markdown 正文')).toHaveValue('k 正文'));
    rerender(<WikiPanel navigation={{ view: 'wiki', kbId: 'k2', pageId: 'p' }} navigationRequest={2} />);
    await waitFor(() => expect(screen.getByLabelText('Markdown 正文')).toHaveValue('k2 正文'));
    expect(agentDataApi.wiki.pages.read).toHaveBeenCalledWith('k2', 'p');
  });

  it('retains a dirty same-library page when targeted page navigation is cancelled', async () => {
    const { rerender } = render(<WikiPanel navigation={{ view: 'wiki', kbId: 'k', pageId: 'p' }} navigationRequest={1} />);
    fireEvent.change(await screen.findByLabelText('Markdown 正文'), { target: { value: '定向导航草稿' } });
    const navigation = { view: 'wiki' as const, kbId: 'k', pageId: 'p2' };
    rerender(<WikiPanel navigation={navigation} navigationRequest={2} />);
    fireEvent.click(await screen.findByRole('button', { name: '继续编辑' }));
    expect(screen.getByLabelText('Markdown 正文')).toHaveValue('定向导航草稿');
    expect(agentDataApi.wiki.pages.read).not.toHaveBeenCalledWith('k', 'p2');
    rerender(<WikiPanel navigation={{ ...navigation }} navigationRequest={2} />);
    expect(screen.queryByRole('button', { name: '继续编辑' })).toBeNull();
  });

  it('does not let an older pending confirmation replace a newer library target', async () => {
    vi.mocked(agentDataApi.wiki.libraries.read).mockImplementation(async (kbId) => ({ ...library, kbId }));
    vi.mocked(agentDataApi.wiki.pages.read).mockImplementation(async (kbId, pageId) => ({ ...page, kbId, pageId, content: `${kbId} 正文` }));
    const { rerender } = render(<WikiPanel navigation={{ view: 'wiki', kbId: 'k', pageId: 'p' }} navigationRequest={1} />);
    fireEvent.change(await screen.findByLabelText('Markdown 正文'), { target: { value: '保留直到确认' } });
    rerender(<WikiPanel navigation={{ view: 'wiki', kbId: 'k2', pageId: 'p' }} navigationRequest={2} />);
    await screen.findByRole('button', { name: '继续编辑' });
    rerender(<WikiPanel navigation={{ view: 'wiki', kbId: 'k3', pageId: 'p' }} navigationRequest={3} />);
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    await waitFor(() => expect(screen.getByLabelText('Markdown 正文')).toHaveValue('k3 正文'));
    expect(agentDataApi.wiki.libraries.read).not.toHaveBeenCalledWith('k2');
  });

  it('opens the existing new-library dialog and selects the saved library', async () => {
    vi.mocked(agentDataApi.wiki.libraries.create).mockResolvedValue({ ...library, kbId: 'created' });
    render(<WikiPanel navigation={{ view: 'wiki', mode: 'create' }} navigationRequest={1} />);
    fireEvent.change(await screen.findByLabelText('知识库名称'), { target: { value: '新知识库' } });
    fireEvent.click(screen.getByRole('button', { name: '保存知识库' }));
    await waitFor(() => expect(agentDataApi.wiki.libraries.read).toHaveBeenCalledWith('created'));
    expect(agentDataApi.jobs.create).not.toHaveBeenCalled();
  });

  it('replaces a new-page draft only after a repeated create request is confirmed', async () => {
    const navigation = { view: 'wiki' as const, kbId: 'k', mode: 'create' as const };
    const { rerender } = render(<WikiPanel navigation={navigation} navigationRequest={1} />);
    fireEvent.change(await screen.findByLabelText('页面标题'), { target: { value: '旧新建草稿' } });
    rerender(<WikiPanel navigation={navigation} navigationRequest={2} />);
    fireEvent.click(await screen.findByRole('button', { name: '放弃修改' }));
    await waitFor(() => expect(screen.getByLabelText('页面标题')).toHaveValue(''));
    expect(agentDataApi.wiki.pages.create).not.toHaveBeenCalled();
  });

  it.each(['k', 'k2'])('cancels a pending confirmation when hidden before navigating to %s', async (kbId) => {
    const { rerender } = render(<WikiPanel navigation={{ view: 'wiki', kbId: 'k', pageId: 'p' }} navigationRequest={1} />);
    fireEvent.change(await screen.findByLabelText('Markdown 正文'), { target: { value: '隐藏时继续保留' } });
    const navigation = { view: 'wiki' as const, kbId, pageId: 'p2' };
    rerender(<WikiPanel navigation={navigation} navigationRequest={2} />);
    await screen.findByRole('button', { name: '继续编辑' });
    rerender(<WikiPanel visible={false} navigation={navigation} navigationRequest={2} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: '继续编辑' })).toBeNull());
    rerender(<WikiPanel navigation={navigation} navigationRequest={2} />);
    await waitFor(() => expect(screen.getByLabelText('Markdown 正文')).toHaveValue('隐藏时继续保留'));
    expect(screen.queryByRole('button', { name: '继续编辑' })).toBeNull();
    expect(agentDataApi.wiki.pages.read).not.toHaveBeenCalledWith(kbId, 'p2');
  });

  it.each(['save', 'reload'] as const)('refuses to replace a page while %s is pending', async (operation) => {
    const { rerender } = render(<WikiPanel navigation={{ view: 'wiki', kbId: 'k', pageId: 'p' }} navigationRequest={1} />);
    const input = await screen.findByLabelText('Markdown 正文');
    const pending = deferred<typeof page>();
    if (operation === 'save') {
      vi.mocked(agentDataApi.wiki.pages.update).mockReturnValueOnce(pending.promise);
      fireEvent.change(input, { target: { value: '保存中的正文' } });
      fireEvent.click(screen.getByRole('button', { name: '保存页面' }));
    } else {
      vi.mocked(agentDataApi.wiki.pages.read).mockReturnValueOnce(pending.promise);
      fireEvent.click(screen.getByRole('button', { name: '重新载入原版本' }));
      await screen.findByText('正在重新载入…');
    }
    rerender(<WikiPanel navigation={{ view: 'wiki', kbId: 'k2', pageId: 'p2' }} navigationRequest={2} />);
    await screen.findByText(operation === 'save' ? '正在保存，请等待保存完成后再离开。' : '正在重新载入，请等待读取完成后再离开。');
    expect(agentDataApi.wiki.libraries.read).not.toHaveBeenCalledWith('k2');
    expect(screen.queryByRole('button', { name: '放弃修改' })).toBeNull();
    await act(async () => pending.resolve({ ...page, revision: 2 }));
    expect(agentDataApi.wiki.libraries.read).not.toHaveBeenCalledWith('k2');
  });

  it('browses libraries immediately without a workspace search', async () => {
    render(<WikiPanel />);
    expect(await screen.findByRole('button', { name: '打开知识库 产品' })).toBeVisible();
    expect(agentDataApi.wiki.libraries.list).toHaveBeenCalledWith({ query: '' });
    expect(agentDataApi.jobs.create).not.toHaveBeenCalled();
  });

  it('keeps the list filters and the last workspace draft mounted across back navigation', async () => {
    const { rerender } = render(<WikiPanel initialProject="D:/a" />);
    const open = await screen.findByRole('button', { name: '打开知识库 产品' });
    const search = screen.getByLabelText('搜索知识库');
    fireEvent.change(search, { target: { value: '产品' } });
    fireEvent.click(open);
    await waitFor(() => expect(screen.getByRole('button', { name: '新建页面' })).toBeEnabled());
    fireEvent.click(await screen.findByRole('button', { name: '新建页面' }));
    fireEvent.change(await screen.findByLabelText('页面标题'), { target: { value: '保留的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '返回知识库列表' }));
    expect(screen.getByLabelText('搜索知识库')).toBe(search);
    expect(search).toHaveValue('产品');
    rerender(<WikiPanel initialProject="D:/b" />);
    fireEvent.click(screen.getByRole('button', { name: '打开知识库 产品' }));
    expect(screen.getByLabelText('页面标题')).toHaveValue('保留的草稿');
  });

  it('pauses reads while hidden and refreshes once on returning', async () => {
    const { rerender } = render(<WikiPanel visible={false} />);
    expect(agentDataApi.wiki.libraries.list).not.toHaveBeenCalled();
    rerender(<WikiPanel />);
    await waitFor(() => expect(agentDataApi.wiki.libraries.list).toHaveBeenCalledTimes(1));
  });

  it('confirms before discarding the last library draft when opening a different library', async () => {
    vi.mocked(agentDataApi.wiki.libraries.list).mockResolvedValue([library, { ...library, kbId: 'k2', name: '其它库' }]);
    render(<WikiPanel />);
    fireEvent.click(await screen.findByRole('button', { name: '打开知识库 产品' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '新建页面' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '新建页面' }));
    fireEvent.change(await screen.findByLabelText('页面标题'), { target: { value: '未保存草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '返回知识库列表' }));
    fireEvent.click(screen.getByRole('button', { name: '打开知识库 其它库' }));
    await waitFor(() => expect(screen.getByText('放弃未保存修改？')).toBeVisible());
    expect(agentDataApi.wiki.libraries.read).not.toHaveBeenCalledWith('k2');
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '打开知识库 产品' }));
    expect(screen.getByLabelText('页面标题')).toHaveValue('未保存草稿');
  });

  it('clears the selected workspace after deleting that library from the list', async () => {
    render(<WikiPanel />);
    fireEvent.click(await screen.findByRole('button', { name: '打开知识库 产品' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '新建页面' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '返回知识库列表' }));
    fireEvent.click(within(screen.getByLabelText('知识库 产品')).getByRole('button', { name: /删.*除/ }));
    fireEvent.change(await screen.findByLabelText('输入知识库名称确认'), { target: { value: '产品' } });
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(agentDataApi.wiki.libraries.remove).toHaveBeenCalledWith('k', false));
    await waitFor(() => expect(screen.queryByTestId('wiki-library-workspace')).toBeNull());
  });

  it('protects the retained draft before deleting its library from the list', async () => {
    render(<WikiPanel />);
    fireEvent.click(await screen.findByRole('button', { name: '打开知识库 产品' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '新建页面' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '新建页面' }));
    fireEvent.change(await screen.findByLabelText('页面标题'), { target: { value: '未保存页面' } });
    fireEvent.click(screen.getByRole('button', { name: '返回知识库列表' }));
    fireEvent.click(within(screen.getByLabelText('知识库 产品')).getByRole('button', { name: /删.*除/ }));
    await waitFor(() => expect(screen.getByText('放弃未保存修改？')).toBeVisible());
    expect(agentDataApi.wiki.libraries.previewDelete).not.toHaveBeenCalled();
  });
});
