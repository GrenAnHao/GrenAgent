// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewPanel } from './OverviewPanel';
import { task } from './operationsTestData';
import { wikiAsset } from './wiki/wikiTestData';
import type { WorkbenchOverview } from '../../lib/agentData';

afterEach(cleanup);
const workbench: WorkbenchOverview = { libraries: { total: 2, pendingSources: 0, pages: 4 }, recentPages: [], activeTasks: 1, failedTasks: 2, diagnostics: { actionRequired: 1, unchecked: 0 }, errors: [] };
const base = {
  workbench: { loading: false, data: workbench },
  libraries: { loading: false, data: [wikiAsset] },
  codeProjects: { loading: false, data: [{ workspace: 'D:/a', indexed: true }, { workspace: 'D:/b', indexed: false }] },
  tasks: [task], tasksLoaded: true,
};

describe('OverviewPanel', () => {
  it('does not expose retired Memory entry points or metrics', () => {
    render(<OverviewPanel {...base} onNavigate={vi.fn()} onOpenResource={vi.fn()} />);
    expect(screen.queryAllByRole('button', { name: /记忆/ })).toHaveLength(0);
    expect(screen.queryByRole('region', { name: '最近记忆' })).not.toBeInTheDocument();
  });
  it('shows the three KPI cells from real sources', () => {
    render(<OverviewPanel {...base} onNavigate={vi.fn()} onOpenResource={vi.fn()} />);
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
  it('opens a recent task and library', () => {
    const onOpenResource = vi.fn();
    render(<OverviewPanel {...base} onNavigate={vi.fn()} onOpenResource={onOpenResource} />);
    fireEvent.click(screen.getByRole('button', { name: /查看任务 生成知识页面/ }));
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'jobs', task: task.ref });
    fireEvent.click(screen.getByRole('button', { name: /打开知识库 产品/ }));
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'wiki', kbId: 'k' });
    fireEvent.click(screen.getByRole('button', { name: '新建知识库' }));
    expect(onOpenResource).toHaveBeenLastCalledWith({ view: 'wiki', mode: 'create' });
  });
  it('says 未获取 instead of zero when a source failed', () => {
    render(<OverviewPanel {...base} codeProjects={{ loading: false, error: 'x' }} tasksLoaded={false} onNavigate={vi.fn()} onOpenResource={vi.fn()} />);
    expect(within(screen.getByRole('button', { name: /个项目已索引/ })).getByText('未获取')).toBeInTheDocument();
  });
});
