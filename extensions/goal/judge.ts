import { flattenTranscript } from "../_shared/transcript.js";

export { flattenTranscript };

export interface JudgeResult {
  verdict: "pass" | "fail" | "error";
  reason: string;
}

export type Verdict = JudgeResult;

export function buildJudgeUser(condition: string, transcript: string): string {
  return `Completion condition:\n${condition}\n\nTranscript (most recent last):\n${transcript}`;
}

export function parseVerdict(raw: string): JudgeResult {
  let parsed: { verdict?: string; reason?: string };
  try {
    parsed = JSON.parse(raw) as { verdict?: string; reason?: string };
  } catch {
    return { verdict: "error", reason: "裁判输出无法解析" };
  }
  if (typeof parsed.reason !== "string" || parsed.reason.trim() === "") return { verdict: "error", reason: "裁判输出缺少原因" };
  if (parsed.verdict === "not_ok" || parsed.verdict === "fail") return { verdict: "fail", reason: parsed.reason };
  if (parsed.verdict === "ok" || parsed.verdict === "pass") return { verdict: "pass", reason: parsed.reason };
  return { verdict: "error", reason: "裁判输出无法解析" };
}
