import { describe, expect, it } from 'vitest';
import { beginCompactionIntent, finishCompactionActivity, forgetCompactionActivity, getCompactionActivity, getCompactionContextRevision, observeCompactionEvent, subscribeCompactionActivity } from './compaction-activity.js';

const identity = { sessionId: 'compaction-test', sessionPath: '/tmp/compaction-test.jsonl' };

describe('compaction activity', () => {
  it('registers preparing before SDK abort and only advances context revision after successful SDK end', () => {
    const observed: Array<string | undefined> = [];
    const off = subscribeCompactionActivity(identity.sessionId, activity => observed.push(activity?.phase));
    const intent = beginCompactionIntent(identity, 'policy-auto');
    expect(getCompactionActivity(identity.sessionId)).toMatchObject({ phase: 'preparing', operationId: intent.operationId });
    observeCompactionEvent(identity, { type: 'compaction_start', reason: 'manual' });
    expect(getCompactionActivity(identity.sessionId)).toMatchObject({ phase: 'running', origin: 'policy-auto' });
    const before = getCompactionContextRevision(identity.sessionId);
    observeCompactionEvent(identity, { type: 'compaction_end', reason: 'manual', aborted: false });
    expect(getCompactionContextRevision(identity.sessionId)).toBe(before + 1);
    expect(getCompactionActivity(identity.sessionId)).toBeUndefined();
    expect(observed).toEqual(['preparing', 'running', undefined]);
    off();
  });

  it('a stale callback cannot close a newer operation, failed compaction does not claim a finalized context', () => {
    const first = beginCompactionIntent(identity, 'user-manual');
    observeCompactionEvent(identity, { type: 'compaction_end', errorMessage: 'failed' });
    const second = beginCompactionIntent(identity, 'sdk-threshold');
    const before = getCompactionContextRevision(identity.sessionId);
    finishCompactionActivity(identity.sessionId, first.operationId, true);
    expect(getCompactionActivity(identity.sessionId)?.operationId).toBe(second.operationId);
    expect(getCompactionContextRevision(identity.sessionId)).toBe(before);
    forgetCompactionActivity(identity.sessionId);
    expect(getCompactionActivity(identity.sessionId)).toBeUndefined();
  });
});
