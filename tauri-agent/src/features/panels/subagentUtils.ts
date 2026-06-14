import { messagesFromTranscript } from '../../stores/agentReducer';

/** 从 spawn_agent 工具入参里取一个人类可读的任务标签（主对话内联块与右侧面板 tab 共用）。 */
export function taskLabel(args: unknown): string {
  const a = (args ?? {}) as { task?: string; tasks?: string[] };
  if (a.task?.trim()) return a.task.trim();
  if (a.tasks?.length) return `${a.tasks.length} 个并行任务`;
  return '子代理任务';
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
