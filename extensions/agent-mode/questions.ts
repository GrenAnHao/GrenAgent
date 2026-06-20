// 对话流提问卡（Questions）：把 AI 的提问规范化为结构化卡数据，经
// sendMessage(customType:"agent-questions") 产出，前端 QuestionsCard 渲染为对话流内的
// 多选卡片（不弹窗）。纯逻辑无 I/O，便于单测。

import { CUSTOM_OPTION_ID } from "../_shared/question-constants.js";

export { CUSTOM_OPTION_ID };

export interface QuestionOption {
  id: string;
  label: string;
}

export interface QuestionSpec {
  id: string;
  title: string;
  options: QuestionOption[];
  allowMultiple: boolean;
  allowCustom?: boolean;
}

export interface QuestionsCardData {
  kind: "questions";
  id: string;
  questions: QuestionSpec[];
  /** 是否展示底部「补充说明」区（文本 + 可选图片）。 */
  allowExtra?: boolean;
  /** allowExtra 为 true 时是否允许贴图，默认 true。 */
  allowExtraImages?: boolean;
  extraPlaceholder?: string;
}

// AI 经 ask_user 工具传入的原始问题（宽松形状，运行时规范化）。
export interface RawQuestion {
  question?: string;
  options?: Array<{ id?: string; label?: string } | string>;
  allowMultiple?: boolean;
  allowCustom?: boolean;
  customLabel?: string;
}

export interface RawAskUserParams {
  questions?: RawQuestion[];
  allowExtra?: boolean;
  allowExtraImages?: boolean;
  extraPlaceholder?: string;
}

/** ask_user 单次最多渲染的问题数（载荷与 UI 体量上限）。 */
export const MAX_QUESTIONS = 8;

// 生成提问卡 id：q-<base36 时间戳>-<rand>。
export function makeQuestionsId(now: Date = new Date(), rand: string = Math.random().toString(36).slice(2, 6)): string {
  return `q-${now.getTime().toString(36)}-${rand}`;
}

// 规范化：补全问题/选项 id、去空白、过滤空项；无任何合法问题时返回 null（调用方据此报错）。
export function normalizeQuestions(raw: RawQuestion[], id: string, card?: Omit<RawAskUserParams, "questions">): QuestionsCardData | null {
  const questions: QuestionSpec[] = [];
  raw.forEach((q) => {
    const title = (q?.question ?? "").trim();
    if (!title) return;
    const options: QuestionOption[] = [];
    (q.options ?? []).forEach((o) => {
      const label = (typeof o === "string" ? o : (o?.label ?? "")).trim();
      if (!label) return;
      const rawId = typeof o === "string" ? "" : (o?.id ?? "").trim();
      options.push({ id: rawId || `o${options.length + 1}`, label });
    });
    const allowCustom = Boolean(q.allowCustom);
    if (allowCustom && !options.some((o) => o.id === CUSTOM_OPTION_ID)) {
      const customLabel = (q.customLabel ?? "其他（自定义）").trim() || "其他（自定义）";
      options.push({ id: CUSTOM_OPTION_ID, label: customLabel });
    }
    questions.push({
      id: `q${questions.length + 1}`,
      title,
      options,
      allowMultiple: Boolean(q.allowMultiple),
      allowCustom,
    });
  });
  if (questions.length > MAX_QUESTIONS) questions.length = MAX_QUESTIONS;
  if (questions.length === 0) return null;
  return {
    kind: "questions",
    id,
    questions,
    ...(card?.allowExtra ? { allowExtra: true } : {}),
    ...(card?.allowExtraImages === false ? { allowExtraImages: false } : card?.allowExtra ? { allowExtraImages: true } : {}),
    ...(card?.extraPlaceholder?.trim() ? { extraPlaceholder: card.extraPlaceholder.trim() } : {}),
  };
}
