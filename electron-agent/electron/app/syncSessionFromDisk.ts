/**
 * 会话文件在磁盘上被原地改写（回退到此 / 重新生成 / 删除的截断）之后，让内存里的会话跟上。
 *
 * `AgentSession.reload()` 只重载设置、资源和扩展，不重读会话文件：SessionManager 的条目和 leaf、
 * agent 发给模型的 messages 都还是截断前的。不同步的后果是下一轮模型照样读到被删掉的回复，
 * 新条目还以已经删掉的旧 leaf 为 parentId 追加进文件。
 *
 * 这里照 pi 自己换会话文件的做法：`sessionManager.setSessionFile()` 重读条目（leaf 落到最后一条），
 * 再用 `_refreshFinalizedContext()`（pi 每次条目变化后用它重建上下文）把 agent 的 messages 换成新投影。
 * 拿不到这个私有方法时，按它的实现直接写 `agent.state.messages`。
 */

export interface SessionFileSync {
  sessionManager?: {
    setSessionFile?: (sessionFile: string) => void;
    buildSessionProjection?: () => { messages: unknown[] };
  };
  agent?: { state: { messages: unknown[] } };
}

export function syncSessionFromDisk(session: SessionFileSync, sessionFile: string): void {
  const manager = session.sessionManager;
  if (typeof manager?.setSessionFile !== 'function') {
    throw new Error('session manager cannot reload its file');
  }
  manager.setSessionFile(sessionFile);
  const refresh = (session as { _refreshFinalizedContext?: unknown })._refreshFinalizedContext;
  if (typeof refresh === 'function') {
    (refresh as () => void).call(session);
    return;
  }
  if (typeof manager.buildSessionProjection !== 'function' || !session.agent) {
    throw new Error('session context cannot be rebuilt');
  }
  session.agent.state.messages = manager.buildSessionProjection().messages;
}
