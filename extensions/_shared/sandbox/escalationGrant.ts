// safety 的审批已经为某次 bash 调用问过用户并得到允许时，留一张只对这次调用、这个模式有效的许可，
// bash 执行时消费它，不再弹第二次升权提示。tool_call 钩子和工具执行拿到的是同一个 toolCallId
// （pi dist/core/agent-session.js 的 _beforeToolCall）。内存里，用一次即删；
// 会话关闭时清掉这个会话剩下的（被后面的钩子拦下、没走到执行的调用）。
const grants = new Map<string, string>();

const key = (sessionId: string, toolCallId: string) => `${sessionId.trim()}\0${toolCallId}`;

export function grantEscalation(sessionId: string, toolCallId: string, mode: string): void {
  grants.set(key(sessionId, toolCallId), mode);
}

/** 有这次调用、这个模式的许可就消费并返回 true。模式不同也删掉：许可只给用户看到的那个请求。 */
export function takeEscalationGrant(sessionId: string, toolCallId: string, mode: string): boolean {
  const k = key(sessionId, toolCallId);
  const granted = grants.get(k);
  grants.delete(k);
  return granted === mode;
}

export function clearEscalationGrants(sessionId: string): void {
  const prefix = `${sessionId.trim()}\0`;
  for (const k of [...grants.keys()]) if (k.startsWith(prefix)) grants.delete(k);
}

export function __resetEscalationGrantsForTest(): void {
  grants.clear();
}
