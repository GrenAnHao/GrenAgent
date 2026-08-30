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
