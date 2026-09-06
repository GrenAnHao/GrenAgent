import { flattenTranscript } from "../_shared/transcript.js";
import type { AskFn } from "./llm.js";

export { flattenTranscript };

export type JudgeResult =
  | { kind: "pass"; reason: string }
  | { kind: "fail"; reason: string; missing: string[] }
  | { kind: "error"; reason: string };

export type Verdict = JudgeResult;

export interface LegacyVerdict { ok: boolean; reason: string }

export function buildJudgeUser(condition: string, transcript: string): string {
  return `Completion condition:\n${condition}\n\nTranscript (most recent last):\n${transcript}`;
}

export function parseVerdict(raw: string): JudgeResult {
  let parsed: { verdict?: unknown; reason?: unknown; missing?: unknown };
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "error", reason: "裁判输出无法解析" };
    parsed = value as typeof parsed;
  } catch {
    return { kind: "error", reason: "裁判输出无法解析" };
  }
  if (typeof parsed.reason !== "string" || parsed.reason.trim() === "") return { kind: "error", reason: "裁判输出缺少原因" };
  if (parsed.verdict === "not_ok" || parsed.verdict === "fail") {
    const missing = parsed.missing;
    if (!Array.isArray(missing) || !missing.every((item) => typeof item === "string")) return { kind: "error", reason: "裁判输出缺少缺失项" };
    return { kind: "fail", reason: parsed.reason, missing };
  }
  if (parsed.verdict === "ok" || parsed.verdict === "pass") return { kind: "pass", reason: parsed.reason };
  return { kind: "error", reason: "裁判输出无法解析" };
}

/** @deprecated Use the coordinator and parseVerdict; retained for the legacy extension entrypoint. */
export async function judge(ask: AskFn, messages: unknown[], condition: string, maxChars = 12000): Promise<LegacyVerdict> {
  try {
    const transcript = flattenTranscript(messages, maxChars);
    const raw = await ask("", buildJudgeUser(condition, transcript));
    const result = parseVerdict(raw);
    return result.kind === "pass" ? { ok: true, reason: result.reason } : { ok: false, reason: result.reason };
  } catch {
    return { ok: false, reason: "裁判调用失败" };
  }
}
