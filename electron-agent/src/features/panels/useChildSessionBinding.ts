import { useEffect, useMemo, useState } from 'react';
import {
  applyEvent,
  initialAgentState,
  materializeToolDrafts,
  messagesFromAgent,
  type AgentState,
  type ChatMessage,
} from '../../stores/agentReducer';
import { parsePartialArgs } from '../../lib/streamingJson';
import { onPiEvent, pi } from '../../lib/pi';
import { isEmbeddedChildEvent } from './subagentUtils';

/** 这么久没收到子会话事件，才重读一次 JSONL 补漏。 */
const QUIET_RESEED_MS = 5000;
const RESEED_CHECK_MS = 2500;

/**
 * 同一 workspace 的第二条只读绑定：种子消息来自子会话 JSONL，
 * 流式事件按 sessionPath 灌进 reducer（不再经 transcriptTail）。
 *
 * 事件在流的时候不重读 JSONL：主进程每次都要同步解析整份子会话，开着几个详情就会卡住事件循环。
 * 安静超过 QUIET_RESEED_MS 才补一次：进程子代理不推事件，只能靠它。
 */
export function useChildSessionBinding(sessionPath: string | null | undefined, running: boolean): ChatMessage[] {
  const [state, setState] = useState<AgentState>(() => initialAgentState());

  useEffect(() => {
    if (!sessionPath) {
      setState(initialAgentState());
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    setState(initialAgentState());

    const seed = async () => {
      try {
        const { messages: raw } = await pi.subagentGetSessionMessages(sessionPath);
        if (cancelled || !raw?.length) return;
        const msgs = messagesFromAgent(raw).map((m, i) => ({ ...m, id: `sa-${i}` }));
        setState((s) => (s.messages.length >= msgs.length ? s : { ...s, messages: msgs }));
      } catch {
        /* keep last */
      }
    };

    let lastEventAt = 0;
    void seed();
    void onPiEvent((env) => {
      if (!isEmbeddedChildEvent(env, sessionPath)) return;
      lastEventAt = Date.now();
      setState((s) => materializeToolDrafts(applyEvent(s, env.event), Date.now(), parsePartialArgs).state);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });

    const timer = running
      ? setInterval(() => {
          if (Date.now() - lastEventAt >= QUIET_RESEED_MS) void seed();
        }, RESEED_CHECK_MS)
      : undefined;
    return () => {
      cancelled = true;
      unlisten?.();
      if (timer) clearInterval(timer);
    };
  }, [sessionPath, running]);

  return useMemo(() => state.messages.map((m, i) => ({ ...m, id: `sa-${i}` })), [state.messages]);
}
