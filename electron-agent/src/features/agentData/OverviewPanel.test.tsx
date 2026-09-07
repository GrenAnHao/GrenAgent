// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewPanel } from './OverviewPanel';
import type { WorkbenchOverview } from '../../lib/agentData';

afterEach(cleanup);

describe('OverviewPanel', () => {
  it('opens exact library/page pairs and composite tasks while keeping partial overview data', () => {
    const onOpenResource = vi.fn();
    const recentMemory = 'on 后置阶段抽象 case ## 字段规范 === 7027 total === tests/integration: gemini-cli.integration.test.ts jshook-e2e.integration.test.ts';
    const data: WorkbenchOverview = { libraries: { total: 2, pendingSources: 3, pages: 4 }, recentPages: [{ kbId: 'kb-b', pageId: 'same-page', title: 'Shared title', libraryName: 'B', updatedAt: 1 }], recentMemories: [{ id: 'memory-id', content: recentMemory, level: 1, updatedAt: 1 }], activeTasks: 1, failedTasks: 2, errors: [{ domain: 'diagnostics', message: 'not checked' }] };
    render(<OverviewPanel memory={{ loading: false }} wiki={{ loading: false }} jobs={[]} jobsLoaded jobsLoading={false} onNavigate={vi.fn()} onOpenTask={vi.fn()} workbench={{ data, loading: false }} onOpenResource={onOpenResource} />);
    fireEvent.click(screen.getByRole('button', { name: /打开页面 Shared title/ }));
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'wiki', kbId: 'kb-b', pageId: 'same-page' });
    const memoryButton = screen.getByRole('button', { name: new RegExp(`打开记忆 ${recentMemory}`) });
    expect(memoryButton.getAttribute('title')).toBe(recentMemory);
    fireEvent.click(memoryButton);
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'memory', id: 'memory-id' });
    fireEvent.click(screen.getByRole('button', { name: '新建知识库' }));
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'wiki', mode: 'create' });
    expect(screen.getByText('not checked')).toBeTruthy();
  });

  it('does not invent an empty task result before loading and retains a known zero during refresh', () => {
    const props = { memory: { loading: false }, wiki: { loading: false }, jobs: [], jobsLoading: false, onNavigate: vi.fn(), onOpenTask: vi.fn() };
    const { rerender } = render(<OverviewPanel {...props} jobsLoaded={false} />);
    expect(within(screen.getByRole('button', { name: /^任务/ })).getByText('未获取')).toBeTruthy();
    expect(screen.queryByText('暂无任务')).toBeNull();
    rerender(<OverviewPanel {...props} jobsLoaded jobsLoading />);
    expect(within(screen.getByRole('button', { name: /^任务/ })).getByText('0')).toBeTruthy();
    rerender(<OverviewPanel {...props} jobsLoaded jobsError="offline" />);
    expect(within(screen.getByRole('button', { name: /^任务/ })).getByText('0')).toBeTruthy();
  });
  it('distinguishes unavailable data from real zero and retains successful metrics on partial failure', () => {
    render(<OverviewPanel memory={{ loading: false, error: 'memory unavailable' }} wiki={{ loading: false, data: { pages: 0, latestUpdatedAt: null } }} jobs={[]} jobsLoading={false} jobsLoaded onNavigate={vi.fn()} onOpenTask={vi.fn()} />);
    expect(within(screen.getByRole('button', { name: /Memory/ })).getByText('未获取')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /Wiki 页面/ })).getByText('0')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('memory unavailable');
    expect(screen.queryByText('ready')).toBeNull();
  });

  it('opens an existing panel or a selected recent task without inventing a creation action', () => {
    const onNavigate = vi.fn(); const onOpenTask = vi.fn();
    render(<OverviewPanel memory={{ loading: false, data: { total: 1, byLevel: { L0: 0, L1: 1, L2: 0, L3: 0 } } }} wiki={{ loading: false }} jobs={[{ id: 'j1', kind: 'wiki.sync', workspace: '/repo', state: 'completed', progress: 100, createdAt: 1, updatedAt: 1 }]} jobsLoading={false} jobsLoaded onNavigate={onNavigate} onOpenTask={onOpenTask} />);
    fireEvent.click(screen.getByRole('button', { name: /Wiki 页面/ }));
    expect(onNavigate).toHaveBeenCalledWith('wiki');
    fireEvent.click(screen.getByRole('button', { name: '查看任务 wiki.sync' }));
    expect(onOpenTask).toHaveBeenCalledWith('j1');
    expect(screen.queryByRole('button', { name: '新建知识库' })).toBeNull();
  });
});
