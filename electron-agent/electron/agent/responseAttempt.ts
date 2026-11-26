type Rec = Record<string, unknown>;
export interface ResponseAttempt { runId: number; attempt: number }

/** Bind response identity while the SDK still supplies raw message snapshots. Never label a late delta with the receiver's current attempt. */
export function createResponseAttemptBinder() {
  let runId = 0;
  let attempt = 0;
  let active = false;
  const byMessage = new WeakMap<object, ResponseAttempt>();
  const byTimestamp = new Map<number, ResponseAttempt | null>();
  return (event: Rec): ResponseAttempt | undefined => {
    if (event.type === 'agent_start') {
      if (!active) { runId++; attempt = 0; active = true; }
      return { runId, attempt };
    }
    if (event.type === 'auto_retry_start') {
      attempt = typeof event.attempt === 'number' ? event.attempt : attempt + 1;
      return { runId, attempt };
    }
    if (event.type === 'auto_retry_end') return { runId, attempt: typeof event.attempt === 'number' ? event.attempt : attempt };
    if (event.type === 'agent_settled') { active = false; return { runId, attempt }; }
    const message = event.message as Rec | undefined;
    if (message?.role !== 'assistant') return undefined;
    if (event.type === 'message_start') {
      const identity = { runId, attempt };
      byMessage.set(message, identity);
      if (typeof message.timestamp === 'number') {
        const previous = byTimestamp.get(message.timestamp);
        byTimestamp.set(message.timestamp, previous && (previous.runId !== identity.runId || previous.attempt !== identity.attempt) ? null : identity);
      }
      return identity;
    }
    if (event.type !== 'message_update' && event.type !== 'message_end') return undefined;
    return byMessage.get(message) ?? (typeof message.timestamp === 'number' ? byTimestamp.get(message.timestamp) ?? undefined : undefined);
  };
}
