import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_MODES, MODE_LABELS, isAgentMode, sessionControlKey, useModeStore } from './modeStore';

beforeEach(() => {
  useModeStore.setState({ byWorkspace: {}, bySession: {} });
});

describe('ultra mode in the renderer mode store', () => {
  it('is a selectable mode with a label, next to the other executing modes', () => {
    expect(AGENT_MODES).toContain('ultra');
    expect(isAgentMode('ultra')).toBe(true);
    expect(MODE_LABELS.ultra).toBe('Ultra');
    // 与其它模式并列，不是额外开关
    expect(AGENT_MODES).toEqual(['agent', 'ask', 'debug', 'plan', 'ultra']);
  });

  it('rejects the removed brainstorm mode', () => {
    expect(isAgentMode('brainstorm')).toBe(false);
  });

  it('stays mutually exclusive: selecting ask replaces ultra for that session only', () => {
    const store = useModeStore.getState();
    store.setSessionMode('/repo/.pi/sessions/a.jsonl', 'ultra');
    store.setMode('/repo', 'ultra');
    expect(useModeStore.getState().bySession[sessionControlKey('/repo/.pi/sessions/a.jsonl')]).toBe('ultra');
    expect(useModeStore.getState().byWorkspace['/repo']).toBe('ultra');

    store.setSessionMode('/repo/.pi/sessions/a.jsonl', 'ask');
    expect(useModeStore.getState().bySession[sessionControlKey('/repo/.pi/sessions/a.jsonl')]).toBe('ask');
    // 另一个会话不受影响
    store.setSessionMode('/repo/.pi/sessions/b.jsonl', 'plan');
    expect(useModeStore.getState().bySession[sessionControlKey('/repo/.pi/sessions/b.jsonl')]).toBe('plan');
  });

  it('restores a persisted ultra value instead of falling back to agent', () => {
    useModeStore.getState().setMode('/repo', 'ultra');
    expect(useModeStore.getState().byWorkspace['/repo']).toBe('ultra');
  });
});
