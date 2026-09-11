import { isSystemWorkerPrompt, parseSystemWorkerInput } from '../../lib/systemWorkerChat';

export type StructuredMessageText =
  | { mode: 'markdown'; text: string }
  | { mode: 'pre'; text: string };

function prettyJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function prettySystemWorkerPrompt(text: string): string {
  const match = /\nTask kind: ([a-z][a-z0-9_]*)\nInput: /.exec(text);
  if (!match) return text;
  const instruction = text.slice(0, match.index).trim();
  const input = parseSystemWorkerInput(text);
  const printed = input !== undefined ? prettyJson(input) : text.slice(match.index + match[0].length).trim();
  return `${instruction}\n\nTask kind: ${match[1]}\nInput:\n${printed ?? ''}`;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  );
}

/**
 * 系统短调用提示、整段 JSON 走预格式化，避免 Markdown 把 `\n` 和 `---` 收成一段乱墙。
 */
export function formatStructuredMessageText(text: string): StructuredMessageText {
  if (isSystemWorkerPrompt(text)) {
    return { mode: 'pre', text: prettySystemWorkerPrompt(text) };
  }
  if (looksLikeJson(text)) {
    try {
      const printed = prettyJson(JSON.parse(text));
      if (printed) return { mode: 'pre', text: printed };
    } catch {
      /* 看起来像 JSON 但解析失败，仍走 markdown */
    }
  }
  return { mode: 'markdown', text };
}
