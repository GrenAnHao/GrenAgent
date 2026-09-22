// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentDataApi } from '../../../lib/agentData';
import { WikiLibraryWorkspace } from './WikiLibraryWorkspace';
import { deferred, wikiAsset } from './wikiTestData';
import { mockWikiApi, renderWiki as render } from './wikiTestSupport';

vi.mock('../../chat/LazyMarkdown', () => ({ LazyMarkdown: ({ children }: { children: string }) => <pre>{children}</pre> }));
beforeEach(mockWikiApi);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const props = { kbId: 'k', onBack: vi.fn(), onViewTask: vi.fn() };

it('uploads raw source, saves purpose.md, starts ingest, lists pages, searches, deletes and resets', async () => {
  render(<WikiLibraryWorkspace {...props} visible />);
  await screen.findByText('团队说明');
  expect(screen.queryByText('重建索引')).toBeNull();
  expect(screen.queryByText('关联项目')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '上传原文' }));
  const file = new File(['# 原文'], 'note.md', { type: 'text/markdown' });
  fireEvent.change(screen.getByLabelText('上传资料'), { target: { files: [file] } });
  await waitFor(() => expect(agentDataApi.wiki.rawWrite).toHaveBeenCalledWith('k', 'note.md', '# 原文'));
  fireEvent.click(screen.getByRole('button', { name: '稍后抽取' }));

  fireEvent.click(screen.getByRole('tab', { name: '抽取模板' }));
  fireEvent.change(await screen.findByLabelText('purpose.md'), { target: { value: '# 自定义用途' } });
  fireEvent.click(screen.getByRole('button', { name: '保存 purpose.md' }));
  await waitFor(() => expect(agentDataApi.wiki.writeTemplate).toHaveBeenCalledWith('k', 'purpose', '# 自定义用途'));

  fireEvent.click(screen.getByRole('button', { name: '开始抽取' }));
  await waitFor(() => expect(agentDataApi.wiki.ingest).toHaveBeenCalledWith('k'));

  fireEvent.click(screen.getByRole('tab', { name: /知识页面/ }));
  expect(await screen.findByRole('button', { name: '查看页面 说明' })).toBeVisible();

  fireEvent.click(screen.getByRole('tab', { name: '检索与图谱' }));
  fireEvent.change(screen.getByLabelText('检索知识库'), { target: { value: '权限' } });
  fireEvent.click(screen.getByRole('button', { name: '执行检索' }));
  await waitFor(() => expect(agentDataApi.wiki.search).toHaveBeenCalledWith('k', '权限'));
  expect(screen.getByLabelText('检索结果').textContent).toContain('说明');
  expect(screen.getByLabelText('检索结果').textContent).toContain('权限模型');

  fireEvent.click(screen.getByRole('button', { name: '知识库更多操作' }));
  fireEvent.click(await screen.findByText('删除知识库'));
  fireEvent.change(await screen.findByLabelText('输入知识库名称确认'), { target: { value: '产品' } });
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(agentDataApi.wiki.remove).toHaveBeenCalledWith('k'));
});

it('disables upload while processing and enables reset while pending', async () => {
  vi.mocked(agentDataApi.wiki.read).mockResolvedValue({ ...wikiAsset, status: 'processing' });
  const { rerender } = render(<WikiLibraryWorkspace {...props} visible />);
  expect(await screen.findByTestId('wiki-busy-tag')).toBeVisible();
  expect(screen.getByRole('button', { name: '上传原文' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '重置状态' })).toBeEnabled();

  vi.mocked(agentDataApi.wiki.read).mockResolvedValue({ ...wikiAsset, status: 'pending' });
  rerender(<WikiLibraryWorkspace {...props} visible />);
  fireEvent.click(await screen.findByRole('button', { name: '刷新当前知识库' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '重置状态' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '重置状态' }));
  await waitFor(() => expect(agentDataApi.wiki.resetDraft).toHaveBeenCalledWith('k'));
});

it('shows busy notice when ingest returns busy', async () => {
  vi.mocked(agentDataApi.wiki.ingest).mockResolvedValue({ kind: 'busy', status: 'processing', step: 'ingesting' });
  render(<WikiLibraryWorkspace {...props} visible />);
  await waitFor(() => expect(screen.getByRole('button', { name: '开始抽取' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '开始抽取' }));
  expect(await screen.findByTestId('wiki-ingest-notice')).toHaveTextContent(/处理中（processing/);
});

it('loads pages and raw list through the new engine API', async () => {
  render(<WikiLibraryWorkspace {...props} visible />);
  await screen.findByText('团队说明');
  expect(agentDataApi.wiki.read).toHaveBeenCalledWith('k');
  expect(agentDataApi.wiki.rawList).toHaveBeenCalledWith('k');
  expect(agentDataApi.wiki.pageList).toHaveBeenCalledWith('k');
  expect(agentDataApi.wiki.graph).toHaveBeenCalledWith('k');
  expect(await screen.findByRole('button', { name: '查看资料 a.md' })).toBeVisible();
});

it('ignores stale hidden reloads', async () => {
  const pending = deferred<typeof wikiAsset>();
  const { rerender } = render(<WikiLibraryWorkspace {...props} visible />);
  await screen.findByText('团队说明');
  vi.mocked(agentDataApi.wiki.read).mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole('button', { name: '刷新当前知识库' }));
  rerender(<WikiLibraryWorkspace {...props} visible={false} />);
  await act(async () => pending.resolve({ ...wikiAsset, name: '迟到' }));
  expect(screen.queryByText('迟到')).toBeNull();
});
