import { wrapAttachment } from '../../attachment';
import type { PastedText } from './types';

/**
 * 把编辑器序列化出的 markdown 与暂存的「粘贴文本 / 文件引用」拼成最终发送文本。
 * 文件引用（拖入的文件）只发路径：所有 `@path` 放在正文后同一行，空格分隔。
 * 粘贴文本用 <pi:attachment> 标记包裹（见 features/chat/attachment.ts），渲染侧据此切出附件卡片；
 * 块按插入顺序附在引用之后，块间空行分隔。
 */
export function composeMessage(markdown: string, pastedTexts: PastedText[]): string {
  const base = markdown.trim();
  const references = pastedTexts.filter((p) => p.referenceOnly && p.source).map((p) => `@${p.source}`);
  const blocks = pastedTexts
    .filter((p) => !(p.referenceOnly && p.source))
    .map((p) => {
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
  return [base, references.join(' '), ...blocks].filter(Boolean).join('\n\n');
}
