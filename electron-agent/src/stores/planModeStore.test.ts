import { beforeEach, describe, expect, it } from 'vitest';
import { usePlanModeStore } from './planModeStore';

beforeEach(() => usePlanModeStore.setState({ status: undefined }));

describe('planModeStore', () => {
  it('sets and clears status', () => {
    usePlanModeStore.getState().setStatus('📋 Plan');
    expect(usePlanModeStore.getState().status).toBe('📋 Plan');
    usePlanModeStore.getState().setStatus(undefined);
    expect(usePlanModeStore.getState().status).toBeUndefined();
  });
});
