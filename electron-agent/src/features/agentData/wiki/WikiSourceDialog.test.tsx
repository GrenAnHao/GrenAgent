// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentDataApi } from '../../../lib/agentData';
import { WikiSourceDialog } from './WikiSourceDialog';
import { deferred, source } from './wikiTestData';
import { mockWikiApi, renderWiki as render } from './wikiTestSupport';
vi.mock('../../chat/LazyMarkdown', () => ({ LazyMarkdown: ({ children }: { children: string }) => <pre>{children}</pre> }));
beforeEach(mockWikiApi);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('handles each upload independently and never automatically extracts', async () => {
  render(<WikiSourceDialog open kbId="k" bindings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  const a = new File(['# A'], 'a.md');
  Object.defineProperty(a, 'text', { value: async () => '# A' });
  const c = new File(['# C'], 'c.txt');
  Object.defineProperty(c, 'text', { value: async () => '# C' });
  vi.mocked(agentDataApi.wiki.sources.create).mockResolvedValueOnce(source).mockRejectedValueOnce(new Error('写入失败'));
  fireEvent.change(screen.getByLabelText('上传资料'), { target: { files: [a, new File(['bad'], 'b.pdf'), c] } });
  await waitFor(() => expect(screen.getByText(/a.md.*资料已添加/)).toBeVisible());
  await waitFor(() => expect(screen.getByText(/b.pdf.*不支持/)).toBeVisible());
  await waitFor(() => expect(screen.getByText(/c.txt.*写入失败/)).toBeVisible());
  expect(agentDataApi.wiki.sources.create).toHaveBeenCalledTimes(2);
  expect(agentDataApi.wiki.libraries.ingest).not.toHaveBeenCalled();
});

it('previews project paths then creates with the exact hash, never raw renderer content', async () => {
  render(<WikiSourceDialog open kbId="k" bindings={['D:/a']} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: '从项目导入' }));
  fireEvent.change(screen.getByLabelText('项目相对路径'), { target: { value: 'docs/a.md' } });
  fireEvent.click(screen.getByRole('button', { name: '预览导入' }));
  await waitFor(() => expect(screen.getByText(/17 字节/)).toBeVisible());
  fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
  await waitFor(() => expect(agentDataApi.wiki.sources.create).toHaveBeenCalledWith('k', { kind: 'project', projectWorkspace: 'D:/a', relativePath: 'docs/a.md', expectedContentHash: 'import-h' }));
});

it('only updates when an explicit source is supplied and sends its original version', async () => {
  render(<WikiSourceDialog open kbId="k" bindings={[]} source={source} onClose={vi.fn()} onSaved={vi.fn()} />);
  await screen.findByDisplayValue('# 来源正文');
  fireEvent.change(screen.getByLabelText('资料 Markdown'), { target: { value: '# 新资料' } });
  fireEvent.click(screen.getByRole('button', { name: '更新这份资料' }));
  await waitFor(() => expect(agentDataApi.wiki.sources.update).toHaveBeenCalledWith('k', 's', '# 新资料', { revision: 1, contentHash: 'source-h' }));
  expect(agentDataApi.wiki.sources.create).not.toHaveBeenCalled();
});

it('keeps a manual draft while hidden without leaving its modal visible', async () => {
  const props = { open: true, kbId: 'k', bindings: [], onClose: vi.fn(), onSaved: vi.fn() };
  const { rerender } = render(<WikiSourceDialog {...props} visible />);
  fireEvent.click(screen.getByRole('tab', { name: '手动录入' }));
  fireEvent.change(screen.getByLabelText('资料 Markdown'), { target: { value: '尚未保存的资料' } });
  await waitFor(() => expect(screen.getByLabelText('资料 Markdown')).toBeVisible());
  rerender(<WikiSourceDialog {...props} visible={false} />);
  await waitFor(() => expect(screen.getByLabelText('资料 Markdown')).not.toBeVisible());
  rerender(<WikiSourceDialog {...props} visible />);
  expect(screen.getByLabelText('资料 Markdown')).toHaveValue('尚未保存的资料');
});

it('cannot overwrite a source with empty content after a failed initial read', async () => {
  vi.mocked(agentDataApi.wiki.sources.read).mockRejectedValue(new Error('快照读取失败'));
  render(<WikiSourceDialog open kbId="k" bindings={[]} source={source} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('快照读取失败');
  expect(screen.getByRole('button', { name: '更新这份资料' })).toBeDisabled();
  expect(agentDataApi.wiki.sources.update).not.toHaveBeenCalled();
});

it('keeps the source modal open while an update is in flight', async () => {
  const pending = deferred<typeof source>();
  vi.mocked(agentDataApi.wiki.sources.update).mockReturnValue(pending.promise);
  const onClose = vi.fn();
  render(<WikiSourceDialog open kbId="k" bindings={[]} source={source} onClose={onClose} onSaved={vi.fn()} />);
  await screen.findByDisplayValue('# 来源正文');
  fireEvent.click(screen.getByRole('button', { name: '更新这份资料' }));
  await waitFor(() => expect(agentDataApi.wiki.sources.update).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', keyCode: 27 });
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => pending.resolve(source));
});

it('never applies an old source update or callback to a reopened different source', async () => {
  const pending = deferred<typeof source>();
  const other = { ...source, kbId: 'other', sourceId: 's2', name: 'b.md', revision: 4, contentHash: 'b-h' };
  vi.mocked(agentDataApi.wiki.sources.read).mockImplementation(async (_kbId, id) => ({ source: id === 's' ? source : other, content: id === 's' ? 'A正文' : 'B正文' }));
  vi.mocked(agentDataApi.wiki.sources.update).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...other, revision: 5 });
  const onSaved = vi.fn();
  const props = { bindings: [], onClose: vi.fn(), onSaved };
  const { rerender } = render(<WikiSourceDialog {...props} open kbId="k" source={source} />);
  await screen.findByDisplayValue('A正文');
  fireEvent.click(screen.getByRole('button', { name: '更新这份资料' }));
  rerender(<WikiSourceDialog {...props} open={false} kbId="k" source={source} />);
  rerender(<WikiSourceDialog {...props} open kbId="other" source={other} />);
  await screen.findByDisplayValue('B正文');
  await act(async () => pending.resolve({ ...source, revision: 2 }));
  expect(onSaved).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('资料 Markdown'), { target: { value: 'B新正文' } });
  fireEvent.click(screen.getByRole('button', { name: '更新这份资料' }));
  await waitFor(() => expect(agentDataApi.wiki.sources.update).toHaveBeenLastCalledWith('other', 's2', 'B新正文', { revision: 4, contentHash: 'b-h' }));
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it('ignores a project import preview returned for an old library', async () => {
  const pending = deferred<Awaited<ReturnType<typeof agentDataApi.wiki.sources.previewImport>>>();
  vi.mocked(agentDataApi.wiki.sources.previewImport).mockReturnValue(pending.promise);
  const props = { open: true, onClose: vi.fn(), onSaved: vi.fn() };
  const { rerender } = render(<WikiSourceDialog {...props} kbId="k" bindings={['D:/a']} />);
  fireEvent.click(screen.getByRole('tab', { name: '从项目导入' }));
  fireEvent.change(screen.getByLabelText('项目相对路径'), { target: { value: 'old.md' } });
  fireEvent.click(screen.getByRole('button', { name: '预览导入' }));
  rerender(<WikiSourceDialog {...props} kbId="other" bindings={['D:/b']} />);
  fireEvent.click(screen.getByRole('tab', { name: '从项目导入' }));
  await act(async () => pending.resolve({ projectWorkspace: 'D:/a', relativePath: 'old.md', name: 'old.md', contentHash: 'old-h', bytes: 99 }));
  expect(screen.queryByText(/99 字节/)).toBeNull();
  expect(screen.queryByRole('button', { name: '确认导入' })).toBeNull();
});

it('does not mark another library saved after a deferred project import completes', async () => {
  const pending = deferred<typeof source>();
  vi.mocked(agentDataApi.wiki.sources.create).mockReturnValue(pending.promise);
  const onSaved = vi.fn();
  const props = { open: true, onClose: vi.fn(), onSaved };
  const { rerender } = render(<WikiSourceDialog {...props} kbId="k" bindings={['D:/a']} />);
  fireEvent.click(screen.getByRole('tab', { name: '从项目导入' }));
  fireEvent.change(screen.getByLabelText('项目相对路径'), { target: { value: 'docs/a.md' } });
  fireEvent.click(screen.getByRole('button', { name: '预览导入' }));
  fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
  rerender(<WikiSourceDialog {...props} kbId="other" bindings={['D:/b']} />);
  await act(async () => pending.resolve(source));
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.queryByText('资料已添加')).toBeNull();
});
