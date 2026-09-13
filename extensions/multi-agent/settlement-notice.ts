import type { SubagentStopReason } from "./assistant-output.js";

export interface SettlementNoticeInput {
  childId: string;
  stopReason: SubagentStopReason;
  output: string;
  sessionPath?: string;
}

export interface SettlementNotice {
  childId: string;
  stopReason: SubagentStopReason;
  sessionPath?: string;
  summary: string;
  content: string;
}

function summaryOf(childId: string, stopReason: SubagentStopReason): string {
  const subject = `Background subagent ${childId}`;
  if (stopReason === "completed") {
    return `${subject} finished and will do no further work unless you send it more.`;
  }
  if (stopReason === "aborted") return `${subject} was stopped before it finished.`;
  return `${subject} failed before it finished.`;
}

export function formatSettlementNotice(input: SettlementNoticeInput): SettlementNotice {
  const summary = summaryOf(input.childId, input.stopReason);
  const body = input.output.trim()
    ? `Its closing message:\n${input.output}`
    : "It left no closing message.";
  return {
    childId: input.childId,
    stopReason: input.stopReason,
    sessionPath: input.sessionPath,
    summary,
    content: `${summary}\n${body}`,
  };
}
