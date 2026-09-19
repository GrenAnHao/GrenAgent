// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentDataApi } from '../../../lib/agentData';
import { WikiLibraryList } from './WikiLibraryList';
import { library, deferred } from './wikiTestData';
import { mockWikiApi, renderWiki as render } from './wikiTestSupport';
import { expectSelectDisplay, pickSelectOption } from '../antdSelectTestUtils';
vi.mock('../useProjectOptions', () => ({ useProjectOptions: () => [{ cwd: 'D:/a', name: 'A' }, { cwd: 'D:/b', name: 'B' }] }));
beforeEach(mockWikiApi);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('browses without searching and keeps rows on refresh failure', async () => {
  const onOpen = vi.fn();
  render(<WikiLibraryList visible onOpen={onOpen} refreshVersion={0} />);
  expect(await screen.findByText('团队说明')).toBeVisible();
  vi.mocked(agentDataApi.wiki.libraries.list).mockRejectedValueOnce(new Error('连接已断开'));
  fireEvent.click(screen.getByRole('button', { name: '刷新知识库' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('连接已断开');
  fireEvent.click(screen.getByRole('button', { name: '打开知识库 产品' }));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith('k');
});

it('invalidates in-flight reads while hidden and refreshes once with retained filters', async () => {
  const pending = deferred<typeof library[]>();
  const { rerender } = render(<WikiLibraryList visible onOpen={vi.fn()} refreshVersion={0} />);
  await screen.findByText('团队说明');
  vi.mocked(agentDataApi.wiki.libraries.list).mockReturnValueOnce(pending.promise);
  await pickSelectOption('关联项目筛选', 'A');
  await waitFor(() => expect(agentDataApi.wiki.libraries.list).toHaveBeenCalledTimes(2));
  rerender(<WikiLibraryList visible={false} onOpen={vi.fn()} refreshVersion={5} />);
  await act(async () => pending.resolve([{ ...library, name: '迟到结果' }]));
  expect(screen.queryByText('迟到结果')).toBeNull();
  expect(agentDataApi.wiki.libraries.list).toHaveBeenCalledTimes(2);
  rerender(<WikiLibraryList visible onOpen={vi.fn()} refreshVersion={5} />);
  await waitFor(() => expect(agentDataApi.wiki.libraries.list).toHaveBeenCalledTimes(3));
  expectSelectDisplay('关联项目筛选', 'A');
});

it('debounces queries and distinguishes filtered emptiness', async () => {
  render(<WikiLibraryList visible onOpen={vi.fn()} refreshVersion={0} />);
  await screen.findByText('团队说明');
  vi.mocked(agentDataApi.wiki.libraries.list).mockResolvedValue([]);
  fireEvent.change(screen.getByLabelText('搜索知识库'), { target: { value: '不存在' } });
  expect(agentDataApi.wiki.libraries.list).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('没有匹配知识库')).toBeVisible();
  expect(agentDataApi.wiki.libraries.list).toHaveBeenLastCalledWith({ query: '不存在' });
});
