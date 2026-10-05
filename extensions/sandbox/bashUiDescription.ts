import { Type, type TProperties } from "typebox";

const DESCRIPTION =
  'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status".';

const GUIDELINE =
  "Always set `description` to 5-10 words of what the command does (shown in the UI); do not put the raw command there.";

// 输出是流式进卡片的；`-Last` / `tail` 要等命令结束才知道哪几行是最后，卡片会一直空到退出。
// `Select-String` / `grep` 把进度行全筛掉，构建成功前一行都不匹配，效果同样是空卡片。
const STREAMING_GUIDELINE =
  "bash streams output into the UI and already keeps only the tail of long output (the full log is saved to a temp file), so run long commands (builds, tests) unfiltered: do not pipe them through `Select-Object -Last`, `tail`, or `Out-String`, which hold every line until exit, or through `Select-String`, `grep`, or `findstr`, which drop progress lines and leave the card empty; search the saved log afterwards instead.";

const TOOL_DESCRIPTION_NOTE =
  " The `description` argument is required and shown in the UI as the collapsed summary (5-10 words). Do not put the raw command there.";

function hasCommandParameter(value: unknown): value is { properties: Record<string, unknown> } {
  if (!value || typeof value !== "object") return false;
  if (!("properties" in value)) return false;
  const properties = (value as { properties?: unknown }).properties;
  return Boolean(properties && typeof properties === "object" && "command" in properties);
}

/**
 * Require a short UI description on bash so the collapsed row can show what
 * the command does instead of the raw command line.
 */
export function withBashUiDescription<
  T extends { parameters?: unknown; promptGuidelines?: readonly string[]; description?: string },
>(def: T): T & { promptGuidelines: string[] } {
  if (!hasCommandParameter(def.parameters)) return def as T & { promptGuidelines: string[] };
  const properties = def.parameters.properties;
  const { command, ...rest } = properties;
  return {
    ...def,
    description: `${def.description ?? ""}${TOOL_DESCRIPTION_NOTE}`,
    parameters: Type.Object({
      description: Type.String({ description: DESCRIPTION }),
      ...(command !== undefined ? { command } : {}),
      ...rest,
    } as TProperties),
    promptGuidelines: [...(def.promptGuidelines ?? []), GUIDELINE, STREAMING_GUIDELINE],
  };
}
