import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { SubAgentGroupInline, type NumberedUnit } from './SubAgentGroupInline';
import { pi } from '../../lib/pi';
import type { SubAgentUnit } from '../panels/subagentUtils';
import { invalidateProviderList } from '../settings/providerListCache';

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws', store: { getLoadedSessionPath: () => null } }),
}));

vi.mock('../../lib/pi', () => ({
  pi: {
    abort: vi.fn(),
    subagentList: vi.fn().mockResolvedValue([]),
    getProviderConfig: vi.fn().mockRejectedValue(new Error('no provider config')),
  },
}));

afterEach(() => {
  cleanup();
  vi.mocked(pi.subagentList).mockReset();
  vi.mocked(pi.subagentList).mockResolvedValue([]);
  vi.mocked(pi.getProviderConfig).mockRejectedValue(new Error('no provider config'));
  invalidateProviderList();
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
      'deepseek / deepseek-v4-flash',
      'deepseek / deepseek-v4-flash',
      'deepseek / deepseek-v4-flash',
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

  it('same model id under two custom providers is told apart by the provider display name', async () => {
    vi.mocked(pi.getProviderConfig).mockResolvedValue({
      modelsJson: JSON.stringify({ providers: { 'custom-a': { name: '官方直连' }, 'custom-b': { name: '中转站' } } }),
      authJson: null,
    } as never);
    wrap(<SubAgentGroupInline messageId="prov" toolCallId="prov-c" mode="parallel" status="done"
      units={[
        row(1, { task: 'A', status: 'done', model: 'custom-a/deepseek-v4.1-flash' }),
        row(2, { task: 'B', status: 'done', model: 'custom-b/deepseek-v4.1-flash' }),
      ]} />);
    await vi.waitFor(() => expect(screen.getAllByTestId('subagent-step-model').map((node) => node.textContent)).toEqual([
      '官方直连 / deepseek-v4.1-flash',
      '中转站 / deepseek-v4.1-flash',
    ]));
  });

  it('a step whose args only named the strong alias shows the registry route', async () => {
    vi.mocked(pi.subagentList).mockResolvedValue([
      { id: 'sa-strong', task: '重试', status: 'error', model: 'p/claude-sonnet-5-5', createdAt: 1, updatedAt: 1 },
    ]);
    wrap(<SubAgentGroupInline messageId="alias" toolCallId="alias-c" mode="parallel" status="done"
      units={[row(1, { agentId: 'sa-strong', task: '重试', status: 'error', model: 'strong' })]} />);
    await vi.waitFor(() => expect(screen.getByTestId('subagent-step-model')).toHaveTextContent('claude-sonnet-5-5'));
  });

  it('reopened repeated tasks match the saved agent id rather than another child task', async () => {
    vi.mocked(pi.subagentList).mockResolvedValue([
      { id: 'sa-other', task: '同一个任务', status: 'done', model: 'p/wrong', createdAt: 2, updatedAt: 2 },
      { id: 'sa-history', task: '同一个任务', status: 'done', model: 'p/correct', thinkingLevel: 'medium', createdAt: 1, updatedAt: 1 },
    ]);
    wrap(<SubAgentGroupInline messageId="history" toolCallId="history-c" mode="parallel" status="done"
      units={[row(1, { agentId: 'sa-history', task: '同一个任务', status: 'done' })]} />);
    expect(await screen.findByTestId('subagent-step-model')).toHaveTextContent('correct · 中');
  });
});
