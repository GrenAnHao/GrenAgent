import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';

const { memStats, memList, memHistory, runCommand } = vi.hoisted(() => ({
  memStats: vi.fn(() => Promise.resolve({ project: 1, global: 1 })),
  memList: vi.fn(() =>
    Promise.resolve([
      { id: 'g1', text: 'global fact', category: null, createdAt: 200, scope: 'global' },
      { id: 'p1', text: 'project pref', category: 'preference', createdAt: 100, scope: 'project' },
    ]),
  ),
  memHistory: vi.fn(() => Promise.resolve([])),
  runCommand: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({ pi: { memStats, memList, memHistory, runCommand } }));

import { MemoryPanel } from './MemoryPanel';


const renderPanel = () =>
  render(
    <ThemeProvider>
      <MemoryPanel />
    </ThemeProvider>,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MemoryPanel', () => {
  it('shows stats and both scopes by default', async () => {
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByTestId('mem-header').textContent).toContain('项目 1'));
    expect(screen.getByTestId('mem-header').textContent).toContain('全局 1');
    expect(screen.getByTestId('mem-item-global-g1')).toBeTruthy();
    expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy();
  });

  it('filters by scope', async () => {
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mem-filter-project'));
    expect(screen.queryByTestId('mem-item-global-g1')).toBeNull();
    expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy();
  });

  it('shows detail when an item is clicked', async () => {
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mem-item-project-p1'));
    expect(screen.getByTestId('mem-detail').textContent).toContain('project pref');
    expect(screen.getByTestId('mem-detail').textContent).toContain('preference');
  });

  it('deletes the selected memory via popconfirm -> /memory forget', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mem-item-project-p1'));
    fireEvent.click(screen.getByTestId('mem-delete'));
    fireEvent.click(await screen.findByTestId('mem-delete-confirm'));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/memory forget p1'));
  });

  it('clears memories via popconfirm -> /memory clear', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('mem-clear')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mem-clear'));
    fireEvent.click(await screen.findByTestId('mem-clear-confirm'));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/memory clear all'));
  });

  it('clears history via popconfirm -> /memory history-clear (only in history view)', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('mem-view-history')).toBeTruthy());
    expect(screen.queryByTestId('mem-history-clear')).toBeNull();
    fireEvent.click(screen.getByTestId('mem-view-history'));
    fireEvent.click(await screen.findByTestId('mem-history-clear'));
    fireEvent.click(await screen.findByTestId('mem-history-clear-confirm'));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/memory history-clear all'));
  });

  it('adds a memory via modal -> /memory add', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('mem-add')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mem-add'));
    const ta = await screen.findByPlaceholderText('记忆内容');
    fireEvent.change(ta, { target: { value: '用户喜欢深色' } });
    fireEvent.click(screen.getByTestId('mem-editor-ok'));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/memory add 用户喜欢深色'));
  });

  it('promotes a project memory to global', async () => {
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mem-item-project-p1'));
    fireEvent.click(screen.getByTestId('mem-promote'));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/memory promote p1'));
  });

  it('edits text and category via modal -> /memory edit --cat', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mem-item-project-p1'));
    fireEvent.click(screen.getByTestId('mem-edit'));
    const ta = await screen.findByPlaceholderText('记忆内容');
    fireEvent.change(ta, { target: { value: 'updated text' } });
    fireEvent.change(screen.getByPlaceholderText('分类（留空清除，单个词）'), {
      target: { value: 'decision' },
    });
    fireEvent.click(screen.getByTestId('mem-editor-ok'));
    await waitFor(() =>
      expect(runCommand).toHaveBeenCalledWith('/ws', '/memory edit p1 --cat decision updated text'),
    );
  });

  it('clears category when category field emptied (--cat none)', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mem-item-project-p1'));
    fireEvent.click(screen.getByTestId('mem-edit'));
    const ta = await screen.findByPlaceholderText('记忆内容');
    fireEvent.change(ta, { target: { value: 'keep text' } });
    fireEvent.change(screen.getByPlaceholderText('分类（留空清除，单个词）'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByTestId('mem-editor-ok'));
    await waitFor(() =>
      expect(runCommand).toHaveBeenCalledWith('/ws', '/memory edit p1 --cat none keep text'),
    );
  });
});
