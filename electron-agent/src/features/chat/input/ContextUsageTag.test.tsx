import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyContextStats, type ContextStats } from '../../../lib/sessionStats';

const { compact, getSettings, setSettings, statsBox, messageCount, sessionPath } = vi.hoisted(() => ({
  compact: vi.fn(),
  getSettings: vi.fn(() => Promise.resolve({} as Record<string, string>)),
  setSettings: vi.fn(() => Promise.resolve()),
  statsBox: { current: null as ContextStats | null },
  messageCount: { current: 1 },
  sessionPath: { current: '/s/a.jsonl' as string | null },
}));

vi.mock('@lobehub/ui', () => ({
  Popover: ({
    content,
    children,
    placement,
    positionerProps,
  }: {
    content: unknown;
    children: unknown;
    placement?: string;
    positionerProps?: {
      collisionAvoidance?: { align?: string };
      collisionBoundary?: Element | null;
    };
  }) => (
    <div
      data-align={positionerProps?.collisionAvoidance?.align}
      data-boundary={
        positionerProps?.collisionBoundary instanceof HTMLElement &&
        positionerProps.collisionBoundary.hasAttribute('data-chat-column')
          ? 'column'
          : 'missing'
      }
      data-placement={placement}
      data-testid="context-usage-popover"
    >
      {children as never}
      {content as never}
    </div>
  ),
  Icon: () => null,
}));
vi.mock('@lobehub/ui/chat', () => ({ TokenTag: () => <span>用量</span> }));
vi.mock('../../../lib/pi', () => ({ pi: { compact, getSettings, setSettings } }));
vi.mock('../../settings/useSettingsForm', () => ({ hydrateSettingsValues: vi.fn() }));
vi.mock('../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({
    workspace: '/ws',
    store: {
      useStore: (sel: (s: { messages: unknown[]; compacting: boolean }) => unknown) => sel({ messages: Array(messageCount.current), compacting: false }),
      getLoadedSessionPath: () => sessionPath.current,
    },
  }),
}));
vi.mock('../../../store', () => ({
  useSessionStore: (sel: (s: { activeSessionPath: string }) => unknown) => sel({ activeSessionPath: '/s' }),
}));
vi.mock('../../../hooks/useSessionStats', () => ({
  useSessionStats: () => ({ stats: statsBox.current }),
}));

import { ContextUsageTag, contextUsageTone } from './ContextUsageTag';

function statsAt(percent: number, known = true): ContextStats {
  return {
    ...emptyContextStats(),
    contextKnown: known,
    contextPercent: percent,
    contextLimit: 100,
    contextUsed: known ? percent : null,
    contextStatus: known ? 'warning' : 'unknown',
  };
}

afterEach(() => {
  cleanup();
  compact.mockClear();
  getSettings.mockReset();
  getSettings.mockResolvedValue({});
  setSettings.mockClear();
  messageCount.current = 1;
  sessionPath.current = '/s/a.jsonl';
});

describe('contextUsageTone', () => {
  it('60 及以下为绿色档', () => {
    expect(contextUsageTone(0)).toBe('success');
    expect(contextUsageTone(60)).toBe('success');
  });

  it('超过 60 到 80 为警告色', () => {
    expect(contextUsageTone(60.1)).toBe('warning');
    expect(contextUsageTone(80)).toBe('warning');
  });

  it('超过 80 为红色', () => {
    expect(contextUsageTone(80.1)).toBe('error');
    expect(contextUsageTone(100)).toBe('error');
  });
});

describe('ContextUsageTag compact button', () => {
  it('没有对话时不显示用量', () => {
    messageCount.current = 0;
    statsBox.current = statsAt(10);
    const { container } = render(<ContextUsageTag />);
    expect(container).toBeEmptyDOMElement();
  });

  it('用量不到 70% 也可以压缩', () => {
    statsBox.current = statsAt(10);
    render(<ContextUsageTag />);
    fireEvent.click(screen.getByRole('button', { name: '压缩上下文' }));
    expect(compact).toHaveBeenCalledWith('/ws');
  });

  it('没有会话覆盖时显示全局触发值，跟随全局不是按钮', async () => {
    getSettings.mockResolvedValue({ AUTO_COMPACT_PERCENT: '70' });
    statsBox.current = statsAt(10);
    render(<ContextUsageTag />);
    expect(await screen.findByText('70%')).toBeTruthy();
    const follow = screen.getByTestId('auto-compact-follow');
    expect(follow.tagName).not.toBe('BUTTON');
    expect(follow.textContent).toContain('跟随全局设置（70%）');
  });

  it('点击跟随全局设置清掉该会话的覆盖', async () => {
    getSettings.mockResolvedValue({
      AUTO_COMPACT_PERCENT: '70',
      AUTO_COMPACT_OVERRIDES: JSON.stringify({ '/s/a.jsonl': 78 }),
    });
    statsBox.current = statsAt(10);
    render(<ContextUsageTag />);
    const follow = await screen.findByRole('button', { name: '跟随全局设置（70%）' });
    fireEvent.click(follow);
    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    const next = setSettings.mock.calls[0][0] as Record<string, string>;
    expect(next.AUTO_COMPACT_OVERRIDES).toBeUndefined();
    expect(next.AUTO_COMPACT_PERCENT).toBe('70');
  });

  it('默认朝右展开，放不下时按对话列翻到左边', () => {
    statsBox.current = statsAt(10);
    render(
      <div data-chat-column="">
        <ContextUsageTag />
      </div>,
    );
    const popover = screen.getByTestId('context-usage-popover');
    expect(popover.getAttribute('data-placement')).toBe('topLeft');
    expect(popover.getAttribute('data-align')).toBe('flip');
    expect(popover.getAttribute('data-boundary')).toBe('column');
  });
});
