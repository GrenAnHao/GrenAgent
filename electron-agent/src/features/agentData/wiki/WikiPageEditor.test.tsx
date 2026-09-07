// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentDataApi } from '../../../lib/agentData';
import { WikiPageEditor } from './WikiPageEditor';
import { deferred, page, source } from './wikiTestData';
import { mockWikiApi, renderWiki as render } from './wikiTestSupport';
vi.mock('../../chat/LazyMarkdown', () => ({ LazyMarkdown: ({ children }: { children: string }) => <pre>{children}</pre> }));
beforeEach(mockWikiApi);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('retains a conflicted draft and confirms Escape before closing', async () => {
  vi.mocked(agentDataApi.wiki.pages.update).mockRejectedValue(new Error('VERSION_CONFLICT'));
  const onClose = vi.fn();
  render(<WikiPageEditor kbId="k" page={page} readOnly={false} onSaved={vi.fn()} onClose={onClose} />);
  const editor = screen.getByLabelText('Markdown 正文');
  fireEvent.change(editor, { target: { value: '# 我的草稿' } });
  fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
  expect(await screen.findByRole('alert')).toHaveTextContent('页面已在其它位置修改；草稿已保留');
  expect(editor).toHaveValue('# 我的草稿');
  expect(agentDataApi.wiki.pages.update).toHaveBeenCalledWith('k', 'p', expect.objectContaining({ expected: { revision: 1, contentHash: 'page-h' } }));
  fireEvent.keyDown(editor, { key: 'Escape' });
  await waitFor(() => expect(screen.getByText('放弃未保存修改？')).toBeVisible());
  expect(onClose).not.toHaveBeenCalled();
});

it('keeps the original base and draft on same-page refresh and confirms explicit reload', async () => {
  const props = { kbId: 'k', readOnly: false, onSaved: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<WikiPageEditor {...props} page={page} />);
  fireEvent.change(screen.getByLabelText('Markdown 正文'), { target: { value: '草稿' } });
  rerender(<WikiPageEditor {...props} page={{ ...page, revision: 4, contentHash: 'new-h', content: '其它修改' }} />);
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue('草稿');
  fireEvent.click(screen.getByRole('button', { name: '重新载入原版本' }));
  await waitFor(() => expect(screen.getByText('放弃未保存修改？')).toBeVisible());
  expect(agentDataApi.wiki.pages.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
  await waitFor(() => expect(agentDataApi.wiki.pages.read).toHaveBeenCalledWith('k', 'p'));
});

it('prevents every write when read-only, including keyboard saves', async () => {
  render(<WikiPageEditor kbId="k" page={page} readOnly onSaved={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole('button', { name: '保存页面' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '删除页面' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '允许自动更新' })).toBeDisabled();
  fireEvent.keyDown(screen.getByLabelText('Markdown 正文'), { key: 's', metaKey: true });
  expect(agentDataApi.wiki.pages.update).not.toHaveBeenCalled();
  expect(screen.getByText('人工创建')).toBeVisible();
  expect(screen.getByText('先关联原始资料')).toBeVisible();
});

it('reads the exact historical source reference and marks deleted sources', async () => {
  vi.mocked(agentDataApi.wiki.sources.list).mockResolvedValue([]);
  vi.mocked(agentDataApi.wiki.sources.read).mockResolvedValue({ source: { ...source, revision: 3, lifecycle: 'deleted' }, content: '旧快照' });
  render(<WikiPageEditor kbId="k" page={{ ...page, sourceRefs: [{ sourceId: 's', revision: 1 }] }} readOnly={false} onSaved={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /查看来源.*r1/ }));
  await waitFor(() => expect(screen.getByText('旧快照')).toBeVisible());
  expect(screen.getAllByText(/来源已删除/).length).toBeGreaterThan(0);
  expect(agentDataApi.wiki.sources.read).toHaveBeenCalledWith('k', 's', 1);
});

it('does not allow draft mutation or navigation while a save is in flight', async () => {
  const pending = deferred<typeof page>();
  vi.mocked(agentDataApi.wiki.pages.update).mockReturnValue(pending.promise);
  const onClose = vi.fn();
  render(<WikiPageEditor kbId="k" page={page} readOnly={false} onSaved={vi.fn()} onClose={onClose} />);
  const body = screen.getByLabelText('Markdown 正文');
  fireEvent.change(body, { target: { value: '提交的版本' } });
  fireEvent.keyDown(body, { key: 's', metaKey: true });
  expect(body).toHaveAttribute('readonly');
  fireEvent.keyDown(body, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByText('放弃未保存修改？')).toBeNull();
  await act(async () => pending.resolve({ ...page, content: '提交的版本', revision: 2, contentHash: 'new' }));
  expect(await screen.findByText('已保存并锁定，后续抽取不会覆盖人工内容。')).toBeVisible();
});

it('never sends an existing dirty draft to a different library when props change directly', async () => {
  const props = { readOnly: false, onSaved: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<WikiPageEditor {...props} kbId="k" page={page} />);
  fireEvent.change(screen.getByLabelText('Markdown 正文'), { target: { value: '保留原库草稿' } });
  rerender(<WikiPageEditor {...props} kbId="other" page={{ ...page, kbId: 'other', pageId: 'p2' }} />);
  fireEvent.click(screen.getByRole('button', { name: '保存页面' }));
  await waitFor(() => expect(agentDataApi.wiki.pages.update).toHaveBeenCalled());
  expect(agentDataApi.wiki.pages.update).toHaveBeenCalledWith('k', 'p', expect.anything());
});

it('unlocks only after confirmation and uses the original page version', async () => {
  render(<WikiPageEditor kbId="k" page={{ ...page, sourceRefs: [{ sourceId: 's', revision: 1 }] }} readOnly={false} onSaved={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '允许自动更新' }));
  expect(agentDataApi.wiki.pages.setLocked).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: '允许后续抽取更新' }));
  await waitFor(() => expect(agentDataApi.wiki.pages.setLocked).toHaveBeenCalledWith('k', 'p', false, { revision: 1, contentHash: 'page-h' }));
});

it('freezes draft editing, closing and duplicate reloads until a confirmed reload settles', async () => {
  const pending = deferred<typeof page>();
  vi.mocked(agentDataApi.wiki.pages.read).mockReturnValue(pending.promise);
  const onClose = vi.fn();
  render(<WikiPageEditor kbId="k" page={page} readOnly={false} onSaved={vi.fn()} onClose={onClose} />);
  const body = screen.getByLabelText('Markdown 正文');
  fireEvent.change(body, { target: { value: '原草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '重新载入原版本' }));
  fireEvent.click(await screen.findByRole('button', { name: '放弃修改' }));
  await waitFor(() => expect(agentDataApi.wiki.pages.read).toHaveBeenCalledTimes(1));
  expect(body).toHaveAttribute('readonly');
  expect(screen.getByLabelText('页面标题')).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: '关闭页面详情' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '保存页面' })).toBeDisabled();
  const reload = screen.getByRole('button', { name: '重新载入原版本' });
  expect(reload).toBeDisabled();
  fireEvent.click(reload);
  fireEvent.keyDown(body, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  expect(agentDataApi.wiki.pages.read).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ ...page, content: '重新载入的正文', revision: 2 }));
  expect(body).toHaveValue('重新载入的正文');
  expect(body).not.toHaveAttribute('readonly');
});

it.each(['resolve', 'reject'] as const)('ignores a stale reload %s after the page and library change', async (outcome) => {
  const pending = deferred<typeof page>();
  vi.mocked(agentDataApi.wiki.pages.read).mockReturnValue(pending.promise);
  const props = { readOnly: false, onSaved: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<WikiPageEditor {...props} kbId="k" page={page} />);
  fireEvent.click(screen.getByRole('button', { name: '重新载入原版本' }));
  await waitFor(() => expect(agentDataApi.wiki.pages.read).toHaveBeenCalledTimes(1));
  rerender(<WikiPageEditor {...props} kbId="other" page={{ ...page, kbId: 'other', pageId: 'p2', title: '另一库页面', content: '新的正文' }} />);
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue('新的正文');
  await act(async () => { if (outcome === 'resolve') pending.resolve({ ...page, content: '迟到旧正文' }); else pending.reject(new Error('旧读取错误')); });
  expect(screen.getByLabelText('页面标题')).toHaveValue('另一库页面');
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue('新的正文');
  expect(screen.queryByText(/旧读取错误/)).toBeNull();
  expect(screen.getByLabelText('Markdown 正文')).not.toHaveAttribute('readonly');
});

it('explains default manual locking for new pages without implying an external unlocked page', () => {
  render(<WikiPageEditor kbId="k" readOnly={false} onSaved={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByText('人工保存后默认锁定。')).toBeInTheDocument();
  expect(screen.queryByText('未声明人工锁定。')).toBeNull();
});

it.each(['save', 'unlock'] as const)('does not apply an old %s result to a different clean page', async (operation) => {
  const pending = deferred<typeof page>();
  vi.mocked(operation === 'save' ? agentDataApi.wiki.pages.update : agentDataApi.wiki.pages.setLocked).mockReturnValue(pending.promise);
  const onSaved = vi.fn();
  const props = { readOnly: false, onSaved, onClose: vi.fn() };
  const { rerender } = render(<WikiPageEditor {...props} kbId="k" page={{ ...page, sourceRefs: [{ sourceId: 's', revision: 1 }] }} />);
  if (operation === 'save') fireEvent.click(screen.getByRole('button', { name: '保存页面' }));
  else {
    fireEvent.click(screen.getByRole('button', { name: '允许自动更新' }));
    fireEvent.click(await screen.findByRole('button', { name: '允许后续抽取更新' }));
  }
  await waitFor(() => expect(operation === 'save' ? agentDataApi.wiki.pages.update : agentDataApi.wiki.pages.setLocked).toHaveBeenCalled());
  rerender(<WikiPageEditor {...props} kbId="other" page={{ ...page, kbId: 'other', pageId: 'p2', content: 'B页正文' }} />);
  await act(async () => pending.resolve({ ...page, content: '旧页写入结果', revision: 2 }));
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue('B页正文');
});
