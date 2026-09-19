/** 输入栏发送路由：执行中一律先落成跟进条；已有跟进或本地跟进条时继续跟进，避免插队。 */
export function composerSendBehavior(input: {
  isGenerating: boolean;
  isStreaming: boolean;
  hasFollowUp: boolean;
  hasRunningTool?: boolean;
  hasComposerQueue?: boolean;
}): 'steer' | 'followUp' | undefined {
  if (input.isGenerating || input.hasRunningTool || input.isStreaming) return 'followUp';
  if (input.hasFollowUp || input.hasComposerQueue) return 'followUp';
  return undefined;
}

/** 空回车：停流后若已有跟进，允许直接继续，不必再打一遍正文。 */
export function composerCanSend(input: {
  empty: boolean;
  hasAttachments: boolean;
  hasFollowUp: boolean;
  isStreaming: boolean;
  hasComposerQueue?: boolean;
}): boolean {
  if (!input.empty || input.hasAttachments) return true;
  return (input.hasFollowUp || Boolean(input.hasComposerQueue)) && !input.isStreaming;
}
