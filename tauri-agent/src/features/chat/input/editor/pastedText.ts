import type { PastedText } from './types';

/** 超过任一阈值的纯文本粘贴会被折叠成「粘贴文本」chip，而不是灌进输入框。 */
export const PASTE_LINE_THRESHOLD = 12;
export const PASTE_CHAR_THRESHOLD = 1500;

export function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}

/** 是否达到「自动转临时文本」阈值。 */
export function isLongPaste(text: string): boolean {
  if (!text) return false;
  return countLines(text) > PASTE_LINE_THRESHOLD || text.length > PASTE_CHAR_THRESHOLD;
}

let seq = 0;

export function makePastedText(text: string, source?: string): PastedText {
  seq += 1;
  return {
    id: `pt-${Date.now().toString(36)}-${seq}`,
    text,
    lines: countLines(text),
    chars: text.length,
    ...(source ? { source } : {}),
  };
}

/** 大文件拖入：chip 展示文件名与行数，发送时用 `@path` 引用而非嵌入全文。 */
export function makeFileReference(path: string, stats: { lines: number; chars: number }): PastedText {
  seq += 1;
  return {
    id: `ref-${Date.now().toString(36)}-${seq}`,
    text: '',
    lines: stats.lines,
    chars: stats.chars,
    source: path,
    referenceOnly: true,
  };
}

/** chip 上的简短描述：拖入文件显示「文件名 · 19 行」，纯文本粘贴显示「粘贴文本 · 19 行」。 */
export function pastedLabel(p: Pick<PastedText, 'lines' | 'chars' | 'source'>): string {
  if (p.source) {
    const name = p.source.split('/').pop() || p.source;
    return `${name} · ${p.lines} 行`;
  }
  return `粘贴文本 · ${p.lines} 行`;
}
