// 沙箱事实的词表，照 DSH packages/sandbox/sandbox/src/escalation.ts：拒绝标记、升权提示、runner 失败标记。
// 纯模块（只有类型导入）：bash 工具、user_bash 适配器、job 结算 detail 都从这里取原文；
// 渲染层用 parseSandboxNote 认后台任务 detail 里的说明。格式和解析放在一起，不会各写一份。
import type { FileSandboxMode, SandboxRunFacts } from "./types.js";

/** 能升权到的模式闭集（read-only 是底，没有谁升到它）。 */
export const ESCALATION_TARGETS = ["workspace-write", "danger-full-access"] as const;
export type EscalationTarget = (typeof ESCALATION_TARGETS)[number];

export function sandboxDenialMarker(mode: FileSandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`;
}

/** 跟在拒绝后面的同回合提示：重试的办法放在决策点，不靠模型记得工具说明。 */
export function escalationHintMarker(): string {
  return "[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]";
}

export function runnerFailedMarker(mode: FileSandboxMode): string {
  return `[sandbox: the sandbox runner failed under ${mode} mode — the command did not run; this is a sandbox problem, not a command failure]`;
}

/**
 * 给模型的沙箱说明，按顺序：runner 失败（标记 + 原因），或拒绝（标记 + 可升权时的提示）。
 * 前台逐行接在输出后面，后台用空格并进 job 结算 detail。
 */
export function sandboxNotes(facts: SandboxRunFacts, offerEscalation: boolean): string[] {
  if (facts.runnerFailed) return [runnerFailedMarker(facts.mode), ...(facts.detail ? [facts.detail] : [])];
  if (facts.denied) return [sandboxDenialMarker(facts.mode), ...(offerEscalation ? [escalationHintMarker()] : [])];
  return [];
}

export interface SandboxNote {
  kind: "denied" | "runner-failed";
  mode: FileSandboxMode;
}

const MODE = "(read-only|workspace-write|danger-full-access)";
const RUNNER_FAILED_RE = new RegExp(`\\[sandbox: the sandbox runner failed under ${MODE} mode`);
const DENIED_RE = new RegExp(`\\[sandbox: file access denied under ${MODE} mode\\]`);

/** 从 processOutcome 写的 job detail 里认出沙箱说明。只认上面两个函数写出的标记，不看命令输出。 */
export function parseSandboxNote(text: string | undefined): SandboxNote | undefined {
  if (!text) return undefined;
  const runner = RUNNER_FAILED_RE.exec(text);
  if (runner) return { kind: "runner-failed", mode: runner[1] as FileSandboxMode };
  const denied = DENIED_RE.exec(text);
  if (denied) return { kind: "denied", mode: denied[1] as FileSandboxMode };
  return undefined;
}
