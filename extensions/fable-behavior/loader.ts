import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type FableAgentMode = "agent" | "ask" | "debug" | "plan" | "brainstorm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "prompts");

const KERNEL: ReadonlyArray<{ dir: "tier1" | "tier2"; name: string }> = [
  { dir: "tier1", name: "identity" },
  { dir: "tier1", name: "tone" },
  { dir: "tier1", name: "mistakes" },
  { dir: "tier1", name: "file-verify" },
  { dir: "tier1", name: "coding-harness" },
  { dir: "tier1", name: "autonomy" },
  { dir: "tier2", name: "refusal" },
];

const TIER2_P0 = [
  "tool-discipline",
  "ask-user",
  "grep-strategy",
  "mcp-collaboration",
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

// Opt-in 一行式摘要。前 6 条对应 fable_behavior_ref 的 tier3 模块；review 无独立全文。
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
  /** Opt-in leftover tool manuals. Default off — those belong on promptSnippet / promptGuidelines. */
  tier2?: boolean;
  /** When tier2 is on, also include P1 extended manuals. */
  tier2P1?: boolean;
  /** Opt-in Tier-3 one-line summaries. Default off — full text is fable_behavior_ref. */
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
  const tier2 = opts.tier2 === true;
  const tier2P1 = opts.tier2P1 !== false;
  const tier3 = opts.tier3Guidelines === true;
  const mode = opts.mode ?? "agent";
  const parts: string[] = ["[Fable Behavior]"];

  for (const mod of KERNEL) parts.push(readModule(mod.dir, mod.name));

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
  if (mode === "ask" || mode === "debug" || mode === "plan" || mode === "agent" || mode === "brainstorm") return mode;
  return "agent";
}
