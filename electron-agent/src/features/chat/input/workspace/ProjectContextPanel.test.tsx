// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { codeStatus } = vi.hoisted(() => ({ codeStatus: vi.fn() }));

vi.mock('../../../../lib/agentData', () => ({
  agentDataApi: {
    code: { status: codeStatus },
  },
}));

import { ProjectContextPanel } from './ProjectContextPanel';

beforeEach(() => {
  vi.clearAllMocks();
  codeStatus.mockResolvedValue({ workspace: '/repo', connected: true, indexed: true, files: 12, nodes: 48, edges: 75 });
});

afterEach(cleanup);

describe('ProjectContextPanel', () => {
  it('loads CodeGraph status without a Wiki API', async () => {
    render(<ProjectContextPanel active workspace="/repo" />);

    const panel = screen.getByRole('region', { name: 'repo 项目上下文' });
    expect(await within(panel).findByText('48 个节点 · 75 条边')).toBeTruthy();
    expect(within(panel).queryByText(/Wiki/)).toBeNull();
    expect(within(panel).queryByText(/条记忆/)).toBeNull();
    expect(within(panel).getByText('12 个文件')).toBeTruthy();
    expect(within(panel).queryByText('项目数据模块正在初始化。')).toBeNull();
    expect(codeStatus).toHaveBeenCalledWith('/repo');
  });

  it('reports loading failures and reloads when the workspace changes', async () => {
    codeStatus.mockRejectedValueOnce(new Error('runtime unavailable'));
    const view = render(<ProjectContextPanel active workspace="/repo-a" />);

    expect((await screen.findByRole('alert')).textContent).toContain('runtime unavailable');

    view.rerender(<ProjectContextPanel active workspace="/repo-b" />);
    await waitFor(() => expect(codeStatus).toHaveBeenCalledWith('/repo-b'));
    expect(await screen.findByText('12 个文件')).toBeTruthy();
  });
});
