import { describe, expect, it } from 'vitest';
import { sessionTransferBusyReason, type TransferActivityFacts } from './sessionProjectTransferActivity';
import { setActivation } from '../../../extensions/goal/status.js';

const idle = (): TransferActivityFacts => ({
  sessionId: 'transfer-activity', entries: [], session: { isIdle: true, isStreaming: false, pendingMessageCount: 0 },
  hasPendingUi: () => false, activeTurn: false, queuedTurns: 0, preferenceWritePending: false,
  structuralOperationPending: false, hasLiveJobs: false,
});

describe('session project transfer activity', () => {
  it('allows a known idle owner and detached persisted history', () => {
    expect(sessionTransferBusyReason(idle())).toBeUndefined();
    expect(sessionTransferBusyReason({ ...idle(), session: undefined, hasPendingUi: undefined })).toBeUndefined();
  });
  it.each([
    { hasLiveJobs: true }, { hasLiveJobs: undefined }, { activeTurn: true }, { queuedTurns: 1 },
    { preferenceWritePending: true }, { structuralOperationPending: true }, { hasPendingUi: undefined },
    { hasPendingUi: () => true }, { session: { isIdle: false } },
    { session: { isIdle: true, isStreaming: true } }, { session: { isIdle: true, isCompacting: true } },
    { session: { isIdle: true, pendingMessageCount: 1 } },
    { session: { isIdle: true, cacheWarmingStatus: { state: 'refreshing' } } },
  ])('rejects actual or unknown work without cancelling it: %j', (patch) => {
    expect(sessionTransferBusyReason({ ...idle(), ...patch })).toBeTypeOf('string');
  });
  it('requires a persisted pause so target autoContinueOnOpen cannot rearm a disarmed active Goal', () => {
    const facts = { ...idle(), entries: [{ type: 'custom', customType: 'goal', data: {
      kind: 'create', goalId: 'transfer-goal', revision: 1, at: '2026-11-17T00:00:00Z', payload: { condition: 'fixture only' },
    } }] };
    setActivation(facts.sessionId, 'armed');
    try { expect(sessionTransferBusyReason(facts)).toContain('目标'); }
    finally { setActivation(facts.sessionId, 'disarmed'); }
    expect(sessionTransferBusyReason(facts)).toContain('目标');
    facts.entries.push({ type: 'custom', customType: 'goal', data: {
      kind: 'pause', goalId: 'transfer-goal', revision: 1, at: '2026-11-17T00:01:00Z', payload: { condition: 'fixture only' },
    } });
    expect(sessionTransferBusyReason(facts)).toBeUndefined();
  });
  it('rejects a persisted executing plan, but accepts a later completed plan', () => {
    const entries = [{ type: 'custom', customType: 'agent-mode', data: { plan: { status: 'executing' } } }];
    expect(sessionTransferBusyReason({ ...idle(), entries })).toContain('计划');
    entries.push({ type: 'custom', customType: 'agent-mode', data: { plan: { status: 'done' } } });
    expect(sessionTransferBusyReason({ ...idle(), entries })).toBeUndefined();
  });
});
