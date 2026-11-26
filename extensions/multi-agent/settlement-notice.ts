import type { SubagentStopReason } from "./assistant-output.js";
import type { BackgroundBashTimeout } from "./background-bash.js";

export interface SettlementNoticeInput {
  childId: string;
  stopReason: SubagentStopReason;
  output: string;
  sessionPath?: string;
  /** 后端不支持续聊（worker 后台运行）时为 false：不能再提示「发消息给它还能接着做」。默认 true。 */
  continuable?: boolean;
  /** 非 completed 时的失败说明，单独成行，不混进 closing message。 */
  diagnostic?: string;
  bashTimeout?: BackgroundBashTimeout;
}

export interface SettlementNotice {
  childId: string;
  stopReason: SubagentStopReason;
  sessionPath?: string;
  summary: string;
  content: string;
  bashTimeout?: BackgroundBashTimeout;
  /** Structured reply, including markdown whose fences need not be balanced. */
  reply?: string;
}

function summaryOf(childId: string, stopReason: SubagentStopReason, continuable: boolean): string {
  const subject = `Background subagent ${childId}`;
  if (stopReason === "completed") {
    return continuable
      ? `${subject} finished and will do no further work unless you send it more.`
      : `${subject} finished. It cannot receive further messages.`;
  }
  if (stopReason === "aborted") return `${subject} was stopped before it finished.`;
  return `${subject} failed before it finished.`;
}

export function formatSettlementNotice(input: SettlementNoticeInput): SettlementNotice {
  const summary = input.bashTimeout
    ? `Background subagent ${input.childId} finished its reply, but a background command timed out.`
    : summaryOf(input.childId, input.stopReason, input.continuable !== false);
  const body = input.output.trim()
    ? `Its closing message:\n${input.output}`
    : "It left no closing message.";
  const timeoutDetails = input.bashTimeout?.jobs.map(({ id, label, stopConfirmed }) =>
    `${id} ${label.replace(/\s+/g, " ")} (${stopConfirmed ? "exit confirmed" : "stop unconfirmed"})`).join("; ");
  const diagnostic = timeoutDetails ? `\nDiagnostic: background command timeout: ${timeoutDetails}`
    : input.stopReason !== "completed" && input.diagnostic?.trim()
    ? `\nDiagnostic: ${input.diagnostic.trim()}`
    : "";
  return {
    childId: input.childId,
    stopReason: input.stopReason,
    sessionPath: input.sessionPath,
    summary,
    ...(input.bashTimeout ? { bashTimeout: input.bashTimeout, reply: input.output } : {}),
    content: `${summary}\n${body}${diagnostic}`,
  };
}
