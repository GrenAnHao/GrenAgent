import { describe, expect, it } from "vitest";
import { chainSummaryTitle, TITLE_MAX_TOKENS } from "./title.js";

const INSTRUCTION = "D:\\OneDrive\\Project Files\\Pi\\docs\\superpowers\\specs\\2026-10-04-context-checkpoint-prune-design.md 审这个规格";

describe("chainSummaryTitle", () => {
  it("系统提示要求直接回标题，并写入 locale", () => {
    const { system, user } = chainSummaryTitle(INSTRUCTION, "zh-CN");
    expect(system).toBe(`You are a professional conversation summarizer. Generate a concise title that captures the essence of the conversation.

Rules:
- Reply with only the title
- No explanations
- Maximum 15 words
- Maximum 80 characters
- No punctuation marks
- Use the language specified by the locale code: zh-CN
- The title should accurately reflect the main topic of the conversation
- Keep it short and to the point`);
    expect(user).toBe(
      "<task>\nGenerate a concise title that captures the essence of the conversation.\n</task>\n\n<conversation>\n"
      + `<user>\n${INSTRUCTION}\n</user>\n</conversation>`,
    );
    expect(TITLE_MAX_TOKENS).toBe(64);
  });
});
