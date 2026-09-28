// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewPanel } from './OverviewPanel';
import { task } from './operationsTestData';
import { wikiAsset } from './wiki/wikiTestData';
import type { WorkbenchOverview } from '../../lib/agentData';

afterEach(cleanup);
const workbench: WorkbenchOverview = { libraries: { total: 2, pendingSources: 0, pages: 4 }, recentPages: [], recentMemories: [{ id: 'm1', content: '偏好中文', level: 2, updatedAt: Date.now(), scope: 'project', sourceProjectId: 'D:/proj/alpha' }], activeTasks: 1, failedTasks: 2, diagnostics: { actionRequired: 1, unchecked: 0 }, errors: [] };
const base = {
  memory: { loading: false, data: { total: 5, byLevel: { L0: 1, L1: 2, L2: 1, L3: 1 } } },
  workbench: { loading: false, data: workbench },
  libraries: { loading: false, data: [wikiAsset] },
  codeProjects: { loading: false, data: [{ workspace: 'D:/a', indexed: true }, { workspace: 'D:/b', indexed: false }] },
  tasks: [task], tasksLoaded: true,
};

describe('OverviewPanel', () => {
  it('shows the four KPI cells from real sources', () => {
    render(<OverviewPanel {...base} onNavigate={vi.fn()} onOpenResource={vi.fn()} />);
    expect(within(screen.getByRole('button', { name: /条记忆/ })).getByText('5')).toBeInTheDocument();
    expect(screen.getByText('L0 1 · L1 2 · L2 1 · L3 1')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /个知识页面/ })).getByText('4')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /个项目已索引/ })).getByText('1 / 2')).toBeInTheDocument();
    expect(screen.getByText('2 个失败')).toBeInTheDocument();
  });
  it('shows the diagnostics banner and navigates to audit', () => {
    const onNavigate = vi.fn();
    render(<OverviewPanel {...base} onNavigate={onNavigate} onOpenResource={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('有 1 项诊断需要处理');
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(onNavigate).toHaveBeenCalledWith('audit');
  });
  it('opens a recent task, library and memory', () => {
    const onOpenResource = vi.fn();
    render(<OverviewPanel {...base} onNavigate={vi.fn()} onOpenResource={onOpenResource} />);
    fireEvent.click(screen.getByRole('button', { name: /查看任务 生成知识页面/ }));
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'jobs', task: task.ref });
    fireEvent.click(screen.getByRole('button', { name: /打开知识库 产品/ }));
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'wiki', kbId: 'k' });
    const memory = screen.getByRole('button', { name: /打开记忆 偏好中文/ });
    expect(memory).toHaveTextContent('L2 · alpha');
    fireEvent.click(memory);
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'memory', id: 'm1' });
    fireEvent.click(screen.getByRole('button', { name: '新建知识库' }));
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'wiki', mode: 'create' });
  });
  it('says 未获取 instead of zero when a source failed', () => {
    render(<OverviewPanel {...base} memory={{ loading: false, error: 'memory unavailable' }} codeProjects={{ loading: false, error: 'x' }} tasksLoaded={false} onNavigate={vi.fn()} onOpenResource={vi.fn()} />);
    expect(within(screen.getByRole('button', { name: /条记忆/ })).getByText('未获取')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /个项目已索引/ })).getByText('未获取')).toBeInTheDocument();
    expect(screen.getByText(/memory unavailable/)).toBeInTheDocument();
  });
});
