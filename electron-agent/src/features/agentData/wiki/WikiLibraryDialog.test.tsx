// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentDataApi } from '../../../lib/agentData';
import { WikiLibraryDialog } from './WikiLibraryDialog';
import { wikiAsset } from './wikiTestData';
import { mockWikiApi, renderWiki as render } from './wikiTestSupport';

beforeEach(mockWikiApi);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('creates without bindings or ingest', async () => {
  render(<WikiLibraryDialog open visible onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '共享库' } });
  expect(screen.queryByLabelText('关联项目')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '保存知识库' }));
  await waitFor(() => expect(agentDataApi.wiki.create).toHaveBeenCalledWith({ name: '共享库' }));
  expect(agentDataApi.wiki.ingest).not.toHaveBeenCalled();
});

it('updates name and summary', async () => {
  const onSaved = vi.fn();
  render(<WikiLibraryDialog open visible library={wikiAsset} onClose={vi.fn()} onSaved={onSaved} />);
  fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '新名称' } });
  fireEvent.change(screen.getByLabelText('知识库用途'), { target: { value: '新用途' } });
  fireEvent.click(screen.getByRole('button', { name: '保存知识库' }));
  await waitFor(() => expect(agentDataApi.wiki.update).toHaveBeenCalledWith('k', { name: '新名称', summary: '新用途' }));
  expect(onSaved).toHaveBeenCalled();
});
