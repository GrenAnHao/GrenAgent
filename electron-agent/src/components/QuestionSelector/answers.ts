import { CUSTOM_OPTION_ID } from './constants';

export interface QSOption {
  id: string;
  label: string;
}
export interface QSQuestion {
  id: string;
  title: string;
  options: QSOption[];
  allowMultiple?: boolean;
  allowCustom?: boolean;
}
export interface QSData {
  kind: 'questions';
  id: string;
  questions: QSQuestion[];
  allowExtra?: boolean;
  allowExtraImages?: boolean;
  extraPlaceholder?: string;
}

function formatChoiceLabels(
  q: QSQuestion,
  ids: string[],
  customTexts?: Record<string, string>,
): string[] {
  return ids
    .map((oid) => {
      if (oid === CUSTOM_OPTION_ID) {
        const t = customTexts?.[q.id]?.trim();
        return t ? `其他：${t}` : '其他';
      }
      return q.options.find((o) => o.id === oid)?.label;
    })
    .filter((x): x is string => Boolean(x));
}

/** 把用户选择拼成人类可读、AI 可解析的回传文本。 */
export function formatAnswers(
  data: QSData,
  selected: Record<string, string[]>,
  customTexts?: Record<string, string>,
  extraNote?: string,
  imageCount?: number,
): string {
  const lines = data.questions.map((q, i) => {
    const labels = formatChoiceLabels(q, selected[q.id] ?? [], customTexts);
    return `${i + 1}. ${q.title}：${labels.length > 0 ? labels.join('、') : '(未选)'}`;
  });
  const note = extraNote?.trim();
  if (note) lines.push(`补充说明：${note}`);
  if (imageCount && imageCount > 0) lines.push(`补充图片：${imageCount} 张（见消息附件）`);
  return `[我的选择]\n${lines.join('\n')}`;
}

export interface ParsedAnswerBlock {
  choices: string[];
  extraNote?: string;
  imageCount?: number;
}

/** 从 formatAnswers 文本里拆出各题选项，不把「补充说明」误当成最后一题的答案。 */
export function parseAnswerBlock(text: string): ParsedAnswerBlock {
  const body = text.replace(/^\s*\[我的选择\]\n?/, '');
  const extraAt = body.search(/^补充说明：/m);
  const imageAt = body.search(/^补充图片：/m);
  const cuts = [extraAt, imageAt].filter((i) => i >= 0);
  const headEnd = cuts.length > 0 ? Math.min(...cuts) : body.length;
  const head = body.slice(0, headEnd);
  const tail = body.slice(headEnd);

  const chunks = head.split(/(?=^\d+\.\s)/m).filter((s) => /^\d+\./.test(s.trimStart()));
  const choices = chunks.map((chunk) => {
    const colonIdx = chunk.indexOf('：');
    return colonIdx >= 0 ? chunk.slice(colonIdx + 1).trim() : chunk.replace(/^\d+\.\s*/, '').trim();
  });

  const extraMatch = tail.match(/^补充说明：([\s\S]*?)(?=^补充图片：)/m) ?? tail.match(/^补充说明：([\s\S]*)/);
  const extraNote = extraMatch?.[1]?.trim() || undefined;
  const imageMatch = tail.match(/^补充图片：(\d+)/m);
  const parsedCount = imageMatch ? Number(imageMatch[1]) : NaN;
  const imageCount = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : undefined;

  return extraNote || imageCount ? { choices, ...(extraNote ? { extraNote } : {}), ...(imageCount ? { imageCount } : {}) } : { choices };
}

/** ask_user 回传：无图保持纯文本；有图包一层哨兵，扩展端拆成 text + image content。 */
export function encodeAskUserAnswer(
  text: string,
  images?: Array<{ mimeType: string; data: string }>,
): string {
  const imgs = (images ?? []).filter((img) => img.mimeType && img.data);
  if (imgs.length === 0) return text;
  return JSON.stringify({
    __askUserAnswer: 1,
    text,
    images: imgs.map((img) => ({ mimeType: img.mimeType, data: img.data })),
  });
}

/** 解析 ask_user 经 ctx.ui.input 传来的载荷（哨兵 __askUser）。非该载荷返回 null。 */
export function parseAskUserPayload(title: unknown): QSData | null {
  if (typeof title !== 'string' || title[0] !== '{') return null;
  try {
    const obj = JSON.parse(title) as { __askUser?: unknown; data?: QSData };
    if (obj && obj.__askUser && obj.data && obj.data.kind === 'questions') return obj.data;
  } catch {
    return null;
  }
  return null;
}
