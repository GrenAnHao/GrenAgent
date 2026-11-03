/** SystemWorkerManager.serviceTaskPrompt 的固定骨架：指令 + Task kind + Input JSON。 */
const TASK_INPUT_RE = /\nTask kind: [a-z][a-z0-9_]*\nInput: /;

export function isSystemWorkerPrompt(text: string): boolean {
  return TASK_INPUT_RE.test(text);
}

export function parseSystemWorkerInput(text: string): unknown | undefined {
  const match = TASK_INPUT_RE.exec(text);
  if (!match) return undefined;
  const raw = text.slice(match.index + match[0].length).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
