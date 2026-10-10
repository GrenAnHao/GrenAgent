import { useEffect, useMemo, useRef, useState } from 'react';
import { initialAgentState, interruptPendingToolCards, type AgentState, type ChatMessage } from '../../stores/agentReducer';
import { mergeLiveTail } from '../../stores/sessionMessageSync';
import { snapshotMessages } from '../../stores/sessionSnapshot';
import { createSessionStream, persistThinkingDurations } from '../../stores/sessionStream';
import { onPiEvent, pi } from '../../lib/pi';
import { isEmbeddedChildEvent } from './subagentUtils';

/** 这么久没收到子会话事件，才重读一次 JSONL 补漏。 */
const QUIET_RESEED_MS = 5000;
const RESEED_CHECK_MS = 2500;

type SeedMode = 'initial' | 'catchup';

/**
 * 同一 workspace 的第二条只读绑定：和主代理一样被动收流。
 *
 * 事件按 sessionPath 过滤后进 `createSessionStream`——这是主代理（agent.ts）用的同一份核心：
 * 入队、按帧批量套 reducer、毒事件隔离、大参数工具草稿延迟解析，两边行为一致。
 * 渲染也走同一套 reducer 和 ChatMessageItems，工具卡不用另做一遍。
 *
 * JSONL 只当历史：
 * - 开头读一次，用 mergeLiveTail 垫在实时尾巴前面（和主代理切到后台会话时补快照是同一个函数）。
 * - 事件在流时不重读：主进程每次都要同步解析整份子会话，开着几个详情就会卡住事件循环。
 * - 运行中安静超过 QUIET_RESEED_MS 才补一次，运行结束时再补一次：进程子代理不推事件，只能靠它。
 *
 * 订阅只跟 sessionPath 走，`running` 翻转不会重置已收到的内容。
 */
export function useChildSessionBinding(sessionPath: string | null | undefined, running: boolean): ChatMessage[] {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const reseedRef = useRef<((mode: SeedMode) => Promise<void>) | null>(null);
  const lastEventAtRef = useRef(0);
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    setMessages((prev) => (prev.length ? [] : prev));
    lastEventAtRef.current = 0;
    if (!sessionPath) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let state: AgentState = initialAgentState();

    const stream = createSessionStream({
      getState: () => state,
      setState: (next) => {
        state = next;
        if (!cancelled) setMessages(next.messages);
      },
      onCommitted: ({ state: committed, reachedEnd }) => {
        if (!reachedEnd) return;
        try {
          persistThinkingDurations(committed);
        } catch {
          /* 落盘失败不影响已渲染内容 */
        }
      },
    });

    const seed = async (mode: SeedMode) => {
      try {
        const { messages: raw } = await pi.subagentGetSessionMessages(sessionPath);
        if (cancelled || !raw?.length) return;
        // 队列里已经到的事件先落进 state，再和快照合并。
        stream.flush();
        // 快照里结果还没落盘的调用是 running 卡；子代理已结束就收成已中断。
        const snapshot = snapshotMessages(raw).sanitized;
        const base = runningRef.current ? snapshot : interruptPendingToolCards(snapshot);
        const live = state.messages;
        // 开头读到的快照比实时事件旧，尾巴为准。补读时事件已经安静了，快照至少一样新：
        // 条数不少就整份采用（进程子代理的工具结果靠这里更新），否则快照落后于实时尾巴，仍叠上尾巴。
        const next = mode === 'catchup' && base.length >= live.length ? base : mergeLiveTail(base, live);
        state = { ...state, messages: next };
        setMessages(next);
      } catch {
        /* keep last */
      }
    };
    reseedRef.current = seed;

    // 先订阅再读种子：读的过程中到的事件进队列，不会落在缝里。
    void onPiEvent((env) => {
      if (cancelled || !isEmbeddedChildEvent(env, sessionPath)) return;
      lastEventAtRef.current = Date.now();
      stream.push(env.event);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    void seed('initial');

    return () => {
      cancelled = true;
      reseedRef.current = null;
      stream.clear();
      unlisten?.();
    };
  }, [sessionPath]);

  useEffect(() => {
    if (!sessionPath || !running) return;
    const timer = setInterval(() => {
      if (Date.now() - lastEventAtRef.current >= QUIET_RESEED_MS) void reseedRef.current?.('catchup');
    }, RESEED_CHECK_MS);
    return () => clearInterval(timer);
  }, [sessionPath, running]);

  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void reseedRef.current?.('catchup');
    wasRunning.current = running;
  }, [running]);

  // id 按下标重写：每次读 JSONL 都会重新生成 id，不重写会让整列重挂载。state 里保留 reducer 的原 id。
  return useMemo(() => messages.map((m, i) => ({ ...m, id: `sa-${i}` })), [messages]);
}
