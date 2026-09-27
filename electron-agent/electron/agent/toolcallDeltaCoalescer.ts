type Rec = Record<string, unknown>;

function deltaOf(event: Rec): Rec | undefined {
  if (event.type !== 'message_update') return undefined;
  const ame = event.assistantMessageEvent as Rec | undefined;
  return ame?.type === 'toolcall_delta' && typeof ame.delta === 'string' ? ame : undefined;
}

/**
 * 合并同一 contentIndex 的连续 toolcall_delta（最长等 windowMs）。
 * 任何其它事件到来时先 flush 已挂起的 delta 再发该事件，保证全局顺序不变。
 */
export function createToolcallDeltaCoalescer(emit: (event: Rec) => void, windowMs = 32) {
  let pending: { event: Rec; ame: Rec } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending) return;
    const { event, ame } = pending;
    pending = null;
    emit({ ...event, assistantMessageEvent: ame });
  };
  const push = (event: Rec) => {
    const ame = deltaOf(event);
    if (!ame) { flush(); emit(event); return; }
    if (pending && pending.ame.contentIndex === ame.contentIndex) {
      pending.ame = {
        ...pending.ame,
        delta: `${pending.ame.delta as string}${ame.delta as string}`,
        ...(ame.id ? { id: ame.id } : {}),
        ...(ame.toolName ? { toolName: ame.toolName } : {}),
      };
      pending.event = { ...pending.event, usage: event.usage };
      return;
    }
    flush();
    pending = { event, ame: { ...ame } };
    timer = setTimeout(flush, windowMs);
  };
  return { push, flush };
}
