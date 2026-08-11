import { useMemo, useEffect, useRef, useState } from 'react';
import { applyEvent, initialAgentState, type AgentState, type ChatMessage } from '../../stores/agentReducer';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { groupMessages } from '../chat/groupMessages';
import { ChatMessageItems } from '../chat/ChatMessageItems';
import { computeSubAgentUnits, computeAnsweredQuestions } from '../chat/messagePrecompute';
import { finalizeSubAgentMessages } from './subagentUtils';
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

/** transcript 缺失时（如多任务/旧数据）的兜底：取结果文本块。 */
function fallbackText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: string }).type === 'text',
    )
    .map((b) => b.text)
    .join('');
}

interface ParseCache {
  lineCount: number;
  state: AgentState;
}

/**
 * 增量解析 transcript JSONL：只处理自上次以来新增的行，不从头全量重跑 reducer。
 * 原先每次 transcript 更新都 split + 全量 applyEvent，随运行时间线性增长；
 * 现在只追加增量，首次或 transcript 回缩（异常）时才全量回放。
 */
function useIncrementalMessages(transcript: string): ChatMessage[] {
  const cacheRef = useRef<ParseCache>({ lineCount: 0, state: initialAgentState() });

  return useMemo(() => {
    const lines = transcript.split(/\r?\n/).filter(Boolean);
    const prev = cacheRef.current;

    let startIdx: number;
    let state: AgentState;

    if (lines.length >= prev.lineCount && prev.lineCount > 0) {
      // 正常增量路径
      startIdx = prev.lineCount;
      state = prev.state;
    } else {
      // 全量回放（首次、或行数意外减少）
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
 * 仅当 result 里没有 transcript 时（即非内联 spawn_agent 消息）才走这条路径。
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

interface SubAgentConversationProps {
  task: string;
  result: unknown;
  status: 'running' | 'done' | 'error';
  /** 跨会话 / 后台 spawn 时传入，用于从 registry 按需拉取 transcript。 */
  workspace?: string;
  agentId?: string | null;
  'data-testid'?: string;
}

/** 单个子代理的对话视图：把子代理 JSONL 还原成消息，用主对话同款气泡 + 虚拟化渲染。 */
export function SubAgentConversation({
  task,
  result,
  status,
  workspace,
  agentId,
  'data-testid': testId,
}: SubAgentConversationProps) {
  // 运行中 result（transcript）每帧增长，100ms 节流避免每个 token 都重解析整段 JSONL。
  const liveResult = useThrottledValue(result, 100, { enabled: status === 'running' });

  // 从工具结果里取内联 transcript（主对话里的 spawn_agent 消息）
  const inlineTranscript = transcriptOf(liveResult);

  // 若内联 transcript 为空（跨会话 / 后台 spawn），从 registry 按需拉取
  const registryTranscript = useRegistryTranscript(
    workspace ?? '',
    inlineTranscript ? null : agentId, // 有内联 transcript 时不走 registry
    status === 'running',
  );

  const transcript = inlineTranscript || registryTranscript;

  // 增量解析 transcript，不全量重跑
  const transcriptMessages = useIncrementalMessages(transcript);

  const messages = useMemo<ChatMessage[]>(() => {
    const out: ChatMessage[] = [{ kind: 'user', id: 'sa-task', text: task }];
    if (transcript) {
      out.push(...transcriptMessages);
    } else {
      const text = fallbackText(liveResult);
      if (text)
        out.push({
          kind: 'assistant',
          id: 'sa-out',
          text,
          thinking: '',
          streaming: status === 'running',
        });
    }
    // 终态收尾：transcript 末步缺 end 事件时回放会残留「运行中」步骤，据整体状态收尾。
    return finalizeSubAgentMessages(out, status);
  }, [task, liveResult, status, transcript, transcriptMessages]);

  const display = useMemo(() => groupMessages(messages), [messages]);
  const unitsByMessage = useMemo(() => computeSubAgentUnits(display), [display]);
  const answeredQuestions = useMemo(() => computeAnsweredQuestions(display), [display]);

  return (
    <ChatMessageItems
      messages={display}
      unitsByMessage={unitsByMessage}
      answeredQuestions={answeredQuestions}
      paddingInline={16}
      resetKey={task}
      data-testid={testId}
    />
  );
}
