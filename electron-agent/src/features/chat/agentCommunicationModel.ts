import type { ConvStatus } from './conv/StatusGlyph';
import { extractText, getArgString, getDetails } from '../tools/toolUtils';

/** Existing adjacent-tools / activation envelopes; never infer a final result from message wording. */
const RECEIVED = /^Agent ([^\s]+) sent a message( without waking you)?:(?:\r?\n|[ \t])?([\s\S]*)$/;
export function incomingAgentMessage(content: string) {
  const match = RECEIVED.exec(content);
  return match ? { sender: match[1]!, quiet: Boolean(match[2]), body: match[3]! } : null;
}

export function outgoingAgentMessage(args: unknown, result: unknown, status: ConvStatus, argsComplete = true) {
  const details = getDetails(result);
  const receipt = extractText(result).trim();
  const requestedRecipient = getArgString(args, 'agent_id');
  const deliveredRecipient = /^message delivered to agent ([^\s;]+)/.exec(receipt)?.[1];
  const failed = status === 'error' || (result as { isError?: unknown } | null)?.isError === true;
  const running = status === 'running';
  const quietRequested = Boolean(args && typeof args === 'object' && (args as { wake?: unknown }).wake === false);
  const woken = details?.woken;
  let state = running ? (argsComplete ? '正在发送' : '正在准备消息') : failed
    ? (/^未送达/.test(receipt) ? '未送达' : /已取消|已中断|cancelled|aborted|interrupted/i.test(receipt) ? '发送已中断 · 投递状态未确认' : '发送调用失败 · 投递状态未确认')
    : '投递回执未保留';
  let note = '';
  if (!running && !failed && /^message delivered to agent /.test(receipt)) {
    state = '已送达';
    if (woken === true && details?.reason === 'sender-has-live-work') {
      state += ' · 已唤醒';
      note = '发送方仍有子代理或后台任务在运行，本次投递唤醒了接收方。';
    } else if (details?.delivery === 'next-step' || receipt.includes('at its next step')) {
      state += ' · 下一步读取';
    } else if (woken === false || receipt.includes('without waking it')) {
      state += ' · 未唤醒';
    }
  } else if (!running && !failed && receipt) {
    state = '调用已结束';
    note = receipt;
  }
  if (failed) note = receipt || (typeof details?.code === 'string' ? details.code : '未提供投递失败原因。');
  const mismatched = !running && !failed && requestedRecipient && deliveredRecipient && requestedRecipient !== deliveredRecipient;
  if (mismatched) {
    state = '投递对象待核对';
    note = `请求发送给 ${requestedRecipient}，回执记录的是 ${deliveredRecipient}。\n${receipt}`;
  }
  return {
    recipient: requestedRecipient || deliveredRecipient || '',
    body: getArgString(args, 'message'),
    state,
    status: failed || mismatched ? 'error' as const : status,
    note,
    // Requested wake policy is distinct from the receipt: it is not proof that the recipient was woken.
    policy: quietRequested ? '请求不唤醒' : '允许唤醒',
  };
}
