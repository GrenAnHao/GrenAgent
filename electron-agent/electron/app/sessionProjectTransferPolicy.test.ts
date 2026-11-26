import { describe, expect, it } from 'vitest';
import { transferredSessionPreferences } from './sessionProjectTransferPolicy';
import { agentModeConfigKey, approvalPolicyConfigKey } from './settingsService';
import type { SessionPreferences } from '../../../extensions/_shared/session-preferences.js';

const workspace = 'D:/target';
const source: SessionPreferences = { revision: 4, model: { provider: 'fixture', id: 'missing-model' }, thinkingLevel: 'high', fastMode: false, mode: 'ultra', approval: 'full' };
const policy = (mode: string, approval: string) => ({ [agentModeConfigKey(workspace)]: mode, [approvalPolicyConfigKey(workspace)]: approval });

describe('session project transfer local policy', () => {
  it('preserves requested model/thinking/false Fast without granting an unconfigured destination source permissions', () => {
    expect(transferredSessionPreferences(source, workspace, {})).toEqual({ ...source, revision: 5, mode: 'ask', approval: 'readonly' });
    expect(source.revision).toBe(4);
  });
  it('uses only an explicit destination grant bounded by the source preference', () => {
    expect(transferredSessionPreferences(source, workspace, policy('agent', 'workspace'))).toMatchObject({ mode: 'ultra', approval: 'workspace' });
    expect(transferredSessionPreferences({ ...source, approval: 'readonly' }, workspace, policy('agent', 'full'))).toMatchObject({ mode: 'ask', approval: 'readonly' });
    expect(transferredSessionPreferences({ ...source, mode: 'ask', approval: 'ask' }, workspace, policy('agent', 'full'))).toMatchObject({ mode: 'ask', approval: 'ask' });
  });
  it('does not assume auto approval and workspace editing are totally ordered', () => {
    expect(transferredSessionPreferences({ ...source, approval: 'auto' }, workspace, policy('agent', 'workspace')).approval).toBe('ask');
    expect(transferredSessionPreferences(source, workspace, policy('ask', 'full')).mode).toBe('ask');
    expect(transferredSessionPreferences(source, workspace, policy('agent', 'invalid')).approval).toBe('readonly');
  });
});
