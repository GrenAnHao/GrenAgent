type Rec = Record<string, unknown>;

/** 子代理流：文字、思考、工具参数增量都合并。主会话只合并工具参数增量（文字逐字推，渲染层自己按帧合并）。 */
export const STREAM_DELTA_TYPES: ReadonlySet<string> = new Set(['toolcall_delta', 'text_delta', 'thinking_delta']);
const TOOLCALL_ONLY: ReadonlySet<string> = new Set(['toolcall_delta']);

function deltaOf(event: Rec, types: ReadonlySet<string>): Rec | undefined {
  if (event.type !== 'message_update') return undefined;
  const ame = event.assistantMessageEvent as Rec | undefined;
  return typeof ame?.type === 'string' && types.has(ame.type) && typeof ame.delta === 'string' ? ame : undefined;
}

/**
 * 合并同一类型、同一 contentIndex 的连续增量（最长等 windowMs）。
 * 任何其它事件到来时先 flush 已挂起的增量再发该事件，保证全局顺序不变。
 */
export function createDeltaCoalescer(
  emit: (event: Rec) => void,
  options: { windowMs?: number; types?: ReadonlySet<string> } = {},
) {
  const windowMs = options.windowMs ?? 32;
  const types = options.types ?? TOOLCALL_ONLY;
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
    const ame = deltaOf(event, types);
    if (!ame) { flush(); emit(event); return; }
    if (pending && pending.ame.type === ame.type && pending.ame.contentIndex === ame.contentIndex) {
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

/** 主会话：只合并 toolcall_delta。 */
export function createToolcallDeltaCoalescer(emit: (event: Rec) => void, windowMs = 32) {
  return createDeltaCoalescer(emit, { windowMs, types: TOOLCALL_ONLY });
}
