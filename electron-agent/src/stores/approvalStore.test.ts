import { beforeEach, describe, expect, it } from 'vitest';
import { isApprovalPolicy, useApprovalStore } from './approvalStore';

beforeEach(() => useApprovalStore.setState({ byWorkspace: {} }));

describe('approvalStore', () => {
  it('sets and reads per workspace', () => {
    useApprovalStore.getState().setLevel('/a', 'ask');
    useApprovalStore.getState().setLevel('/b', 'full');
    expect(useApprovalStore.getState().byWorkspace['/a']).toBe('ask');
    expect(useApprovalStore.getState().byWorkspace['/b']).toBe('full');
  });
  it('isApprovalPolicy guards values', () => {
    expect(isApprovalPolicy('auto')).toBe(true);
    expect(isApprovalPolicy('nope')).toBe(false);
  });
});
