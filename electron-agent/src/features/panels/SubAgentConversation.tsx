import { useMemo, useEffect, useRef, useState } from 'react';
import {
  applyEvent,
  initialAgentState,
  messagesFromAgent,
  type AgentState,
  type ChatMessage,
} from '../../stores/agentReducer';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { groupMessages } from '../chat/groupMessages';
import { ChatMessageItems } from '../chat/ChatMessageItems';
import { computeSubAgentUnits, computeAnsweredQuestions } from '../chat/messagePrecompute';
import { buildSubAgentConversationMessages, subAgentSessionPath } from './subagentUtils';
import { pi } from '../../lib/pi';

/** 从 spawn_agent 工具结果里取原始 JSONL transcript（details.transcript / transcriptTail）。 */
function transcriptOf(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return '';
  const d = details as { transcript?: unknown; transcriptTail?: unknown };
  // 终态有完整 transcript；运行中后端只推尾部 transcriptTail（防 O(n^2) 串卡爆前端）。
  if (typeof d.transcript === 'string' && d.transcript) return d.transcript;
  return typeof d.transcriptTail === 'string' ? d.transcriptTail : '';
}

/** session 头 / 控制事件不算可回放；当成空串以便走 registry 或结果正文兜底。 */
function usableTranscript(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s) as { type?: string };
      if (
        ev.type === 'message_start' ||
        ev.type === 'message_update' ||
        ev.type === 'message_end' ||
        ev.type === 'tool_execution_start' ||
        ev.type === 'tool_execution_end'
      ) {
        return raw;
      }
    } catch {
      /* skip */
    }
  }
  return '';
}

interface ParseCache {
  lineCount: number;
  state: AgentState;
}

/**
 * 增量解析 transcript JSONL：只处理自上次以来新增的行，不从头全量重跑 reducer。
 */
function useIncrementalMessages(transcript: string): ChatMessage[] {
  const cacheRef = useRef<ParseCache>({ lineCount: 0, state: initialAgentState() });

  return useMemo(() => {
    const lines = transcript.split(/\r?\n/).filter(Boolean);
    const prev = cacheRef.current;

    let startIdx: number;
    let state: AgentState;

    if (lines.length >= prev.lineCount && prev.lineCount > 0) {
      startIdx = prev.lineCount;
      state = prev.state;
    } else {
      startIdx = 0;
      state = initialAgentState();
    }

    for (let i = startIdx; i < lines.length; i++) {
      try {
        const ev = JSON.parse(lines[i]);
        if (typeof (ev as { type?: unknown }).type === 'string') {
          state = applyEvent(state, ev);
        }
      } catch {
        // 跳过损坏的行
      }
    }

    cacheRef.current = { lineCount: lines.length, state };
    return state.messages.map((m, i) => ({ ...m, id: `sa-${i}` }));
  }, [transcript]);
}

/**
 * 从 registry 按需拉取子代理 transcript（用于跨会话 / 后台 spawn 的面板打开）。
 */
function useRegistryTranscript(
  workspace: string,
  agentId: string | null | undefined,
  running: boolean,
): string {
  const [transcript, setTranscript] = useState('');

  useEffect(() => {
    if (!workspace || !agentId) return;
    let cancelled = false;

    const fetch = async () => {
      try {
        const t = await pi.subagentGetTranscript(workspace, agentId);
        if (!cancelled && t) setTranscript(t);
      } catch {
        // 忽略，保留上次
      }
    };

    void fetch();
    if (!running) return;

    const timer = setInterval(() => void fetch(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspace, agentId, running]);

  return transcript;
}

/**
 * 绑定 embedded 子代理的真会话 JSONL（只读）；运行中轮询刷新。
 */
function useSessionPathMessages(sessionPath: string | null | undefined, running: boolean): ChatMessage[] {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    if (!sessionPath) {
      setMessages([]);
      return;
    }
    let cancelled = false;

    const fetch = async () => {
      try {
        const { messages: raw } = await pi.subagentGetSessionMessages(sessionPath);
        if (cancelled || !raw?.length) return;
        setMessages(messagesFromAgent(raw).map((m, i) => ({ ...m, id: `sa-${i}` })));
      } catch {
        /* keep last */
      }
    };

    void fetch();
    if (!running) return;

    const timer = setInterval(() => void fetch(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionPath, running]);

  return messages;
}

interface SubAgentConversationProps {
  task: string;
  result: unknown;
  status: 'running' | 'done' | 'error';
  /** 跨会话 / 后台 spawn 时传入，用于从 registry 按需拉取 transcript。 */
  workspace?: string;
  agentId?: string | null;
  'data-testid'?: string;
}

/** 单个子代理的对话视图：真会话绑定或 JSONL 回放。 */
export function SubAgentConversation({
  task,
  result,
  status,
  workspace,
  agentId,
  'data-testid': testId,
}: SubAgentConversationProps) {
  const liveResult = useThrottledValue(result, 100, { enabled: status === 'running' });

  const sessionPath = subAgentSessionPath(liveResult);
  const sessionMessages = useSessionPathMessages(sessionPath, status === 'running');

  const inlineTranscript = usableTranscript(transcriptOf(liveResult));

  const registryTranscript = useRegistryTranscript(
    workspace ?? '',
    sessionPath || inlineTranscript ? null : agentId,
    status === 'running',
  );

  const transcript = inlineTranscript || registryTranscript;
  const transcriptMessages = useIncrementalMessages(sessionPath ? '' : transcript);

  const replayMessages = sessionPath ? sessionMessages : transcriptMessages;

  const messages = useMemo(
    () => buildSubAgentConversationMessages(task, liveResult, status, replayMessages),
    [task, liveResult, status, replayMessages],
  );

  const display = useMemo(() => groupMessages(messages), [messages]);
  const unitsByMessage = useMemo(() => computeSubAgentUnits(display), [display]);
  const answeredQuestions = useMemo(() => computeAnsweredQuestions(display), [display]);

  return (
    <ChatMessageItems
      messages={display}
      unitsByMessage={unitsByMessage}
      answeredQuestions={answeredQuestions}
      paddingInline={16}
      resetKey={sessionPath ?? task}
      data-testid={testId}
    />
  );
}
