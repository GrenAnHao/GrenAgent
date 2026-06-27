// 把默认 persona 播种到 ~/.pi/agent/agents/{dream,distill}.md，自愈升级我们写过且未被
// 用户改动的副本（见 _shared/seed-agents.ts），保留用户自定义。
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { seedAgentTemplates, seedModeFromConfig } from "../_shared/seed-agents.js";
import { DISTILL_PERSONA, DREAM_PERSONA } from "./personas.js";

export const SELF_EVOLVE_SEED_VERSION = "2026-06-27";

export function seedPersonas(): void {
  try {
    const r = seedAgentTemplates({
      templates: { dream: DREAM_PERSONA, distill: DISTILL_PERSONA },
      dir: join(getAgentDir(), "agents"),
      manifestFile: ".self-evolve-seed-version",
      version: SELF_EVOLVE_SEED_VERSION,
      mode: seedModeFromConfig(getConfig("SELF_EVOLVE_SEED")),
    });
    if (r.upgraded.length) console.error(`[self-evolve] upgraded personas: ${r.upgraded.join(", ")}`);
    if (r.preserved.length) console.error(`[self-evolve] preserved user-edited personas: ${r.preserved.join(", ")}`);
  } catch {
    /* best-effort */
  }
}
