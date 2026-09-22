// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentDataApi } from '../../../lib/agentData';
import { WikiSourceDialog } from './WikiSourceDialog';
import { mockWikiApi, renderWiki as render } from './wikiTestSupport';

vi.mock('../../chat/LazyMarkdown', () => ({ LazyMarkdown: ({ children }: { children: string }) => <pre>{children}</pre> }));
beforeEach(mockWikiApi);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('uploads raw files without ingest', async () => {
  const onSaved = vi.fn();
  render(<WikiSourceDialog open visible wikiId="k" onClose={vi.fn()} onSaved={onSaved} />);
  const file = new File(['# 正文'], 'a.md', { type: 'text/markdown' });
  fireEvent.change(screen.getByLabelText('上传资料'), { target: { files: [file] } });
  await waitFor(() => expect(agentDataApi.wiki.rawWrite).toHaveBeenCalledWith('k', 'a.md', '# 正文'));
  expect(agentDataApi.wiki.ingest).not.toHaveBeenCalled();
  expect(onSaved).toHaveBeenCalled();
});

it('writes manual raw content', async () => {
  render(<WikiSourceDialog open visible wikiId="k" onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole('tab', { name: '手动录入' }));
  fireEvent.change(screen.getByLabelText('资料名称'), { target: { value: 'manual' } });
  fireEvent.change(screen.getByLabelText('资料 Markdown'), { target: { value: '# 手动' } });
  fireEvent.click(screen.getByRole('button', { name: '添加资料' }));
  await waitFor(() => expect(agentDataApi.wiki.rawWrite).toHaveBeenCalledWith('k', 'manual.md', '# 手动'));
});

it('disables upload when processing', async () => {
  render(<WikiSourceDialog open visible wikiId="k" disabled onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByLabelText('上传资料')).toBeDisabled();
});
