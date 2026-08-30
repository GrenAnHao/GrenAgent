import { describe, expect, it } from 'vitest';
import {
  bumpSessionMutationEpoch,
  getSessionMutationEpoch,
  isFreshResponse,
} from './sessionCache';

describe('session mutation epoch', () => {
  it('bump increments and reads back', () => {
    const before = getSessionMutationEpoch();
    const after = bumpSessionMutationEpoch();
    expect(after).toBe(before + 1);
    expect(getSessionMutationEpoch()).toBe(after);
  });

  it('isFreshResponse true when no mutation since start', () => {
    const started = getSessionMutationEpoch();
    expect(isFreshResponse(started)).toBe(true);
  });

  it('isFreshResponse false after a mutation', () => {
    const started = getSessionMutationEpoch();
    bumpSessionMutationEpoch();
    expect(isFreshResponse(started)).toBe(false);
  });
});
