// bash 的同调用升权，照 DSH packages/sandbox/sandbox/src/escalation.ts：sandbox_permissions + justification 成对出现，
// 执行前裁决完（严格更宽、审批档、审批通道、用户批准），批准的模式只给这一次调用。
// 不要求「先被拒才能申请」：每次升权都要用户批准。给模型的标记原文在 _shared/sandbox/facts.ts。
import { isStrictWidening } from "../_shared/sandbox/escalate.js";
import { ESCALATION_TARGETS, type EscalationTarget } from "../_shared/sandbox/facts.js";
import type { FileSandboxMode } from "../_shared/sandbox/types.js";

export const SANDBOX_PERMISSIONS_DESCRIPTION =
  "The narrowest wider sandbox mode for a one-shot retry of the exact command the sandbox just denied; the retry asks the user for approval.";
export const JUSTIFICATION_DESCRIPTION =
  "Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access. Use the language of the user's current request.";
export const ESCALATION_GUIDELINE =
  "Use bash with sandbox_permissions + justification only to retry the exact command the sandbox just denied, choosing the narrowest wider mode; the user approves every retry, and a rejection means stop and explain.";

export const ESCALATION_ALLOW = "允许本次";
export const ESCALATION_REJECT = "拒绝";

export interface EscalationRequest {
  mode: EscalationTarget;
  justification: string;
}

/** DSH validateEscalationArgs：成对出现、理由非空、模式在闭集里。两个都没给返回 undefined。 */
export function readEscalationArgs(params: {
  sandbox_permissions?: unknown;
  justification?: unknown;
}): EscalationRequest | undefined {
  const { sandbox_permissions: mode, justification } = params;
  if (mode !== undefined && justification === undefined) {
    throw new Error("invalid escalation: sandbox_permissions requires a justification");
  }
  if (justification !== undefined && mode === undefined) {
    throw new Error("invalid escalation: justification is only valid together with sandbox_permissions");
  }
  if (mode === undefined) return undefined;
  if (typeof justification !== "string" || justification.trim().length === 0) {
    throw new Error("invalid justification: expected a non-empty sentence");
  }
  if (!(ESCALATION_TARGETS as readonly unknown[]).includes(mode)) {
    throw new Error(`invalid escalation: sandbox_permissions must be one of ${ESCALATION_TARGETS.join(", ")}`);
  }
  return { mode: mode as EscalationTarget, justification: justification.trim() };
}

/** 一次调用起步的沙箱事实：审批档 + agent 模式解析出来的模式，以及审批档是否拒绝从它升权。 */
export interface SandboxGate {
  mode: FileSandboxMode;
  /** 沿用 bash_escalate 的规则：「工作区编辑」档下的 workspace-write 拒绝升权。 */
  presetBlocksEscalation: boolean;
}

/** 被拒后要不要提示模型可以升权：还有更宽的模式、审批档不拒绝、这次调用有审批通道。 */
export function canOfferEscalation(gate: SandboxGate, effectiveMode: FileSandboxMode, approvalChannel: boolean): boolean {
  return approvalChannel && !gate.presetBlocksEscalation && effectiveMode !== "danger-full-access";
}

export interface EscalationApproval {
  /** 能弹审批：有界面的主会话回合，或能经父会话问人的子代理（approval-route.ts）。goal 回合没有人能批。 */
  channel: boolean;
  select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
  /** safety 已经为这次调用问过并允许（一次性许可），不再问第二次。 */
  preApproved: boolean;
  signal?: AbortSignal;
}

/**
 * DSH approveEscalation：执行前把升权请求裁决完。返回这次调用要用的单次模式；
 * 申请的就是当前模式时返回 undefined（不算升权，照常执行）。不过就抛错，pi 把它变成 isError 结果，命令不执行。
 */
export async function approveEscalation(
  command: string,
  request: EscalationRequest,
  gate: SandboxGate | undefined,
  approval: EscalationApproval,
): Promise<EscalationTarget | undefined> {
  const { mode, justification } = request;
  if (!gate) throw new Error(`sandbox escalation to "${mode}" is not available: this bash runs without a sandbox policy`);
  if (mode === gate.mode) return undefined;
  if (!isStrictWidening(gate.mode, mode)) {
    throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${gate.mode}" mode`);
  }
  if (gate.presetBlocksEscalation) {
    throw new Error(
      `sandbox escalation to "${mode}" is rejected: the workspace-edit approval preset keeps commands inside the workspace`,
    );
  }
  if (approval.preApproved) return mode;
  if (!approval.channel || !approval.select) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`);
  }
  let choice: string | undefined;
  try {
    choice = await approval.select(
      `沙箱升权\n\n${command}\n\n${justification}\n\n→ ${mode}`,
      [ESCALATION_ALLOW, ESCALATION_REJECT],
      approval.signal ? { signal: approval.signal } : undefined,
    );
  } catch {
    choice = undefined;
  }
  if (choice === ESCALATION_ALLOW) return mode;
  if (choice === ESCALATION_REJECT) {
    throw new Error(
      `the user rejected escalating this command to "${mode}"; it stays denied, so stop and explain instead of working around it`,
    );
  }
  throw new Error(`approval for escalating to "${mode}" was cancelled`);
}
