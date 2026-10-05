/** 自动压缩打断了还没结束的回合时，用来续跑的隐藏消息。界面不显示，模型看得到。 */
export const AUTO_COMPACT_RESUME_TYPE = "auto-compact-resume";

export const AUTO_COMPACT_RESUME_TEXT =
  "Context was compacted automatically while this task was still in progress. Continue from the summary and the kept messages. Do not redo finished work.";

export interface AutoCompactTurnView {
  stopReason?: string;
  toolResultCount: number;
  hasPendingMessages: boolean;
}

/**
 * 这一轮还会自己往下走，自动压缩（会先 abort）结束后就要续跑。
 * 模型已经正常说完、也没有排队消息时不续跑。用户取消（aborted）也不续跑。
 */
export function shouldResumeAfterAutoCompact(turn: AutoCompactTurnView): boolean {
  if (turn.stopReason === "aborted") return false;
  if (turn.hasPendingMessages) return true;
  if (turn.toolResultCount > 0) return true;
  return turn.stopReason === "length";
}

export function viewAutoCompactTurn(event: unknown, hasPendingMessages: boolean): AutoCompactTurnView {
  const record = event && typeof event === "object" ? (event as { message?: { stopReason?: unknown }; toolResults?: unknown }) : {};
  const stopReason = typeof record.message?.stopReason === "string" ? record.message.stopReason : undefined;
  const toolResultCount = Array.isArray(record.toolResults) ? record.toolResults.length : 0;
  return { stopReason, toolResultCount, hasPendingMessages };
}

/** 用户取消压缩时不要续跑。摘要失败、没有可压内容时，回合已经被 abort 打断，仍然续跑。 */
export function isCompactionCancelled(message: string): boolean {
  return /cancel|aborted/i.test(message);
}
