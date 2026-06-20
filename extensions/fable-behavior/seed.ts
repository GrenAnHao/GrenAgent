import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { DEFAULT_AGENT_TEMPLATES } from "./default-agents.js";

/** Seed version — bump when enriched templates change materially. */
export const FABLE_AGENT_SEED_VERSION = "2026-06-20";

type SeedMode = "off" | "if-absent" | "force";

function seedMode(): SeedMode {
  const v = getConfig("FABLE_BEHAVIOR_SEED_AGENTS") ?? "1";
  if (v === "0") return "off";
  if (v === "force") return "force";
  return "if-absent";
}

/** Seed enriched agent templates into ~/.pi/agent/agents/. */
export function seedFableAgents(): void {
  const mode = seedMode();
  if (mode === "off") return;
  try {
    const dir = join(getAgentDir(), "agents");
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(DEFAULT_AGENT_TEMPLATES)) {
      const file = join(dir, `${name}.md`);
      if (mode === "if-absent" && existsSync(file)) continue;
      writeFileSync(file, content, "utf8");
    }
    writeFileSync(join(dir, ".fable-behavior-seed-version"), `${FABLE_AGENT_SEED_VERSION}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}
