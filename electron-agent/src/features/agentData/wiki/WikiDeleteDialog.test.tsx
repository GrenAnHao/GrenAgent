// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentDataApi } from '../../../lib/agentData';
import { WikiDeleteDialog } from './WikiDeleteDialog';
import { deferred, deletePreview } from './wikiTestData';
import { mockWikiApi, renderWiki as render } from './wikiTestSupport';
beforeEach(mockWikiApi);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('removes only the previewed stable source and retains waiting until the service reports deleted', async () => {
  const onDeleted = vi.fn();
  vi.mocked(agentDataApi.wiki.sources.remove).mockResolvedValueOnce({ state: 'waiting', tasks: [{ taskSource: 'agent_job', taskId: 'j', kbId: 'k', sourceId: 's', active: true, canCancel: true }] }).mockResolvedValueOnce({ state: 'waiting', tasks: [{ taskSource: 'agent_job', taskId: 'j', kbId: 'k', sourceId: 's', active: true, canCancel: true }] }).mockResolvedValueOnce({ state: 'deleted' });
  render(<WikiDeleteDialog target={{ kind: 'source', kbId: 'k', sourceId: 's' }} onClose={vi.fn()} onDeleted={onDeleted} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  fireEvent.click(await screen.findByRole('button', { name: '请求取消任务' }));
  expect(await screen.findByText('正在取消，等待任务结束后重试删除')).toBeVisible();
  expect(onDeleted).not.toHaveBeenCalled();
  expect(agentDataApi.wiki.sources.remove).toHaveBeenNthCalledWith(2, 'k', 's', true);
  fireEvent.click(await screen.findByRole('button', { name: '重试删除' }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
});

it('disables confirmation after preview failure instead of deleting a guessed target', async () => {
  vi.mocked(agentDataApi.wiki.pages.previewDelete).mockRejectedValue(new Error('预览失败'));
  render(<WikiDeleteDialog target={{ kind: 'page', kbId: 'k', pageId: 'p' }} onClose={vi.fn()} onDeleted={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('预览失败');
  expect(screen.getByRole('button', { name: '确认删除' })).toBeDisabled();
  expect(agentDataApi.wiki.pages.remove).not.toHaveBeenCalled();
});

it('requires the previewed library name and reports scope of deletion', async () => {
  render(<WikiDeleteDialog target={deletePreview.target} onClose={vi.fn()} onDeleted={vi.fn()} />);
  await screen.findByLabelText('输入知识库名称确认');
  expect(screen.getByText(/不删除项目原文件、审计记录或任务历史/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('输入知识库名称确认'), { target: { value: '不同库' } });
  expect(screen.getByRole('button', { name: '确认删除' })).toBeDisabled();
});

it('does not transfer an old deletion waiting result or cancellation target to a new dialog session', async () => {
  const pending = deferred<Awaited<ReturnType<typeof agentDataApi.wiki.sources.remove>>>();
  vi.mocked(agentDataApi.wiki.sources.remove).mockReturnValueOnce(pending.promise);
  vi.mocked(agentDataApi.wiki.sources.previewDelete).mockImplementation(async (kbId, sourceId) => ({ ...deletePreview, target: { kind: 'source', kbId, sourceId }, name: sourceId }));
  const onWaiting = vi.fn();
  const { rerender } = render(<WikiDeleteDialog target={{ kind: 'source', kbId: 'k', sourceId: 's' }} onClose={vi.fn()} onDeleted={vi.fn()} onWaiting={onWaiting} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  rerender(<WikiDeleteDialog target={{ kind: 'source', kbId: 'other', sourceId: 's2' }} onClose={vi.fn()} onDeleted={vi.fn()} onWaiting={onWaiting} />);
  await screen.findByText('s2');
  await act(async () => pending.resolve({ state: 'waiting', tasks: [{ taskSource: 'agent_job', kbId: 'k', sourceId: 's', taskId: 'job-a', active: true, canCancel: true }] }));
  expect(onWaiting).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '请求取消任务' })).toBeNull();
  expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled();
});

it('cannot close through the close button or Escape while removal is in flight', async () => {
  const pending = deferred<Awaited<ReturnType<typeof agentDataApi.wiki.pages.remove>>>();
  vi.mocked(agentDataApi.wiki.pages.remove).mockReturnValue(pending.promise);
  const onClose = vi.fn();
  render(<WikiDeleteDialog target={{ kind: 'page', kbId: 'k', pageId: 'p' }} onClose={onClose} onDeleted={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', keyCode: 27 });
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ state: 'deleted' }));
});
