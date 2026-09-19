import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
  useOptionalAgentStoreContext: () => undefined,
}));
vi.mock('../dock/openLauncherTab', () => ({ openTurnReview: vi.fn() }));
vi.mock('../../platform/runtime', () => ({ openPath: vi.fn(), revealItemInDir: vi.fn() }));
import { cleanup, render, screen, within } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { App } from 'antd';
import { TurnTimeline } from './TurnTimeline';
import type { TimelineSegment } from './groupMessages';

afterEach(cleanup);

const textTurn: TimelineSegment[] = [
  { kind: 'text', id: 't1', content: '答案正文', streaming: false },
];
const toolOnly: TimelineSegment[] = [
  {
    kind: 'tool',
    id: 'x1',
    toolCallId: 'c1',
    toolName: 'read',
    args: {},
    result: {},
    status: 'done',
  },
];

const writeSettled: TimelineSegment[] = [
  {
    kind: 'tool',
    id: 'w',
    toolCallId: 'w1',
    toolName: 'write',
    args: { path: 'a.txt', content: 'hello' },
    result: { content: [] },
    status: 'done',
  },
  { kind: 'text', id: 't', content: '写好了', streaming: false },
];

const wrap = (
  segments: TimelineSegment[],
  props?: { showDeliverables?: boolean; turnId?: string; live?: boolean },
) =>
  render(
    <App>
      <ThemeProvider themeMode="dark">
        <TurnTimeline segments={segments} {...props} />
      </ThemeProvider>
    </App>,
  );

describe('TurnTimeline 助手复制', () => {
  it('有正文时渲染复制按钮并复制拼接文本', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    wrap(textTurn);
    within(screen.getByTestId('message-action-bar')).getByTestId('msg-action-bar-copy').click();
    expect(writeText).toHaveBeenCalledWith('答案正文');
  });

  it('仅工具无正文时不渲染复制', () => {
    const { container } = wrap(toolOnly);
    expect(container.querySelector('.chat-actions')).toBeNull();
  });

  it('整段 JSON 助手回复走预格式化，不被 Markdown 收成一行', () => {
    wrap([
      {
        kind: 'text',
        id: 'json',
        content: '{"l1":{"PI_MODEL":"claude-opus-5"},"l2":"用户询问模型身份"}',
        streaming: false,
      },
    ]);
    const pre = screen.getByTestId('structured-pre');
    expect(pre.textContent).toContain('"l1"');
    expect(pre.textContent).toContain('claude-opus-5');
  });
});

describe('TurnTimeline 产物尾栏', () => {
  it('showDeliverables 且回合已结束时展示已编辑', () => {
    wrap(writeSettled, { showDeliverables: true, turnId: 'turn-1' });
    expect(screen.getByText(/已编辑/)).toBeTruthy();
  });

  it('默认不传 showDeliverables 时不展示已编辑', () => {
    wrap(writeSettled, { turnId: 'turn-1' });
    expect(screen.queryByText(/已编辑/)).toBeNull();
  });

  it('does not show 已编辑 on the live turn while the session is still running', () => {
    wrap(writeSettled, { showDeliverables: true, turnId: 'turn-1', live: true });
    expect(screen.queryByText(/已编辑/)).toBeNull();
  });
});
