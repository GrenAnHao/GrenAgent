import { agentModeConfigKey, approvalPolicyConfigKey } from './settingsService';
import { isAgentMode } from '../../../extensions/agent-mode/modes.js';
import { parseApproval, type ApprovalPolicy } from '../../../extensions/_shared/approval.js';
import type { SessionPreferences } from '../../../extensions/_shared/session-preferences.js';

/** Rebind execution controls only from a destination's explicit local policy. */
export function transferredSessionPreferences(
  source: SessionPreferences,
  targetWorkspace: string,
  config: Readonly<Record<string, string>>,
): SessionPreferences {
  const targetApproval = parseApproval(config[approvalPolicyConfigKey(targetWorkspace)]);
  const targetMode = config[agentModeConfigKey(targetWorkspace)];
  const approval = intersectApproval(source.approval ?? 'readonly', targetApproval ?? 'readonly');
  const canExecute = targetApproval !== undefined && isAgentMode(targetMode) && targetMode !== 'ask';
  const mode = source.mode === 'ask' || !canExecute || approval === 'readonly' ? 'ask' : source.mode ?? 'ask';
  return { ...source, mode, approval, revision: source.revision + 1 };
}

function intersectApproval(source: ApprovalPolicy, target: ApprovalPolicy): ApprovalPolicy {
  if (source === target) return source;
  if (source === 'readonly' || target === 'readonly') return 'readonly';
  if (source === 'full') return target;
  if (target === 'full') return source;
  // 'auto' and 'workspace' are different capabilities, not a total ordering.
  // Explicit approval is the safe common policy; never guess which is broader.
  return 'ask';
}
