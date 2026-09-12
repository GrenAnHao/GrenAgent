const MAX_CONDITION_LENGTH = 4000;

export type ParseGoalResult =
  | { type: "query" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "clear" }
  | { type: "create"; condition: string }
  | { type: "edit"; condition: string }
  | { type: "error"; code: "MISSING_CONDITION" | "INVALID_PARAMS" };

export function parseGoalArgs(args: string): ParseGoalResult {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    return { type: "query" };
  }

  const lower = trimmed.toLowerCase();

  if (lower === "pause") return { type: "pause" };
  if (lower === "resume") return { type: "resume" };
  if (lower === "clear" || lower === "reset") return { type: "clear" };
  if (lower === "edit") return { type: "error", code: "MISSING_CONDITION" };

  const editMatch = trimmed.match(/^edit\s+(.*)$/i);
  if (editMatch) {
    const condition = editMatch[1].trim();
    if (condition.length === 0) {
      return { type: "error", code: "MISSING_CONDITION" };
    }
    if (condition.length > MAX_CONDITION_LENGTH) {
      return { type: "error", code: "INVALID_PARAMS" };
    }
    return { type: "edit", condition };
  }

  if (trimmed.length > MAX_CONDITION_LENGTH) {
    return { type: "error", code: "INVALID_PARAMS" };
  }
  return { type: "create", condition: trimmed };
}
