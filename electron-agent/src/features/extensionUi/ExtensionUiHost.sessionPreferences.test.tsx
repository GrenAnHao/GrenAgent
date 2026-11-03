// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';

const { uiHandlers } = vi.hoisted(() => ({
  uiHandlers: [] as Array<(e: unknown) => void>,
}));

vi.mock('../../lib/pi', () => ({
  onPiEvent: () => Promise.resolve(() => {}),
  onPiUiRequest: (handler: (e: unknown) => void) => {
    uiHandlers.push(handler);
    return Promise.resolve(() => {});
  },
}));
vi.mock('../../lib/pathUtils', async (importOriginal) => importOriginal<typeof import('../../lib/pathUtils')>());

import { ExtensionUiHost } from './ExtensionUiHost';
import { render } from '@testing-library/react';
import { useModeStore } from '../../stores/modeStore';
import { useApprovalStore } from '../../stores/approvalStore';
import { resetSessionPreferencesForTests, useSessionPreferencesStore } from '../../stores/sessionPreferencesStore';

const OWNER = '/ws/a.jsonl';

function prefs(patch: Record<string, unknown> = {}) {
  return {
    model: { provider: 'anthropic', id: 'm' },
    thinkingLevel: 'medium',
    mode: 'plan',
    approval: 'auto',
    revision: 3,
    ...patch,
  };
}

function pushStatus(request: Record<string, unknown>, sessionPath: string | null = OWNER) {
  act(() => {
    for (const handler of uiHandlers) {
      handler({
        workspace: '/ws',
        ...(sessionPath ? { sessionPath } : {}),
        request: { id: 'r1', method: 'setStatus', ...request },
      });
    }
  });
}

beforeEach(() => {
  resetSessionPreferencesForTests();
  useModeStore.setState({ byWorkspace: {}, bySession: {} });
  useApprovalStore.setState({ byWorkspace: {}, bySession: {} });
  uiHandlers.length = 0;
});

describe('ExtensionUiHost status projection into session preferences', () => {
  it('restores removed session and default mode statuses to Agent in their own scopes', () => {
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs({ mode: 'ask', fastMode: true }));
    render(<ExtensionUiHost />);
    pushStatus({ statusKey: 'agent-mode', statusText: 'brainstorm' });
    pushStatus({ statusKey: 'agent-mode-default', statusText: 'brainstorm' }, null);
    expect(useSessionPreferencesStore.getState().peek(OWNER)).toMatchObject({
      mode: 'agent', fastMode: true, thinkingLevel: 'medium', revision: 3,
    });
    expect(useModeStore.getState().bySession[OWNER]).toBe('agent');
    expect(useModeStore.getState().byWorkspace['/ws']).toBe('agent');
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toEqual({ mode: 'agent', revision: 0 });
  });

  it('projects a session agent-mode status to the session preference, only that field', () => {
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs());
    render(<ExtensionUiHost />);
    // Plan 确认 → Agent：扩展推 status，没有 preferences/revision。
    pushStatus({ statusKey: 'agent-mode', statusText: 'agent' });
    expect(useSessionPreferencesStore.getState().peek(OWNER)).toMatchObject({
      mode: 'agent',
      thinkingLevel: 'medium',
      approval: 'auto',
      model: { provider: 'anthropic', id: 'm' },
      revision: 3,
    });
    expect(useModeStore.getState().bySession[OWNER]).toBe('agent');
  });

  it('projects a session approval status to the session preference only', () => {
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs());
    render(<ExtensionUiHost />);
    pushStatus({ statusKey: 'approval-policy', statusText: 'workspace' });
    expect(useSessionPreferencesStore.getState().peek(OWNER)).toMatchObject({
      approval: 'workspace',
      mode: 'plan',
      revision: 3,
    });
  });

  it('does not clobber a newer in-flight user pick of the same field', () => {
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs());
    render(<ExtensionUiHost />);
    // 用户刚点了 ask（乐观写，回执还没回来），扩展的旧 status 不能把它改回 plan。
    useSessionPreferencesStore.getState().patchOptimistic(OWNER, 'mode', 'ask');
    pushStatus({ statusKey: 'agent-mode', statusText: 'plan' });
    expect(useSessionPreferencesStore.getState().peek(OWNER)?.mode).toBe('ask');
  });

  it('shows a status-only projection immediately but still allows the snapshot to load over it', async () => {
    render(<ExtensionUiHost />);
    // 控件还没读后端，扩展先推了 status：这一项要先显示出来（Plan 确认后不让 UI 卡在旧值）。
    pushStatus({ statusKey: 'agent-mode', statusText: 'agent' });
    expect(useSessionPreferencesStore.getState().peek(OWNER)?.mode).toBe('agent');
    expect(useSessionPreferencesStore.getState().get(OWNER)?.hydrated).toBe(false);
    // 后端快照仍要能加载并覆盖（status 不是权威）。
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs({ mode: 'plan' }));
    expect(useSessionPreferencesStore.getState().peek(OWNER)?.mode).toBe('plan');
    expect(useSessionPreferencesStore.getState().get(OWNER)?.hydrated).toBe(true);
  });

  it('applies a remote session-preferences snapshot for the session it names', () => {
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs({ thinkingLevel: 'medium', revision: 3 }));
    useSessionPreferencesStore.getState().applyServer('/ws/b.jsonl', prefs({ thinkingLevel: 'low', revision: 1 }));
    render(<ExtensionUiHost />);
    // 另一个窗口把 A 改成 high/rev4，后端广播整份快照。
    pushStatus({
      statusKey: 'session-preferences',
      statusText: JSON.stringify(prefs({ thinkingLevel: 'high', revision: 4 })),
    });
    expect(useSessionPreferencesStore.getState().peek(OWNER)).toMatchObject({ thinkingLevel: 'high', revision: 4 });
    // B 不受影响。
    expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')).toMatchObject({ thinkingLevel: 'low' });
  });

  it('ignores a remote snapshot older than the local one and keeps pending local picks', () => {
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs({ thinkingLevel: 'medium', revision: 5 }));
    render(<ExtensionUiHost />);
    pushStatus({
      statusKey: 'session-preferences',
      statusText: JSON.stringify(prefs({ thinkingLevel: 'off', revision: 4 })),
    });
    expect(useSessionPreferencesStore.getState().peek(OWNER)).toMatchObject({ thinkingLevel: 'medium', revision: 5 });

    // 本地刚点了 low，回执未回：远端 rev6 不能把这一字段盖回去。
    useSessionPreferencesStore.getState().patchOptimistic(OWNER, 'thinkingLevel', 'low');
    pushStatus({
      statusKey: 'session-preferences',
      statusText: JSON.stringify(prefs({ thinkingLevel: 'high', mode: 'plan', revision: 6 })),
    });
    expect(useSessionPreferencesStore.getState().peek(OWNER)).toMatchObject({
      thinkingLevel: 'low',
      mode: 'plan',
      revision: 6,
    });
  });

  it('routes defaults status to project defaults, never to a session', () => {
    useSessionPreferencesStore.getState().applyServer(OWNER, prefs());
    render(<ExtensionUiHost />);
    pushStatus({ statusKey: 'agent-mode-default', statusText: 'ask' }, null);
    pushStatus({ statusKey: 'approval-policy-default', statusText: 'readonly' }, null);
    expect(useSessionPreferencesStore.getState().peek(OWNER)?.mode).toBe('plan');
    expect(useSessionPreferencesStore.getState().peek(OWNER)?.approval).toBe('auto');
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toMatchObject({
      mode: 'ask',
      approval: 'readonly',
    });
  });
});
