// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { memoryOverview, wikiOverview, codeStatus } = vi.hoisted(() => ({
  memoryOverview: vi.fn(),
  wikiOverview: vi.fn(),
  codeStatus: vi.fn(),
}));

vi.mock('../../../../lib/agentData', () => ({
  agentDataApi: {
    memory: { overview: memoryOverview },
    wiki: { overview: wikiOverview },
    code: { status: codeStatus },
  },
}));

import { ProjectContextPanel } from './ProjectContextPanel';

beforeEach(() => {
  vi.clearAllMocks();
  memoryOverview.mockResolvedValue({ total: 8, byLevel: { L0: 2, L1: 3, L2: 2, L3: 1 } });
  wikiOverview.mockResolvedValue({ pages: 5, latestUpdatedAt: 123 });
  codeStatus.mockResolvedValue({ workspace: '/repo', connected: true, indexed: true, files: 12, nodes: 48, edges: 75 });
});

afterEach(cleanup);

describe('ProjectContextPanel', () => {
  it('loads project summaries from Agent Data instead of showing a permanent initializer', async () => {
    render(<ProjectContextPanel active workspace="/repo" />);

    const panel = screen.getByRole('region', { name: 'repo 项目上下文' });
    expect(await within(panel).findByText('8 条记忆')).toBeTruthy();
    expect(within(panel).getByText('5 个 Wiki 页面')).toBeTruthy();
    expect(within(panel).getByText('12 个文件')).toBeTruthy();
    expect(within(panel).queryByText('项目数据模块正在初始化。')).toBeNull();
    expect(memoryOverview).toHaveBeenCalledWith({ userId: 'local', workspace: '/repo' });
    expect(wikiOverview).toHaveBeenCalledWith('/repo');
    expect(codeStatus).toHaveBeenCalledWith('/repo');
  });

  it('reports loading failures and reloads when the workspace changes', async () => {
    memoryOverview.mockRejectedValueOnce(new Error('runtime unavailable'));
    const view = render(<ProjectContextPanel active workspace="/repo-a" />);

    expect((await screen.findByRole('alert')).textContent).toContain('runtime unavailable');

    view.rerender(<ProjectContextPanel active workspace="/repo-b" />);
    await waitFor(() => expect(memoryOverview).toHaveBeenCalledWith({ userId: 'local', workspace: '/repo-b' }));
    expect(await screen.findByText('8 条记忆')).toBeTruthy();
  });
});
