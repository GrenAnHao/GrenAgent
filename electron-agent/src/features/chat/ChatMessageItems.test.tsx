import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
  useOptionalAgentStoreContext: () => undefined,
}));
vi.mock('../dock/openLauncherTab', () => ({ openTurnReview: vi.fn() }));
vi.mock('../../platform/runtime', () => ({ openPath: vi.fn(), revealItemInDir: vi.fn() }));
import { App } from 'antd';
import { ThemeProvider } from '@lobehub/ui';
import { liveTurnId, renderMessageBody } from './ChatMessageItems';
import type { DisplayMessage } from './groupMessages';

afterEach(() => cleanup());

const writeTurn: DisplayMessage = {
  kind: 'turn',
  id: 'turn-1',
  segments: [
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
  ],
};

describe('renderMessageBody', () => {
  it('renders job-done notices as a JobDonePill with the first line as title', () => {
    render(
      <>
        {renderMessageBody(
          {
            kind: 'notice',
            id: 'n1',
            customType: 'job-done',
            content: 'Background job subagent-1 (subagent: L) finished completed.\nout',
          },
          new Map(),
          new Set(),
        )}
      </>,
    );
    expect(screen.getByTestId('job-done-pill')).toBeTruthy();
    expect(screen.getByText('Background job subagent-1 (subagent: L) finished completed.')).toBeTruthy();
    expect(screen.queryByText('已注入上下文')).toBeNull();
  });

  it('does not show 已编辑 when the fourth argument is omitted', () => {
    render(
      <App>
        <ThemeProvider themeMode="dark">
          {renderMessageBody(writeTurn, new Map(), new Set())}
        </ThemeProvider>
      </App>,
    );
    expect(screen.queryByText(/已编辑/)).toBeNull();
  });

  it('shows 已编辑 when the fourth argument is true', () => {
    render(
      <App>
        <ThemeProvider themeMode="dark">
          {renderMessageBody(writeTurn, new Map(), new Set(), true)}
        </ThemeProvider>
      </App>,
    );
    expect(screen.getByText(/已编辑/)).toBeTruthy();
  });

  it('does not show 已编辑 when liveTurn is true', () => {
    render(
      <App>
        <ThemeProvider themeMode="dark">
          {renderMessageBody(writeTurn, new Map(), new Set(), true, true)}
        </ThemeProvider>
      </App>,
    );
    expect(screen.queryByText(/已编辑/)).toBeNull();
  });
});

describe('liveTurnId', () => {
  const user: DisplayMessage = { kind: 'user', id: 'u2', text: '再写' };

  it('returns the trailing turn while the session is live', () => {
    expect(liveTurnId([writeTurn], true)).toBe('turn-1');
  });

  it('returns undefined when the session is idle', () => {
    expect(liveTurnId([writeTurn], false)).toBeUndefined();
  });

  it('does not treat a previous turn as live once a user message follows', () => {
    expect(liveTurnId([writeTurn, user], true)).toBeUndefined();
  });

  it('keeps the last turn live across notices and spawn_agent while the run is active', () => {
    expect(
      liveTurnId(
        [
          writeTurn,
          { kind: 'notice', id: 'n1', customType: 'extension-context', content: 'hint' },
          {
            kind: 'tool',
            id: 's1',
            toolCallId: 's1',
            toolName: 'spawn_agent',
            args: {},
            result: {},
            status: 'running',
          },
        ],
        true,
      ),
    ).toBe('turn-1');
  });

  it('skips trailing command-input when finding the live turn', () => {
    expect(
      liveTurnId(
        [writeTurn, { kind: 'command-input', id: 'c1', command: '/goal', rest: '', beforeCount: 1 }],
        true,
      ),
    ).toBe('turn-1');
  });
});
