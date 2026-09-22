// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentDataApi } from '../../../lib/agentData';
import { WikiPageEditor } from './WikiPageEditor';
import { mockWikiApi, renderWiki as render } from './wikiTestSupport';

vi.mock('../../chat/LazyMarkdown', () => ({ LazyMarkdown: ({ children }: { children: string }) => <pre>{children}</pre> }));
beforeEach(mockWikiApi);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('saves pages through pageWrite without lock dialogs', async () => {
  const onSaved = vi.fn();
  render(<WikiPageEditor wikiId="k" pageId="concepts/auth" title="说明" content="# 原文" readOnly={false} onSaved={onSaved} onClose={vi.fn()} />);
  expect(screen.queryByText('解除锁定')).toBeNull();
  fireEvent.change(screen.getByLabelText('Markdown 正文'), { target: { value: '# 新正文' } });
  fireEvent.click(screen.getByRole('button', { name: '保存页面' }));
  await waitFor(() => expect(agentDataApi.wiki.pageWrite).toHaveBeenCalled());
  expect(onSaved).toHaveBeenCalled();
});

it('deletes pages through pageRemove', async () => {
  const onDeleted = vi.fn();
  render(<WikiPageEditor wikiId="k" pageId="concepts/auth" title="说明" content="# 原文" readOnly={false} onSaved={vi.fn()} onClose={vi.fn()} onDeleted={onDeleted} />);
  fireEvent.click(screen.getByRole('button', { name: '删除页面' }));
  await waitFor(() => expect(agentDataApi.wiki.pageRemove).toHaveBeenCalledWith('k', 'concepts/auth'));
  expect(onDeleted).toHaveBeenCalled();
});
