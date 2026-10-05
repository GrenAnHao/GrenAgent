import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { SubAgentInline } from './SubAgentInline';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';

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
  it('没有模型时不留模型标签', () => {
    wrap(
      <SubAgentInline messageId="m-empty" toolCallId="c-empty" index={35} task="整体实现终审" result={{}} status="error" />,
    );
    expect(screen.queryByTestId('conv-strip-model')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(screen.queryByTestId('subagent-inline-model')).toBeNull();
    expect(screen.getAllByText('出错').length).toBeGreaterThan(0);
  });

  it('有模型时折叠头和展开区都用标签显示短名', () => {
    wrap(
      <SubAgentInline
        messageId="m-model"
        toolCallId="c-model"
        index={1}
        task="审查改动"
        result={{ details: { model: 'deepseek/deepseek-v4-flash' } }}
        status="done"
      />,
    );
    expect(screen.getByTestId('conv-strip-model')).toHaveTextContent('deepseek-v4-flash');
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(screen.getByTestId('subagent-inline-model')).toHaveTextContent('deepseek-v4-flash');
  });

  it('折叠头显示子代理编号与任务名', () => {
    wrap(<SubAgentInline messageId="m1" toolCallId="c1" index={1} task="分析工具渲染" result={{}} status="done" />);
    expect(screen.getByText(/子代理 #1/)).toBeTruthy();
    expect(screen.getByText(/分析工具渲染/)).toBeTruthy();
  });

  it('有 title 时折叠头显示任务名，不截任务原文', () => {
    wrap(
      <SubAgentInline
        messageId="m1"
        toolCallId="c1"
        index={1}
        title="审服务端"
        task="你是代码审查代理。请完整审查一次已完成的服务端改动。"
        result={{}}
        status="done"
      />,
    );
    expect(screen.getByText(/审服务端/)).toBeTruthy();
    expect(screen.queryByText(/完整审查一次已完成的服务端改动/)).toBeNull();
  });

  it('卡死超时显示超时，不显示已完成', () => {
    wrap(
      <SubAgentInline
        messageId="m-stuck"
        toolCallId="c-stuck"
        index={19}
        task="你正在实现套餐多周期定价"
        result={{
          content: [{ type: 'text', text: 'agent sa-5b98b26f: error\n\nError: stuck: no activity for >300s' }],
          details: { agentId: 'sa-5b98b26f', status: 'error', error: 'stuck: no activity for >300s' },
        }}
        status="done"
      />,
    );
    expect(screen.getByText('超时')).toBeTruthy();
    expect(screen.queryByText(/已完成/)).toBeNull();
  });

  it('运行中显示运行提示', () => {
    wrap(<SubAgentInline messageId="m2" toolCallId="c2" index={2} task="分析主结构" result={{}} status="running" />);
    expect(screen.getByText(/正在处理/)).toBeTruthy();
  });

  it('后台 spawn 在工具已返回时仍显示运行中', async () => {
    const { pi } = await import('../../lib/pi');
    vi.mocked(pi.subagentList).mockResolvedValue([
      {
        id: 'sa-bg',
        task: 'bg task',
        status: 'running',
        createdAt: Date.now(),
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
    expect(await screen.findByText(/正在处理/)).toBeTruthy();
  });

  it('重启后只剩下启动回执时显示已中断，而不是已完成', async () => {
    const { pi } = await import('../../lib/pi');
    vi.mocked(pi.subagentList).mockResolvedValue([
      {
        id: 'sa-6ecb335e',
        task: '实现周期常量',
        status: 'done',
        error: 'sidecar restarted',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    wrap(
      <SubAgentInline
        messageId="m-restart"
        toolCallId="c-restart"
        index={43}
        task="你正在实现周期常量"
        result={{
          content: [{ type: 'text', text: 'Background sub-agent started. agentId: sa-6ecb335e\nUse spawn_agent({ action: "wait", agentId: "sa-6ecb335e" }) to await.' }],
          details: { agentId: 'sa-6ecb335e', status: 'running' },
        }}
        status="done"
      />,
    );
    expect(await screen.findByText('已中断')).toBeTruthy();
    expect(screen.queryByText(/已完成/)).toBeNull();
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

describe('SubAgentInline 打开右坞', { timeout: 30_000 }, () => {
  beforeEach(() => {
    useDockStore.setState({ tabs: [], closedTabs: [], activeByRegion: { right: null, bottom: null } });
    useLayoutStore.setState({ rightPanelOpen: false, rightPanelFill: false, availableWidth: 0 });
  });

  it('点卡片本体在右坞打开该子代理并展开右面板', () => {
    wrap(<SubAgentInline messageId="m-open" toolCallId="c-open" index={1} task="审查改动" result={{}} status="done" />);
    fireEvent.click(screen.getByText(/子代理 #1/));
    const tab = useDockStore.getState().tabs.find((t) => t.id === 'm-open');
    expect(tab?.kind).toBe('subagent');
    expect(useDockStore.getState().activeByRegion.right).toBe('m-open');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });

  it('折叠箭头只展开/收起，展开后「打开完整对话」也能打开右坞', () => {
    wrap(<SubAgentInline messageId="m-chev" toolCallId="c-chev" index={1} task="审查改动" result={{}} status="done" />);
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(useDockStore.getState().tabs).toHaveLength(0);
    fireEvent.click(screen.getByText('打开完整对话'));
    expect(useDockStore.getState().activeByRegion.right).toBe('m-chev');
    expect(useLayoutStore.getState().rightPanelOpen).toBe(true);
  });
});
