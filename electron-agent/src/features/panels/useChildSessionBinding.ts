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

/**
 * 同一 workspace 的第二条只读绑定：种子消息来自子会话 JSONL，
 * 流式事件按 sessionPath 灌进 reducer（不再经 transcriptTail）。
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

    void seed();
    void onPiEvent((env) => {
      if (!isEmbeddedChildEvent(env, sessionPath)) return;
      setState((s) => materializeToolDrafts(applyEvent(s, env.event), Date.now(), parsePartialArgs).state);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });

    const timer = running ? setInterval(() => void seed(), 2500) : undefined;
    return () => {
      cancelled = true;
      unlisten?.();
      if (timer) clearInterval(timer);
    };
  }, [sessionPath, running]);

  return useMemo(() => state.messages.map((m, i) => ({ ...m, id: `sa-${i}` })), [state.messages]);
}
