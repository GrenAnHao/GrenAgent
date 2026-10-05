// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { setStatus, goalSetGoal, goalSetSnapshot, setServers, msg, setRequest, setWaitingUiPrompt } = vi.hoisted(() => ({
  setStatus: vi.fn(),
  goalSetGoal: vi.fn(),
  goalSetSnapshot: vi.fn(),
  setServers: vi.fn(),
  msg: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  setRequest: vi.fn(),
  setWaitingUiPrompt: vi.fn(),
}));
let emit: (e: unknown) => void = () => {};
let loadedPath: string | null | undefined;
vi.mock('../../lib/pi', () => ({
  onPiUiRequest: (h: (e: unknown) => void) => {
    emit = h;
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
vi.mock('../../stores/agentStoreRegistry', () => ({
  agentStoreRegistry: {
    get: (workspace: string) =>
      workspace === '/ws'
        ? {
            useStore: { setState: setWaitingUiPrompt },
            getLoadedSessionPath: () => loadedPath,
            hasLiveActivity: () => false,
          }
        : undefined,
  },
}));

import { ExtensionUiHost } from './ExtensionUiHost';
import { useImMessagesStore } from '../../stores/imMessagesStore';
import { clearStashedUiRequestsForTest, hasStashedUiRequests } from '../../stores/backgroundUiRequests';

afterEach(() => {
  cleanup();
  setStatus.mockClear();
  goalSetGoal.mockClear();
  goalSetSnapshot.mockClear();
  setServers.mockClear();
  setRequest.mockClear();
  setWaitingUiPrompt.mockClear();
  emit = () => {};
  msg.info.mockClear();
  msg.warning.mockClear();
  useImMessagesStore.getState().setConversations([]);
  loadedPath = undefined;
  clearStashedUiRequestsForTest();
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

  it('routes setStatus(ui-prompt) to the agent store waiting state', () => {
    render(<ExtensionUiHost />);
    emit({
      workspace: '/ws',
      request: {
        id: 's2',
        method: 'setStatus',
        statusKey: 'ui-prompt',
        statusText: JSON.stringify({ kind: 'select', title: '请求批准' }),
      },
    });
    expect(setWaitingUiPrompt).toHaveBeenCalledWith({
      waitingUiPrompt: { kind: 'select', title: '请求批准' },
    });
  });

  it('clears waitingUiPrompt when ui-prompt status is empty', () => {
    render(<ExtensionUiHost />);
    emit({ workspace: '/ws', request: { id: 's3', method: 'setStatus', statusKey: 'ui-prompt' } });
    expect(setWaitingUiPrompt).toHaveBeenCalledWith({ waitingUiPrompt: undefined });
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

  it('routes a schema v1 nested snapshot with activation and roundsStarted', () => {
    render(<ExtensionUiHost />);
    const snapshot = {
      goalId: 'goal-a',
      revision: 2,
      condition: '写完测试',
      status: 'active',
      roundsStarted: 1,
      maxRounds: 256,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:01.000Z',
      activation: 'armed',
      blockedReason: { code: 'model-reported', message: '缺密钥' },
    };
    emit({
      workspace: '/ws',
      request: {
        id: 'g1',
        method: 'setStatus',
        statusKey: 'goal',
        statusText: JSON.stringify({
          schemaVersion: 1,
          sessionId: 'session-a',
          workspace: '/ws',
          snapshot,
          history: [],
        }),
      },
    });
    expect(goalSetSnapshot).toHaveBeenCalledWith('session-a', expect.objectContaining({
      ...snapshot,
      sessionId: 'session-a',
      history: [],
    }));
    expect(goalSetGoal).not.toHaveBeenCalled();
  });

  it('defaults missing activation to disarmed', () => {
    render(<ExtensionUiHost />);
    emit({
      workspace: '/ws',
      request: {
        id: 'g1b',
        method: 'setStatus',
        statusKey: 'goal',
        statusText: JSON.stringify({
          schemaVersion: 1,
          sessionId: 'session-a',
          snapshot: {
            goalId: 'goal-a',
            revision: 1,
            condition: '写完测试',
            status: 'active',
            roundsStarted: 0,
            maxRounds: 256,
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:01.000Z',
          },
          history: [],
        }),
      },
    });
    expect(goalSetSnapshot).toHaveBeenCalledWith('session-a', expect.objectContaining({
      sessionId: 'session-a',
      activation: 'disarmed',
      roundsStarted: 0,
    }));
  });

  it('ignores legacy { condition, paused, react } and non-v1 envelopes', () => {
    render(<ExtensionUiHost />);
    emit({
      workspace: '/ws',
      request: { id: 'g2', method: 'setStatus', statusKey: 'goal', statusText: JSON.stringify({ condition: '旧状态', paused: false, react: 0 }) },
    });
    emit({
      workspace: '/ws',
      request: { id: 'g3', method: 'setStatus', statusKey: 'goal', statusText: JSON.stringify({ schemaVersion: 2, sessionId: 'session-a', condition: '未来状态' }) },
    });
    emit({
      workspace: '/ws',
      request: {
        id: 'g3b',
        method: 'setStatus',
        statusKey: 'goal',
        statusText: JSON.stringify({
          schemaVersion: 1,
          sessionId: 'session-a',
          goalId: 'goal-flat',
          revision: 1,
          condition: '扁平旧测',
          status: 'active',
          roundsStarted: 1,
          maxRounds: 256,
        }),
      },
    });
    expect(goalSetSnapshot).not.toHaveBeenCalled();
    expect(goalSetGoal).not.toHaveBeenCalled();
  });

  it('ignores status judging', () => {
    render(<ExtensionUiHost />);
    emit({
      workspace: '/ws',
      request: {
        id: 'g-judging',
        method: 'setStatus',
        statusKey: 'goal',
        statusText: JSON.stringify({
          schemaVersion: 1,
          sessionId: 'session-a',
          snapshot: {
            goalId: 'goal-a',
            revision: 1,
            condition: '写完测试',
            status: 'judging',
            roundsStarted: 1,
            maxRounds: 256,
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:01.000Z',
            activation: 'armed',
          },
          history: [],
        }),
      },
    });
    expect(goalSetSnapshot).not.toHaveBeenCalled();
  });

  it('clears a schema v1 session projection when snapshot is null', () => {
    render(<ExtensionUiHost />);
    emit({
      workspace: '/ws',
      request: {
        id: 'g4',
        method: 'setStatus',
        statusKey: 'goal',
        statusText: JSON.stringify({ schemaVersion: 1, sessionId: 'session-a', snapshot: null, history: [] }),
      },
    });
    expect(goalSetSnapshot).toHaveBeenCalledWith('session-a', undefined);
  });

  it('copies envelope history onto the snapshot as-is', () => {
    render(<ExtensionUiHost />);
    const history = [
      { source: 'event', kind: 'create', goalId: 'goal-a', revision: 1, at: '2026-09-01T00:00:00.000Z', payload: { condition: '写完测试' } },
      { source: 'round', goalId: 'goal-a', revision: 1, round: 1, content: '续跑' },
    ];
    emit({
      workspace: '/ws',
      request: {
        id: 'g-hist',
        method: 'setStatus',
        statusKey: 'goal',
        statusText: JSON.stringify({
          schemaVersion: 1,
          sessionId: 'session-a',
          snapshot: {
            goalId: 'goal-a',
            revision: 1,
            condition: '写完测试',
            status: 'paused',
            roundsStarted: 2,
            maxRounds: 8,
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:01.000Z',
            activation: 'disarmed',
          },
          history,
        }),
      },
    });
    expect(goalSetSnapshot).toHaveBeenCalledWith('session-a', expect.objectContaining({ history }));
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

  it('does not toast Goal receipts; bar already shows the same status', () => {
    render(<ExtensionUiHost />);
    emit({
      workspace: '/ws',
      request: { id: 'n-goal', method: 'notify', message: '已暂停的目标 · 测试子代理理 · 0/256 · disarmed' },
    });
    emit({
      workspace: '/ws',
      request: { id: 'n-clear', method: 'notify', message: '已清除目标。' },
    });
    expect(msg.info).not.toHaveBeenCalled();
  });

  it('maps notify level to the matching toast', () => {
    render(<ExtensionUiHost />);
    emit({ workspace: '/ws', request: { id: 'n2', method: 'notify', message: '裁判不可用，已放行。', level: 'warning' } });
    expect(msg.warning).toHaveBeenCalledWith('裁判不可用，已放行。');
    expect(msg.info).not.toHaveBeenCalled();
  });

  it('同项目另一个会话的交互请求按会话暂存，不显示在当前会话上', () => {
    loadedPath = '/ws/a.jsonl';
    render(<ExtensionUiHost />);
    const request = { id: 'bg1', method: 'confirm', title: '后台会话要确认' };
    emit({ workspace: '/ws', sessionPath: '/ws/b.jsonl', request });
    expect(setRequest).not.toHaveBeenCalled();
    expect(hasStashedUiRequests('/ws/b.jsonl')).toBe(true);
    // 后台会话的 ui-prompt 状态也不写进当前画面。
    emit({ workspace: '/ws', sessionPath: '/ws/b.jsonl', request: { id: 's9', method: 'setStatus', statusKey: 'ui-prompt', statusText: 'x' } });
    expect(setWaitingUiPrompt).not.toHaveBeenCalled();
  });

  it('当前会话自己的交互请求照常显示', () => {
    loadedPath = '/ws/a.jsonl';
    render(<ExtensionUiHost />);
    const request = { id: 'fg1', method: 'confirm', title: '当前会话要确认' };
    emit({ workspace: '/ws', sessionPath: '/ws/a.jsonl', request });
    expect(setRequest).toHaveBeenCalledWith({ workspace: '/ws', request, sessionPath: '/ws/a.jsonl' });
  });
});
