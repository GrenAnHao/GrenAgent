import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { seedAgentTemplates, seedModeFromConfig } from "../_shared/seed-agents.js";
import { DEFAULT_AGENT_TEMPLATES } from "./default-agents.js";

/** Seed version — bump when enriched templates change materially (diagnostic only). */
export const FABLE_AGENT_SEED_VERSION = "2026-06-27";

/**
 * Seed enriched agent templates into ~/.pi/agent/agents/, self-healing on template
 * drift without clobbering user edits (see _shared/seed-agents.ts). Best-effort:
 * a seeding failure must never break extension load.
 */
export function seedFableAgents(): void {
  try {
    const r = seedAgentTemplates({
      templates: DEFAULT_AGENT_TEMPLATES,
      dir: join(getAgentDir(), "agents"),
      manifestFile: ".fable-behavior-seed-version",
      version: FABLE_AGENT_SEED_VERSION,
      mode: seedModeFromConfig(getConfig("FABLE_BEHAVIOR_SEED_AGENTS")),
    });
    if (r.upgraded.length) console.error(`[fable-behavior] upgraded default agents: ${r.upgraded.join(", ")}`);
    if (r.preserved.length) console.error(`[fable-behavior] preserved user-edited agents: ${r.preserved.join(", ")}`);
  } catch {
    /* best-effort */
  }
}
