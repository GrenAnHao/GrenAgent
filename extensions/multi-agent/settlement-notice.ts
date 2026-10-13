import type { SubagentStopReason } from "./assistant-output.js";

export interface SettlementNoticeInput {
  childId: string;
  stopReason: SubagentStopReason;
  output: string;
  sessionPath?: string;
  /** 后端不支持续聊（worker 后台运行）时为 false：不能再提示「发消息给它还能接着做」。默认 true。 */
  continuable?: boolean;
  /** 非 completed 时的失败说明，单独成行，不混进 closing message。 */
  diagnostic?: string;
}

export interface SettlementNotice {
  childId: string;
  stopReason: SubagentStopReason;
  sessionPath?: string;
  summary: string;
  content: string;
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
  const summary = summaryOf(input.childId, input.stopReason, input.continuable !== false);
  const body = input.output.trim()
    ? `Its closing message:\n${input.output}`
    : "It left no closing message.";
  const diagnostic = input.stopReason !== "completed" && input.diagnostic?.trim()
    ? `\nDiagnostic: ${input.diagnostic.trim()}`
    : "";
  return {
    childId: input.childId,
    stopReason: input.stopReason,
    sessionPath: input.sessionPath,
    summary,
    content: `${summary}\n${body}${diagnostic}`,
  };
}
