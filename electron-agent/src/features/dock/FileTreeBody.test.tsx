import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutStore } from '../../stores/layoutStore';

const { getTree } = vi.hoisted(() => ({ getTree: vi.fn() }));
vi.mock('../../lib/files', () => ({ files: { getTree } }));

import { FileTreeBody } from './FileTreeBody';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const tab = {
  id: 'file:right:/repo',
  kind: 'file' as const,
  region: 'right' as const,
  title: '文件',
  closable: true,
  order: 0,
  payload: { workspace: '/repo' },
};

const tree = {
  name: 'repo',
  path: '/repo',
  kind: 'directory' as const,
  children: [
    { name: 'a.ts', path: '/repo/a.ts', kind: 'file' as const },
    {
      name: 'src',
      path: '/repo/src',
      kind: 'directory' as const,
      children: [{ name: 'b.ts', path: '/repo/src/b.ts', kind: 'file' as const }],
    },
  ],
};

describe('FileTreeBody', () => {
  beforeEach(() => {
    useLayoutStore.setState({ rightPanelOpen: true, terminalOpen: true });
  });

  it('lists files and expands a folder', async () => {
    getTree.mockResolvedValue(tree);
    render(<FileTreeBody tab={tab} active />);
    await waitFor(() => expect(screen.getByTestId('file-tree')).toBeTruthy());
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.queryByText('b.ts')).toBeNull();
    await userEvent.click(screen.getByTestId('file-tree-dir-/repo/src'));
    expect(screen.getByText('b.ts')).toBeTruthy();
    expect(getTree).toHaveBeenCalledWith('/repo');
  });

  it('shows retry on failure and does not collapse the dock', async () => {
    getTree.mockRejectedValue(new Error('boom'));
    render(<FileTreeBody tab={tab} active />);
    await waitFor(() => expect(screen.getByTestId('file-tree-error')).toBeTruthy());
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
    expect(useLayoutStore.getState().terminalOpen).toBe(true);
    getTree.mockResolvedValue(tree);
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('file-tree')).toBeTruthy();
  });
});
