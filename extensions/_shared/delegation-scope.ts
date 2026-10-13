// 子级委派范围声明与拒绝文案。主进程（toolDecisionService）与 sidecar（safety / multi-agent）共用，
// 确保 ruleId 与措辞不在两处各维护一份。父会话能替子代理问人时，声明换成 delegationScopeWithApprovals。

export const SUBAGENT_ASK_PINNED_RULE_ID = "builtin.subagent-ask-pinned";

export const DELEGATION_SCOPE_STATEMENT =
  "你是被委派的子代理：权限范围在启动时已固定，无法在本会话内扩大——需要审批的操作会被自动拒绝。" +
  "任务需要超出范围的访问时，不要重试被拒绝的操作；在回复中说明限制，让委派方处理。";

/** 父会话能替子代理问人时（_shared/approval-route.ts）用这一版：审批转给用户，限时等待。 */
export function delegationScopeWithApprovals(timeoutSeconds: number): string {
  return (
    "你是被委派的子代理：权限范围在启动时已固定，无法在本会话内扩大。" +
    `需要审批的操作会转给用户批准，最多等 ${timeoutSeconds} 秒；被拒绝或超时就不要重试，` +
    "在回复中说明限制，让委派方处理。"
  );
}

export const DELEGATION_DENY_REASON =
  "子代理的权限范围在启动时已固定，此操作需要审批，已被自动拒绝。不要重试；在回复中说明这一限制，交由委派方处理。";

/** named agent 提示在前、声明在后；空提示只留声明；已含声明不重复。 */
export function withDelegationScope(
  systemPrompt: string | undefined,
  statement: string = DELEGATION_SCOPE_STATEMENT,
): string {
  const head = systemPrompt?.trim() ?? "";
  if (!head) return statement;
  if (head.endsWith(statement)) return head;
  return `${head}\n\n${statement}`;
}
