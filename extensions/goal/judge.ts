import { flattenTranscript } from "../_shared/transcript.js";
import { parseJsonLoose } from "./llm.js";

export { flattenTranscript };

export interface JudgeResult {
  verdict: "pass" | "fail" | "error";
  reason: string;
}

export type Verdict = JudgeResult;

const JUDGE_SYSTEM =
  "You are a strict independent judge. Decide whether the assistant has ACTUALLY satisfied the user's stated " +
  "completion condition, based solely on concrete evidence in the transcript. Rules: " +
  "(1) Do NOT trust self-claims like 'done' or 'completed' without concrete evidence (real file edits, command output, or the produced deliverable). " +
  "(2) If the assistant only greeted, introduced itself, asked questions, made a plan, or did no substantive work toward the condition, the verdict is not_ok. " +
  "(3) The specific deliverable named in the condition must actually be present in the transcript. " +
  'Output STRICT JSON only (no prose): {"verdict":"ok"|"not_ok","reason":string}. ok = condition fully and verifiably met; ' +
  "not_ok = anything less. For not_ok, reason must state what is still missing.";

export function buildJudgeUser(condition: string, transcript: string): string {
  return `Completion condition:\n${condition}\n\nTranscript (most recent last):\n${transcript}`;
}

export function parseVerdict(raw: string): JudgeResult {
  const parsed = parseJsonLoose<{ verdict?: string; reason?: string }>(raw);
  if (parsed?.verdict === "not_ok" || parsed?.verdict === "fail") return { verdict: "fail", reason: parsed.reason ?? "条件未满足" };
  if (parsed?.verdict === "ok" || parsed?.verdict === "pass") return { verdict: "pass", reason: parsed.reason ?? "条件已满足" };
  if (/\bnot[_\s-]?ok\b/i.test(raw)) return { verdict: "fail", reason: raw.trim().slice(0, 200) || "条件未满足" };
  return { verdict: "error", reason: "裁判输出无法解析" };
}
