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

// 阻塞式问答所需的最小 UI 接口（对接 harness 的 ctx.ui.select / ctx.ui.input）。
// 抽象出来便于单测：测试传入假 ui，无需真实对话框。
export interface AskUserUi {
  /** 展示单选选项，返回所选 label；用户取消/跳过返回 undefined。 */
  select(title: string, options: string[]): Promise<string | undefined>;
  /** 展示文本输入，返回输入内容；用户取消返回 undefined。 */
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

// 多选模式下用于结束选择的哨兵项 label。
const MULTI_DONE_LABEL = "✓ 完成选择";

// 依次把每道题经 ui 抛给用户（阻塞等待作答），把结果拼成 `[我的选择]` 文本——
// 与前端 QuestionsCard.formatAnswers 的格式保持一致，模型据此识别为权威答复。
// ctx.ui.select 只支持单选，故多选用「循环 select + 完成哨兵」、自定义用「select 命中后再 input」补回。
export async function collectAnswers(data: QuestionsCardData, ui: AskUserUi): Promise<string> {
  const lines: string[] = [];
  for (let i = 0; i < data.questions.length; i++) {
    const q = data.questions[i];
    const prefix = `${i + 1}. ${q.title}：`;

    // 无选项 → 自由文本。
    if (q.options.length === 0) {
      const t = (await ui.input(q.title, data.extraPlaceholder))?.trim();
      lines.push(`${prefix}${t || "(未填写)"}`);
      continue;
    }

    if (q.allowMultiple) {
      const pickedIds = new Set<string>();
      const picked: string[] = [];
      // 循环：每轮只列未选项 + 完成哨兵，直到用户选「完成」或取消，或无可选项。
      for (;;) {
        const remaining = q.options.filter((o) => !pickedIds.has(o.id));
        if (remaining.length === 0) break;
        const choice = await ui.select(
          `${q.title}（多选；选「${MULTI_DONE_LABEL}」结束）`,
          [...remaining.map((o) => o.label), MULTI_DONE_LABEL],
        );
        if (choice === undefined || choice === MULTI_DONE_LABEL) break;
        const opt = remaining.find((o) => o.label === choice);
        if (!opt) break;
        pickedIds.add(opt.id);
        if (opt.id === CUSTOM_OPTION_ID) {
          const t = (await ui.input(q.title, data.extraPlaceholder))?.trim();
          picked.push(t ? `其他：${t}` : "其他");
        } else {
          picked.push(opt.label);
        }
      }
      lines.push(`${prefix}${picked.length > 0 ? picked.join("、") : "(未选)"}`);
      continue;
    }

    // 单选。
    const choice = await ui.select(q.title, q.options.map((o) => o.label));
    if (choice === undefined) {
      lines.push(`${prefix}(已跳过)`);
      continue;
    }
    const opt = q.options.find((o) => o.label === choice);
    if (opt?.id === CUSTOM_OPTION_ID) {
      const t = (await ui.input(q.title, data.extraPlaceholder))?.trim();
      lines.push(`${prefix}${t ? `其他：${t}` : "其他"}`);
    } else {
      lines.push(`${prefix}${choice}`);
    }
  }

  // 可选补充说明（贴图无法经 ctx.ui 收集，阻塞模式下不提供）。
  if (data.allowExtra) {
    const extra = (await ui.input(data.extraPlaceholder?.trim() || "补充说明（可留空）"))?.trim();
    if (extra) lines.push(`补充说明：${extra}`);
  }

  return `[我的选择]\n${lines.join("\n")}`;
}
