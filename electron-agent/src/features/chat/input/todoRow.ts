import type { TodoSummary } from '@extensions/_shared/todo-model';

export function todoRowCopy(summary: TodoSummary): { args: string; meta?: string } {
  if (summary.total === 0) return { args: '已清空' };
  const head = `${summary.done}/${summary.total} 已完成`;
  const args = summary.activeContent ? `${head} · ${summary.activeContent}` : head;
  return { args, meta: summary.activeExtra > 0 ? `+${summary.activeExtra}` : undefined };
}
