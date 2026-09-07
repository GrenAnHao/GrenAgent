// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { setStatus, goalSetGoal, goalSetSnapshot, setServers, msg, setRequest } = vi.hoisted(() => ({
  setStatus: vi.fn(),
  goalSetGoal: vi.fn(),
  goalSetSnapshot: vi.fn(),
  setServers: vi.fn(),
  msg: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  setRequest: vi.fn(),
}));
let emit: (e: unknown) => void = () => {};
let emitGoal: (e: unknown) => void = () => {};
vi.mock('../../lib/pi', () => ({
  onPiUiRequest: (h: (e: unknown) => void) => {
    emit = h;
    return Promise.resolve(() => {});
  },
  onGoalStatus: (h: (e: unknown) => void) => {
    emitGoal = h;
    return Promise.resolve(() => {});
  },
}));
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return { ...actual, App: Object.assign({}, actual.App, { useApp: () => ({ message: msg }) }) };
});
vi.mock('../../stores/planModeStore', () => ({
  usePlanModeStore: { getState: () => ({ setStatus }) },
}));
vi.mock('../../stores/goalStore', () => ({
  useGoalStore: { getState: () => ({ setGoal: goalSetGoal, setSnapshot: goalSetSnapshot }) },
}));
vi.mock('../../stores/mcpStatusStore', () => ({
  useMcpStatusStore: { getState: () => ({ setServers }) },
}));
vi.mock('../../stores/uiPromptStore', () => ({
  useUiPromptStore: { getState: () => ({ setRequest }) },
}));

import { ExtensionUiHost } from './ExtensionUiHost';
import { useImMessagesStore } from '../../stores/imMessagesStore';

afterEach(() => {
  cleanup();
  setStatus.mockClear();
  goalSetGoal.mockClear();
  goalSetSnapshot.mockClear();
  setServers.mockClear();
  setRequest.mockClear();
  emit = () => {};
  emitGoal = () => {};
  msg.info.mockClear();
  msg.warning.mockClear();
  useImMessagesStore.getState().setConversations([]);
});

describe('ExtensionUiHost', () => {
  it('routes select to the uiPromptStore without a modal', () => {
    render(<ExtensionUiHost />);
    const request = { id: 'u1', method: 'select', title: '允许？', options: ['允许', '拒绝'] };
    emit({ workspace: '/ws', request });
    expect(setRequest).toHaveBeenCalledWith({ workspace: '/ws', request });
    expect(screen.queryByText('允许？')).toBeNull();
  });

  it('routes confirm to the uiPromptStore without a modal', () => {
    render(<ExtensionUiHost />);
    const request = { id: 'u2', method: 'confirm', title: '项目信任', message: '信任此工作区？' };
    emit({ workspace: '/ws', request });
    expect(setRequest).toHaveBeenCalledWith({ workspace: '/ws', request });
    expect(screen.queryByText('信任此工作区？')).toBeNull();
  });

  it('routes setStatus(plan-mode) to the store without opening a modal', () => {
    render(<ExtensionUiHost />);
    emit({ workspace: '/ws', request: { id: 's1', method: 'setStatus', statusKey: 'plan-mode', statusText: '📋 Plan' } });
    expect(setStatus).toHaveBeenCalledWith('📋 Plan');
    expect(screen.queryByText('📋 Plan')).toBeNull();
  });

  it('routes setStatus(mcp) to the mcp status store', () => {
    render(<ExtensionUiHost />);
    emit({
      workspace: '/ws',
      request: {
        id: 'm1',
        method: 'setStatus',
        statusKey: 'mcp',
        statusText: '[{"name":"fs","transport":"stdio","status":"connected","tools":14}]',
      },
    });
    expect(setServers).toHaveBeenCalledWith([{ name: 'fs', transport: 'stdio', status: 'connected', tools: 14 }]);
  });

  it('routes setStatus(wechat-messages) into the im messages store', () => {
    render(<ExtensionUiHost />);
    const conversations = [
      { user: 'u1', messages: [{ role: 'user', text: '在吗' }, { role: 'assistant', text: '在的' }] },
    ];
    emit({
      workspace: '/ws',
      request: {
        id: 'wm1',
        method: 'setStatus',
        statusKey: 'wechat-messages',
        statusText: JSON.stringify(conversations),
      },
    });
    expect(useImMessagesStore.getState().conversations).toEqual(conversations);
  });

  it('ignores malformed wechat-messages payload without throwing', () => {
    render(<ExtensionUiHost />);
    emit({
      workspace: '/ws',
      request: { id: 'wm2', method: 'setStatus', statusKey: 'wechat-messages', statusText: '{not json' },
    });
    expect(useImMessagesStore.getState().conversations).toEqual([]);
  });

  it('routes a schema v1 goal snapshot by its session id', () => {
    render(<ExtensionUiHost />);
    const snapshot = {
      goalId: 'goal-a',
      sessionId: 'session-a',
      workspace: '/ws',
      revision: 2,
      condition: '写完测试',
      status: 'active',
      roundsUsed: 1,
      maxRounds: 256,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:01.000Z',
    };
    emit({
      workspace: '/ws',
      request: {
        id: 'g1',
        method: 'setStatus',
        statusKey: 'goal',
        statusText: JSON.stringify({ schemaVersion: 1, ...snapshot }),
      },
    });
    expect(goalSetSnapshot).toHaveBeenCalledWith('session-a', expect.objectContaining(snapshot));
    expect(goalSetGoal).not.toHaveBeenCalled();
  });

  it('ignores goal payloads without schema v1 or session id', () => {
    render(<ExtensionUiHost />);
    emit({
      workspace: '/ws',
      request: { id: 'g2', method: 'setStatus', statusKey: 'goal', statusText: JSON.stringify({ condition: '旧状态', paused: false, react: 0 }) },
    });
    emit({
      workspace: '/ws',
      request: { id: 'g3', method: 'setStatus', statusKey: 'goal', statusText: JSON.stringify({ schemaVersion: 2, sessionId: 'session-a', condition: '未来状态' }) },
    });
    expect(goalSetSnapshot).not.toHaveBeenCalled();
    expect(goalSetGoal).not.toHaveBeenCalled();
  });

  it('clears a schema v1 session projection when the payload has no snapshot', () => {
    render(<ExtensionUiHost />);
    emit({
      workspace: '/ws',
      request: {
        id: 'g4',
        method: 'setStatus',
        statusKey: 'goal',
        statusText: JSON.stringify({ schemaVersion: 1, sessionId: 'session-a', snapshot: null }),
      },
    });
    expect(goalSetSnapshot).toHaveBeenCalledWith('session-a', undefined);
  });

  it('routes goal://status payloads by schema version and session id', () => {
    render(<ExtensionUiHost />);
    const snapshot = {
      goalId: 'goal-channel',
      sessionId: 'session-channel',
      workspace: '/ws',
      revision: 3,
      condition: '渠道事件',
      status: 'paused',
      roundsUsed: 2,
      maxRounds: 8,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:01.000Z',
    };
    emitGoal({ schemaVersion: 1, workspace: '/ws', sessionId: 'session-channel', snapshot });
    emitGoal({ schemaVersion: 2, workspace: '/ws', sessionId: 'session-channel', snapshot });
    expect(goalSetSnapshot).toHaveBeenCalledWith('session-channel', expect.objectContaining(snapshot));
    expect(goalSetSnapshot).toHaveBeenCalledTimes(1);
  });

  it('ignores Goal worker UI requests', () => {
    render(<ExtensionUiHost />);
    emit({
      workspace: '/ws',
      source: 'goal',
      sessionId: 'session-worker',
      request: { id: 'g-worker', method: 'confirm', title: '不应显示' },
    });
    expect(setRequest).not.toHaveBeenCalled();
  });

  it('shows a toast for notify (default info level)', () => {
    render(<ExtensionUiHost />);
    emit({ workspace: '/ws', request: { id: 'n1', method: 'notify', message: '已设定目标：写完测试' } });
    expect(msg.info).toHaveBeenCalledWith('已设定目标：写完测试');
  });

  it('maps notify level to the matching toast', () => {
    render(<ExtensionUiHost />);
    emit({ workspace: '/ws', request: { id: 'n2', method: 'notify', message: '裁判不可用，已放行。', level: 'warning' } });
    expect(msg.warning).toHaveBeenCalledWith('裁判不可用，已放行。');
    expect(msg.info).not.toHaveBeenCalled();
  });
});
