// Shared, self-healing seeder for managed agent templates (fable defaults +
// self-evolve personas). The old behavior ("write only if the file is absent")
// meant a template change never reached an already-seeded machine — the stale
// copy lingered forever. This seeder instead tracks a content hash per file in a
// JSON manifest so it can UPGRADE the templates it previously wrote while never
// clobbering a file the user has since edited.
//
// Modes (config value → mode):
//   "0"        → off       : no-op.
//   "if-absent"→ if-absent : only create missing files (never overwrite). Opt-out
//                            for users who hand-manage the global defaults.
//   "force"    → force     : overwrite every template (and record hashes).
//   else/"1"   → auto      : create missing; upgrade files we previously wrote that
//                            are still unmodified (disk hash == recorded hash) when
//                            the template content drifts; preserve user-edited files.
//
// Migration (manifest absent or has no per-file hashes — i.e. an install seeded by
// the old plain-text marker): the managed default names present on disk were seeded
// by us (users customize via project `.pi/agents` or differently-named agents), so
// `auto` adopts and upgrades them once, then tracks hashes going forward.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SeedMode = "off" | "if-absent" | "auto" | "force";

export interface SeedAgentsOptions {
  /** Agent name → markdown content (frontmatter + body). */
  templates: Record<string, string>;
  /** Absolute path to the agents directory (e.g. <agentDir>/agents). */
  dir: string;
  /** Manifest file name inside `dir` (e.g. ".fable-behavior-seed.json"). */
  manifestFile: string;
  /** Current template-set version; stored for diagnostics. */
  version: string;
  mode: SeedMode;
}

export interface SeedAgentsResult {
  /** Newly created (file was absent). */
  wrote: string[];
  /** Overwritten because it was an unmodified copy we previously wrote (or first-run migration). */
  upgraded: string[];
  /** Skipped because the on-disk file differs from what we last wrote (user-edited). */
  preserved: string[];
}

interface SeedManifest {
  version: string;
  hashes: Record<string, string>;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function readFileOrEmpty(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Parse the manifest, tolerating the legacy plain-text version marker (→ no hashes). */
function readManifest(file: string): SeedManifest | undefined {
  const raw = readFileOrEmpty(file).trim();
  if (!raw) return undefined;
  if (raw.startsWith("{")) {
    try {
      const m = JSON.parse(raw) as Partial<SeedManifest>;
      if (m && typeof m.version === "string") {
        return { version: m.version, hashes: m.hashes && typeof m.hashes === "object" ? m.hashes : {} };
      }
    } catch {
      /* fall through */
    }
    return undefined;
  }
  // Legacy plain-text marker: just a version string, no per-file hashes.
  return { version: raw, hashes: {} };
}

/**
 * Seed/upgrade managed agent templates without clobbering user edits. Pure of any
 * config/agentDir lookups (caller resolves those) so it is fully unit-testable.
 */
export function seedAgentTemplates(opts: SeedAgentsOptions): SeedAgentsResult {
  const result: SeedAgentsResult = { wrote: [], upgraded: [], preserved: [] };
  if (opts.mode === "off") return result;

  mkdirSync(opts.dir, { recursive: true });
  const manifestPath = join(opts.dir, opts.manifestFile);
  const prev = readManifest(manifestPath);
  // First migration = we've never recorded per-file hashes here (fresh install, or
  // an install still on the legacy plain-text marker).
  const firstMigration = !prev || Object.keys(prev.hashes).length === 0;
  const hashes: Record<string, string> = { ...(prev?.hashes ?? {}) };

  for (const [name, content] of Object.entries(opts.templates)) {
    const file = join(opts.dir, `${name}.md`);
    const curHash = sha256(content);

    if (!existsSync(file)) {
      writeFileSync(file, content, "utf8");
      hashes[name] = curHash;
      result.wrote.push(name);
      continue;
    }

    if (opts.mode === "if-absent") continue; // present → never overwrite

    if (opts.mode === "force") {
      writeFileSync(file, content, "utf8");
      hashes[name] = curHash;
      result.upgraded.push(name);
      continue;
    }

    // auto
    const diskHash = sha256(readFileOrEmpty(file));
    if (diskHash === curHash) {
      hashes[name] = curHash; // already current → claim/refresh ownership
      continue;
    }
    const recorded = prev?.hashes?.[name];
    // We own the file when its content matches the hash we last wrote; on the first
    // migration (no recorded hashes) the managed defaults present on disk were seeded
    // by us, so adopt them.
    const ours = recorded !== undefined ? diskHash === recorded : firstMigration;
    if (ours) {
      writeFileSync(file, content, "utf8");
      hashes[name] = curHash;
      result.upgraded.push(name);
    } else {
      result.preserved.push(name); // user-edited since our last write → keep
    }
  }

  writeFileSync(manifestPath, `${JSON.stringify({ version: opts.version, hashes }, null, 2)}\n`, "utf8");
  return result;
}

/** Map a raw config value to a SeedMode (shared by both seeders). */
export function seedModeFromConfig(value: string | undefined): SeedMode {
  if (value === "0" || value === "off") return "off";
  if (value === "force") return "force";
  if (value === "if-absent") return "if-absent";
  return "auto";
}
