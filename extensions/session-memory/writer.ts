import type { AskFn } from "./llm.js";

const SYSTEM =
  "You maintain a concise working-state summary of a coding session. Given the conversation, output " +
  "GitHub-flavored markdown with EXACTLY these sections (short bullet points): " +
  "'## Intent', '## Next step', '## Task progress', '## Key files', '## Key decisions'. " +
  "If a section has nothing, write '- (none)'. Output only the markdown, no prose around it.";

const COMPACTION_SYSTEM =
  "You maintain a concise working-state summary of a coding session. The earlier part of the conversation " +
  "is about to be removed from the context and your output replaces it. Merge the previous state, the previous " +
  "summary and the conversation into GitHub-flavored markdown with EXACTLY these sections (short bullet points): " +
  "'## Intent', '## Next step', '## Task progress', '## Key files', '## Key decisions'. " +
  "Keep every fact needed to continue: user requirements and constraints, finished and pending steps, file paths, " +
  "decisions with their reasons, unresolved errors. Drop details that no longer matter. " +
  "Messages after this point are kept verbatim and do not need to be restated. " +
  "If a section has nothing, write '- (none)'. Output only the markdown, no prose around it.";

export interface CompactionStateInput {
  prevState?: string;
  previousSummary?: string;
  /** 已序列化的待丢弃对话。 */
  conversation: string;
  /** 切在一轮中间时，这一轮前半段的序列化文本。 */
  turnPrefix?: string;
}

export function buildCompactionPrompt(input: CompactionStateInput): string {
  const parts: string[] = [];
  if (input.prevState?.trim()) parts.push(`<previous-state>\n${input.prevState.trim()}\n</previous-state>`);
  if (input.previousSummary?.trim()) {
    parts.push(`<previous-summary>\n${input.previousSummary.trim()}\n</previous-summary>`);
  }
  parts.push(`<conversation>\n${input.conversation}\n</conversation>`);
  if (input.turnPrefix?.trim()) {
    parts.push(
      "The kept messages start in the middle of the following turn. " +
        "Cover the user's request in this turn and the progress so far.\n" +
        `<current-turn-prefix>\n${input.turnPrefix}\n</current-turn-prefix>`,
    );
  }
  return parts.join("\n\n");
}

/** 压缩时的抽取。失败或空输出返回 undefined，由调用方交给 Pi；不回退到旧状态。 */
export async function extractCompactionState(ask: AskFn, input: CompactionStateInput): Promise<string | undefined> {
  try {
    const out = (await ask(COMPACTION_SYSTEM, buildCompactionPrompt(input))).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Extract structured state markdown. On empty/failed output, keep `prev` (graceful). */
export async function extractState(ask: AskFn, transcript: string, prev?: string): Promise<string | undefined> {
  try {
    const user = prev
      ? `Previous state:\n${prev}\n\nConversation (most recent last):\n${transcript}`
      : `Conversation (most recent last):\n${transcript}`;
    const out = (await ask(SYSTEM, user)).trim();
    return out.length > 0 ? out : prev;
  } catch {
    return prev;
  }
}
