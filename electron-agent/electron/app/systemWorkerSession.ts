/** 与 renderer `systemWorkerChat.isSystemWorkerPrompt` 保持同一骨架，避免主进程拉渲染层 store。 */
const TASK_INPUT_RE = /\nTask kind: [a-z][a-z0-9_]*\nInput: /;

function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const text = (block as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/** 旧 oneshot / memory_extract 短调用会话：侧栏不展示。 */
export function isSystemWorkerSessionLines(lines: string[]): boolean {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; message?: unknown };
      if (entry.type !== 'message') continue;
      const message = entry.message as { role?: unknown } | undefined;
      if (message?.role !== 'user') continue;
      if (TASK_INPUT_RE.test(messageText(message))) return true;
    } catch {
      /* 忽略坏行 */
    }
  }
  return false;
}
