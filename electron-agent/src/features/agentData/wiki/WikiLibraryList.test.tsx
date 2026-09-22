// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentDataApi } from '../../../lib/agentData';
import { WikiLibraryList } from './WikiLibraryList';
import { deferred, wikiAsset } from './wikiTestData';
import { mockWikiApi, renderWiki as render } from './wikiTestSupport';

beforeEach(mockWikiApi);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('browses without searching and keeps rows on refresh failure', async () => {
  const onOpen = vi.fn();
  render(<WikiLibraryList visible onOpen={onOpen} refreshVersion={0} />);
  expect(await screen.findByText('团队说明')).toBeVisible();
  expect(screen.queryByLabelText('关联项目筛选')).toBeNull();
  vi.mocked(agentDataApi.wiki.list).mockRejectedValueOnce(new Error('连接已断开'));
  fireEvent.click(screen.getByRole('button', { name: '刷新知识库' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('连接已断开');
  fireEvent.click(screen.getByRole('button', { name: '打开知识库 产品' }));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith('k');
});

it('invalidates in-flight reads while hidden and refreshes once', async () => {
  const pending = deferred<typeof wikiAsset[]>();
  const { rerender } = render(<WikiLibraryList visible onOpen={vi.fn()} refreshVersion={0} />);
  await screen.findByText('团队说明');
  vi.mocked(agentDataApi.wiki.list).mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole('button', { name: '刷新知识库' }));
  await waitFor(() => expect(agentDataApi.wiki.list).toHaveBeenCalledTimes(2));
  rerender(<WikiLibraryList visible={false} onOpen={vi.fn()} refreshVersion={5} />);
  await act(async () => pending.resolve([{ ...wikiAsset, name: '迟到结果' }]));
  expect(screen.queryByText('迟到结果')).toBeNull();
  expect(agentDataApi.wiki.list).toHaveBeenCalledTimes(2);
  rerender(<WikiLibraryList visible onOpen={vi.fn()} refreshVersion={5} />);
  await waitFor(() => expect(agentDataApi.wiki.list).toHaveBeenCalledTimes(3));
});

it('debounces queries and distinguishes filtered emptiness', async () => {
  render(<WikiLibraryList visible onOpen={vi.fn()} refreshVersion={0} />);
  await screen.findByText('团队说明');
  vi.mocked(agentDataApi.wiki.list).mockResolvedValue([]);
  fireEvent.change(screen.getByLabelText('搜索知识库'), { target: { value: '不存在' } });
  expect(agentDataApi.wiki.list).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('没有匹配知识库')).toBeVisible();
});

it('creates a wiki through the dialog', async () => {
  const onOpen = vi.fn();
  vi.mocked(agentDataApi.wiki.create).mockResolvedValue({ ...wikiAsset, wikiId: 'created', name: '新建库' });
  render(<WikiLibraryList visible onOpen={onOpen} refreshVersion={0} />);
  await screen.findByText('团队说明');
  fireEvent.click(screen.getByRole('button', { name: '新建知识库' }));
  fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '新建库' } });
  fireEvent.click(screen.getByRole('button', { name: '保存知识库' }));
  await waitFor(() => expect(agentDataApi.wiki.create).toHaveBeenCalledWith({ name: '新建库' }));
  expect(onOpen).toHaveBeenCalledWith('created');
});

it('deletes a wiki after name confirmation', async () => {
  const onDeleted = vi.fn();
  render(<WikiLibraryList visible onOpen={vi.fn()} refreshVersion={0} onDeleted={onDeleted} />);
  await screen.findByText('团队说明');
  fireEvent.click(screen.getByRole('button', { name: '删除知识库 产品' }));
  fireEvent.change(await screen.findByLabelText('输入知识库名称确认'), { target: { value: '产品' } });
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(agentDataApi.wiki.remove).toHaveBeenCalledWith('k'));
  expect(onDeleted).toHaveBeenCalledWith('k');
});
