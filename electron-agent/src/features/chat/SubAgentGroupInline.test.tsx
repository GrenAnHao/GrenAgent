import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { SubAgentGroupInline, type NumberedUnit } from './SubAgentGroupInline';
import { pi } from '../../lib/pi';
import type { SubAgentUnit } from '../panels/subagentUtils';

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws', store: { getLoadedSessionPath: () => null } }),
}));

vi.mock('../../lib/pi', () => ({
  pi: {
    abort: vi.fn(),
    subagentList: vi.fn().mockResolvedValue([]),
  },
}));

afterEach(() => {
  cleanup();
  vi.mocked(pi.subagentList).mockReset();
  vi.mocked(pi.subagentList).mockResolvedValue([]);
});

const wrap = (ui: ReactElement) => render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);

function row(no: number, unit: Omit<SubAgentUnit, 'key' | 'subIndex'>): NumberedUnit {
  return { no, unit: { key: `m#${no}`, subIndex: no - 1, ...unit } };
}

describe('SubAgentGroupInline chain status', () => {
  it('shows the model on a finished step and waits on the steps that have not started', () => {
    wrap(
      <SubAgentGroupInline
        messageId="m1"
        toolCallId="c1"
        mode="chain"
        status="running"
        units={[
          row(1, { task: '实现任务 5', status: 'done', model: 'deepseek/deepseek-v4-flash' }),
          row(2, { task: '审查任务 5', status: 'running', model: 'deepseek/deepseek-v4-flash' }),
          row(3, { task: '代码质量审查', status: 'waiting', model: 'deepseek/deepseek-v4-flash' }),
        ]}
      />,
    );
    expect(screen.getAllByTestId('subagent-step-model').map((node) => node.textContent)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-flash',
      'deepseek-v4-flash',
    ]);
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText(/正在处理/)).toBeTruthy();
    expect(screen.getByText('等待上一步完成')).toBeTruthy();
    expect(screen.getAllByText(/正在处理/)).toHaveLength(1);
    const pending = screen.getByTestId('pending-response');
    expect(pending.querySelector('[data-testid="pending-response-dot"]')).toBeNull();
    expect(pending).toHaveAttribute('data-size', 'inherit');
  });

  it('fills a finished step model from the registry when the saved result omitted it', async () => {
    vi.mocked(pi.subagentList).mockResolvedValue([
      {
        id: 'sa-1',
        task: '实现任务 4',
        status: 'done',
        model: 'deepseek/deepseek-v4-flash',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    wrap(
      <SubAgentGroupInline
        messageId="m2"
        toolCallId="c2"
        mode="chain"
        status="done"
        units={[row(1, { task: '实现任务 4', status: 'done' })]}
      />,
    );
    expect(await screen.findByTestId('subagent-step-model')).toHaveTextContent('deepseek-v4-flash');
    expect(screen.getByText('已完成')).toBeTruthy();
  });
});
