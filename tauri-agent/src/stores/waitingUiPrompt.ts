export const UI_PROMPT_KINDS = ['select', 'confirm', 'input', 'editor', 'custom'] as const;
export type UiPromptKind = (typeof UI_PROMPT_KINDS)[number];

export interface WaitingUiPrompt {
  kind: UiPromptKind;
  title?: string;
}

function isUiPromptKind(value: unknown): value is UiPromptKind {
  return typeof value === 'string' && (UI_PROMPT_KINDS as readonly string[]).includes(value);
}

/** 解析 approval 扩展经 setStatus('ui-prompt') 推来的等待态；空值表示提示已结束。 */
export function parseWaitingUiPrompt(text: unknown): WaitingUiPrompt | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  try {
    const parsed = JSON.parse(text) as { kind?: unknown; title?: unknown };
    if (!isUiPromptKind(parsed.kind)) return undefined;
    return {
      kind: parsed.kind,
      ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
    };
  } catch {
    return undefined;
  }
}

/** 列表脚注：把官方 prompt kind 收成用户能看懂的等待文案。 */
export function waitingUiPromptLabel(prompt: WaitingUiPrompt | undefined): string | undefined {
  if (!prompt) return undefined;
  if (prompt.kind === 'select') return '等待批准…';
  if (prompt.kind === 'confirm') return '等待确认…';
  return '等待输入…';
}
