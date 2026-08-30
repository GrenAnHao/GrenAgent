import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { SubAgentInline } from './SubAgentInline';

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));

vi.mock('../../lib/pi', () => ({
  pi: {
    abort: vi.fn(),
    subagentList: vi.fn().mockResolvedValue([]),
    subagentCancel: vi.fn(),
  },
}));

afterEach(cleanup);

const wrap = (ui: React.ReactElement) =>
  render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);

describe('SubAgentInline', { timeout: 30_000 }, () => {
  it('折叠头显示子代理编号与任务名', () => {
    wrap(<SubAgentInline messageId="m1" toolCallId="c1" index={1} task="分析工具渲染" result={{}} status="done" />);
    expect(screen.getByText(/子代理 #1/)).toBeTruthy();
    expect(screen.getByText(/分析工具渲染/)).toBeTruthy();
  });

  it('运行中显示运行提示', () => {
    wrap(<SubAgentInline messageId="m2" toolCallId="c2" index={2} task="分析主结构" result={{}} status="running" />);
    expect(screen.getByText(/运行中/)).toBeTruthy();
  });

  it('后台 spawn 在工具已返回时仍显示运行中', async () => {
    const { pi } = await import('../../lib/pi');
    vi.mocked(pi.subagentList).mockResolvedValue([
      {
        id: 'sa-bg',
        task: 'bg task',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    wrap(
      <SubAgentInline
        messageId="m-bg"
        toolCallId="c-bg"
        index={1}
        task="后台任务"
        result={{ details: { agentId: 'sa-bg', status: 'running' } }}
        status="done"
      />,
    );
    expect(await screen.findByText(/运行中/)).toBeTruthy();
  });

  it('完成态根据 transcript 显示步数徽章', () => {
    const transcript = [
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      }),
      JSON.stringify({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: {} }),
      JSON.stringify({ type: 'tool_execution_end', toolCallId: 'c1', result: {}, isError: false }),
    ].join('\n');
    wrap(
      <SubAgentInline messageId="m3" toolCallId="c3" index={1} task="t" result={{ details: { transcript } }} status="done" />,
    );
    expect(screen.getByText(/已完成 · 2 步/)).toBeTruthy();
  });
});
