/** 从 spawn_agent 工具入参里取一个人类可读的任务标签（主对话内联块与右侧面板 tab 共用）。 */
export function taskLabel(args: unknown): string {
  const a = (args ?? {}) as { task?: string; tasks?: string[] };
  if (a.task?.trim()) return a.task.trim();
  if (a.tasks?.length) return `${a.tasks.length} 个并行任务`;
  return '子代理任务';
}
