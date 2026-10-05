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

/**
 * 输入栏右侧只有一个按钮，外观在它自己身上切换。
 * 有可发内容时它是发送，对话进行中也能把草稿增量发出去。
 * 本轮还在进行、输入为空时，同一个按钮变成停止。
 * 报错横幅出现时 inFlight 已经清掉，按钮回到发送。
 */
export function composerPrimaryAction(input: {
  inFlight: boolean;
  canSend: boolean;
}): 'send' | 'stop' {
  if (input.canSend) return 'send';
  return input.inFlight ? 'stop' : 'send';
}

/**
 * 只有一条跟进挂在输入框上、正文为空、本轮还在进行时，再次回车才把它发出去。
 * 多条仍留在排队里，不因一次回车整批发出。
 * `busy` 含流式、等待首响、重试、工具还在跑、回合尚未收尾。
 */
export function shouldDispatchSingleQueued(input: {
  empty: boolean;
  hasAttachments: boolean;
  composerQueueCount: number;
  busy: boolean;
}): boolean {
  return input.empty && !input.hasAttachments && input.composerQueueCount === 1 && input.busy;
}

/** 截断后等当前回合真正停下，再把跟进作为新消息发出。 */
export async function waitForTurnIdle(
  read: () => { busy: boolean },
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (read().busy && Date.now() - start < timeoutMs) {
    await wait(40);
  }
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
