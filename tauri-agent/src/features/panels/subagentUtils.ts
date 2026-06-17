import { messagesFromTranscript } from '../../stores/agentReducer';

/** 从 spawn_agent 工具入参里取一个人类可读的任务标签（主对话内联块与右侧面板 tab 共用）。 */
export function taskLabel(args: unknown): string {
  const a = (args ?? {}) as {
    task?: string;
    tasks?: Array<string | { task?: string }>;
    chain?: Array<{ task?: string }>;
    agent?: string;
  };
  const agent = a.agent?.trim();
  if (a.task?.trim()) return agent ? `${agent}: ${a.task.trim()}` : a.task.trim();
  if (a.chain?.length) return `${a.chain.length} 步链式`;
  if (a.tasks?.length) return `${a.tasks.length} 个并行任务`;
  return '子代理任务';
}

function detailsOf(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const details = (result as { details?: unknown }).details;
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : null;
}

/** spawn_agent 工具结果里的 agentId（前台/后台子代理均有）。 */
export function subAgentId(result: unknown): string | null {
  const id = detailsOf(result)?.agentId;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** 后台 spawn：工具调用已返回但子代理仍在 registry 中运行。 */
export function isBackgroundSpawn(result: unknown): boolean {
  const d = detailsOf(result);
  return d?.status === 'running' && typeof d?.transcript !== 'string';
}

function transcriptOf(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return '';
  const t = (details as { transcript?: unknown }).transcript;
  return typeof t === 'string' ? t : '';
}

/** 子代理已执行步数（transcript 里的 assistant + tool 消息数）；无 transcript 返回 0。 */
export function subAgentStepCount(result: unknown): number {
  const transcript = transcriptOf(result);
  if (!transcript) return 0;
  return messagesFromTranscript(transcript).filter(
    (m) => m.kind === 'assistant' || m.kind === 'tool',
  ).length;
}
