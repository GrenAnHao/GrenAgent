import { wrapAttachment } from '../../attachment';
import type { PastedText } from './types';

/**
 * 把编辑器序列化出的 markdown 与暂存的「粘贴文本 / 文件块」拼成最终发送文本。
 * 每个块用 <pi:attachment> 标记包裹（见 features/chat/attachment.ts），
 * 渲染侧据此切出附件卡片；块按插入顺序附在正文之后，块间空行分隔。
 */
export function composeMessage(markdown: string, pastedTexts: PastedText[]): string {
  const base = markdown.trim();
  const blocks = pastedTexts
    .map((p) => {
      if (p.referenceOnly && p.source) return `@${p.source}`;
      const content = p.text.replace(/\s+$/, '');
      if (!content) return '';
      return wrapAttachment({
        attType: p.source ? 'file' : 'text',
        path: p.source,
        lines: p.lines,
        chars: p.chars,
        content,
      });
    })
    .filter(Boolean);
  return [base, ...blocks].filter(Boolean).join('\n\n');
}
