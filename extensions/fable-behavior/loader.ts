import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type FableAgentMode = "agent" | "ask" | "debug" | "plan";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "prompts");

const TIER1 = [
  "identity",
  "tone",
  "mistakes",
  "file-verify",
  "coding-harness",
  "autonomy",
] as const;

const TIER2_P0 = [
  "tool-discipline",
  "ask-user",
  "grep-strategy",
  "mcp-collaboration",
  "refusal",
  "skills-first",
  "file-workflow",
] as const;

const TIER2_P1 = [
  "conventions-first",
  "verify-baseline",
  "git-hygiene",
  "editing-constraints",
  "delegation",
  "terminal-harness",
  "knowledge-search-triggers",
] as const;

// 始终注入的一行式提示。前 6 条各对应一个可经 fable_behavior_ref 取全文的 tier3 模块；
// 最后一条 review 是无独立模块的独立行为提示。grep/ask-user/mcp/security 的一行式已删除——
// 它们的完整内容已在 tier2 P0（grep-strategy/ask-user/mcp-collaboration/refusal）常驻注入，再放摘要纯属重复。
const TIER3_SUMMARY_LINES = [
  "Web search: paraphrase by default; one short quote per source max; scale searches to task complexity.",
  "Copyright: never reproduce lyrics/poems/long verbatim passages from web sources.",
  "Wellbeing: no diagnoses; no fostering harm; proportionate on sensitive topics.",
  "Evenhandedness: balanced coverage on contested topics.",
  "Code citations: use startLine:endLine:filepath for existing code (see citing-code reference).",
  "Frontend (greenfield): intentional typography/color/motion; avoid generic AI layouts; respect existing design systems.",
  "Review requests: findings first by severity with file:line refs; brief summary only after issues.",
] as const;

export const TIER3_TOPICS = [
  "search-full",
  "copyright",
  "wellbeing",
  "evenhandedness",
  "citing-code",
  "frontend-design",
] as const;

export type Tier3Topic = (typeof TIER3_TOPICS)[number];

function readModule(subdir: string, name: string): string {
  return readFileSync(join(ROOT, subdir, `${name}.md`), "utf8").trim();
}

/** Read a full Tier-3 reference module (on-demand via fable_behavior_ref tool). */
export function readTier3Module(topic: string): string | undefined {
  if (!(TIER3_TOPICS as readonly string[]).includes(topic)) return undefined;
  return readModule("tier3", topic);
}

function readModeSlice(mode: FableAgentMode): string {
  try {
    return readModule("modes", mode);
  } catch {
    return "";
  }
}

export interface BuildPromptOptions {
  tier2?: boolean;
  /** When false, inject only Tier-2 P0 (core harness); skip P1 extended modules. */
  tier2P1?: boolean;
  tier3Guidelines?: boolean;
  mode?: FableAgentMode;
  date?: string;
}

/** Rough token estimate (chars / 4) for budgeting. */
export function estimatePromptTokens(opts: BuildPromptOptions = {}): number {
  return Math.ceil(buildFableBehaviorPrompt(opts).length / 4);
}

/** Assemble the fable-behavior injection block for before_agent_start. */
export function buildFableBehaviorPrompt(opts: BuildPromptOptions = {}): string {
  const tier2 = opts.tier2 !== false;
  const tier2P1 = opts.tier2P1 !== false;
  const tier3 = opts.tier3Guidelines !== false;
  const mode = opts.mode ?? "agent";
  const parts: string[] = ["[Fable Behavior]"];

  for (const name of TIER1) parts.push(readModule("tier1", name));

  if (tier2) {
    for (const name of TIER2_P0) parts.push(readModule("tier2", name));
    if (tier2P1) {
      for (const name of TIER2_P1) parts.push(readModule("tier2", name));
    }
  }

  const modeSlice = readModeSlice(mode);
  if (modeSlice) parts.push(modeSlice);

  if (tier3) {
    parts.push("## Quick reference\n" + TIER3_SUMMARY_LINES.map((l) => `- ${l}`).join("\n"));
  }

  if (opts.date) parts.push(`Current date: ${opts.date}`);

  return parts.filter(Boolean).join("\n\n");
}

export function resolveAgentModeFromEntries(
  entries: Array<{ type?: string; customType?: string; data?: unknown }>,
): FableAgentMode {
  const entry = entries.filter((e) => e.type === "custom" && e.customType === "agent-mode").pop();
  const mode = (entry?.data as { mode?: string } | undefined)?.mode;
  if (mode === "ask" || mode === "debug" || mode === "plan" || mode === "agent") return mode;
  return "agent";
}
