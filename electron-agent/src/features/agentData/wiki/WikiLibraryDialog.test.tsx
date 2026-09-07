// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentDataApi } from '../../../lib/agentData';
import { WikiLibraryDialog } from './WikiLibraryDialog';
import { deferred, library } from './wikiTestData';
import { mockWikiApi, renderWiki as render } from './wikiTestSupport';
vi.mock('../useProjectOptions', () => ({ useProjectOptions: () => [{ cwd: 'D:/a', name: 'A' }, { cwd: 'D:/b', name: 'B' }] }));
beforeEach(mockWikiApi);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('counts Unicode code points, trims names and creates without extracting', async () => {
  render(<WikiLibraryDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '🙂'.repeat(81) } });
  fireEvent.click(screen.getByRole('button', { name: '保存知识库' }));
  expect(await screen.findByText('名称需为 1–80 个字符')).toBeVisible();
  expect(agentDataApi.wiki.libraries.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '  ' + '🙂'.repeat(80) + '  ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存知识库' }));
  await waitFor(() => expect(agentDataApi.wiki.libraries.create).toHaveBeenCalledWith({ name: '🙂'.repeat(80), description: '', bindings: [] }));
  expect(agentDataApi.wiki.libraries.ingest).not.toHaveBeenCalled();
  expect(agentDataApi.jobs.create).not.toHaveBeenCalled();
});

it('edits bindings using the originally opened library revision', async () => {
  render(<WikiLibraryDialog open library={library} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '新名称' } });
  fireEvent.click(screen.getByRole('button', { name: '保存知识库' }));
  await waitFor(() => expect(agentDataApi.wiki.libraries.update).toHaveBeenCalledWith('k', { name: '新名称', description: '团队说明', bindings: ['D:/a', 'D:/b'] }, 1));
});

it('rejects blank names and descriptions beyond 500 code points', async () => {
  render(<WikiLibraryDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '  ' } });
  fireEvent.change(screen.getByLabelText('知识库用途'), { target: { value: 'x'.repeat(501) } });
  fireEvent.click(screen.getByRole('button', { name: '保存知识库' }));
  expect(await screen.findByText('用途最多 500 个字符')).toBeVisible();
  expect(agentDataApi.wiki.libraries.create).not.toHaveBeenCalled();
});

it('creates one library with two real project bindings and no automatic job', async () => {
  render(<WikiLibraryDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '共享库' } });
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '关联项目' }));
  fireEvent.click(await screen.findByText('A'));
  fireEvent.click(screen.getByText('B'));
  fireEvent.click(screen.getByRole('button', { name: '保存知识库' }));
  await waitFor(() => expect(agentDataApi.wiki.libraries.create).toHaveBeenCalledWith({ name: '共享库', description: '', bindings: ['D:/a', 'D:/b'] }));
  expect(agentDataApi.wiki.libraries.ingest).not.toHaveBeenCalled();
});

it('keeps an edited library form when its parent view is temporarily hidden', async () => {
  const props = { open: true, library, onClose: vi.fn(), onSaved: vi.fn() };
  const { rerender } = render(<WikiLibraryDialog {...props} visible />);
  fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '未保存库名' } });
  await waitFor(() => expect(screen.getByLabelText('知识库名称')).toBeVisible());
  rerender(<WikiLibraryDialog {...props} visible={false} />);
  await waitFor(() => expect(screen.getByLabelText('知识库名称')).not.toBeVisible());
  rerender(<WikiLibraryDialog {...props} visible />);
  expect(screen.getByLabelText('知识库名称')).toHaveValue('未保存库名');
});

it('blocks closing as soon as validation starts and through the library write', async () => {
  const pending = deferred<typeof library>();
  vi.mocked(agentDataApi.wiki.libraries.create).mockReturnValue(pending.promise);
  const onClose = vi.fn();
  render(<WikiLibraryDialog open onClose={onClose} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '库A' } });
  fireEvent.click(screen.getByRole('button', { name: '保存知识库' }));
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  expect(screen.getByLabelText('知识库名称')).toBeDisabled();
  await waitFor(() => expect(agentDataApi.wiki.libraries.create).toHaveBeenCalledTimes(1));
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', keyCode: 27 });
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => pending.resolve(library));
});

it('does not close a new library form with an old creation result and keeps its own target revision', async () => {
  const pending = deferred<typeof library>();
  vi.mocked(agentDataApi.wiki.libraries.create).mockReturnValue(pending.promise);
  const onSaved = vi.fn();
  const props = { onClose: vi.fn(), onSaved };
  const { rerender } = render(<WikiLibraryDialog {...props} open />);
  fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '库A' } });
  fireEvent.click(screen.getByRole('button', { name: '保存知识库' }));
  await waitFor(() => expect(agentDataApi.wiki.libraries.create).toHaveBeenCalledTimes(1));
  rerender(<WikiLibraryDialog {...props} open={false} />);
  rerender(<WikiLibraryDialog {...props} open library={{ ...library, kbId: 'other', name: '库B', revision: 5 }} />);
  await screen.findByDisplayValue('库B');
  await act(async () => pending.resolve(library));
  expect(onSaved).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '库B修改' } });
  fireEvent.click(screen.getByRole('button', { name: '保存知识库' }));
  await waitFor(() => expect(agentDataApi.wiki.libraries.update).toHaveBeenCalledWith('other', expect.objectContaining({ name: '库B修改' }), 5));
});
