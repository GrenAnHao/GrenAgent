/** LobeHub packages/prompts/src/chains/summaryTitle.ts，输出改为直接回标题。 */
export const TOPIC_TITLE_PROMPT_VERSION = "v1";

/** 标题最多约 15 个词 / 80 字。用请求的 maxTokens 卡住，避免按模型默认输出上限计费。 */
export const TITLE_MAX_TOKENS = 64;

export function titleLocale(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale && locale !== "und") return locale;
  } catch {
    // Intl 不可用时跟产品界面语言。
  }
  return "zh-CN";
}

/**
 * chainSummaryTitle。对话里只放最初那条用户指令。
 * 「返回 JSON」改成直接回标题；整段用户消息控制在摘要输入上限以内。
 */
export function chainSummaryTitle(
  instruction: string,
  locale: string,
): { system: string; user: string } {
  const head = "<task>\nGenerate a concise title that captures the essence of the conversation.\n</task>\n\n<conversation>\n<user>\n";
  const tail = "\n</user>\n</conversation>";
  const body = instruction.trim().slice(0, Math.max(0, 4000 - head.length - tail.length));
  return {
    system: `You are a professional conversation summarizer. Generate a concise title that captures the essence of the conversation.

Rules:
- Reply with only the title
- No explanations
- Maximum 15 words
- Maximum 80 characters
- No punctuation marks
- Use the language specified by the locale code: ${locale}
- The title should accurately reflect the main topic of the conversation
- Keep it short and to the point`,
    user: `${head}${body}${tail}`,
  };
}
