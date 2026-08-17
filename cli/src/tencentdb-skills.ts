import { readMemoryConnectionConfig } from "../../extensions/tencentdb-memory/client.js";
import {
  createSkillClient,
  fetchRemoteSkills,
  hasMatchingSkillScope,
  syncSkills,
} from "../../extensions/tencentdb-skills/sync.js";
import { getConfig } from "../../extensions/_shared/runtime-config.js";

export interface ManagedSkillLoaderOptions {
  noSkills: true;
  additionalSkillPaths: string[];
}

export function managedSkillLoaderOptions(root: string | undefined): ManagedSkillLoaderOptions {
  return {
    noSkills: true,
    additionalSkillPaths: root ? [root] : [],
  };
}

export function withManagedSkillArgs(argv: string[], root: string | undefined): string[] {
  const sanitized: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skill") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--skill=") || arg === "--no-skills" || arg === "-ns") continue;
    sanitized.push(arg);
  }
  return ["--no-skills", ...(root ? ["--skill", root] : []), ...sanitized];
}

export async function reloadManagedSkills(
  sync: () => Promise<unknown>,
  reload: () => Promise<unknown>,
): Promise<void> {
  await sync();
  await reload();
}

/** Pull remote Skills before resource loading; keep the prior managed cache on failure. */
export async function syncConfiguredSkills(): Promise<string | undefined> {
  const root = getConfig("TDAI_SKILLS_ROOT")?.trim();
  const scope = getConfig("TDAI_SKILLS_SCOPE")?.trim();
  if (!root || !scope || getConfig("TDAI_SKILLS_SYNC") !== "1") return undefined;
  try {
    const config = readMemoryConnectionConfig();
    const client = createSkillClient(config);
    const timeoutMs = Number.parseInt(getConfig("TDAI_SKILLS_SYNC_TIMEOUT_MS") ?? "12000", 10);
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 12000;
    const skills = await Promise.race([
      fetchRemoteSkills(client, {
        teamId: config.teamId,
        agentId: config.agentId,
        userId: config.userId,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`skill sync timed out after ${budget}ms`)), budget).unref?.();
      }),
    ]);
    const result = await syncSkills(root, scope, skills);
    console.error(`[tencentdb-skills] synced ${result.synced.length} skills revision=${result.revision}`);
  } catch (error) {
    if (!(await hasMatchingSkillScope(root, scope))) {
      console.error(`[tencentdb-skills] sync failed; no cache is available for the current scope: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    console.error(`[tencentdb-skills] sync failed; using same-scope cached skills: ${error instanceof Error ? error.message : String(error)}`);
  }
  return root;
}
