import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Official `getThemesDir()` layouts: bun-binary `theme/`, or src|dist `modes/interactive/theme/`. */
export function hasPiThemes(packageDir: string, exists: (path: string) => boolean = existsSync): boolean {
  return (
    exists(join(packageDir, "theme", "dark.json")) ||
    exists(join(packageDir, "dist", "modes", "interactive", "theme", "dark.json")) ||
    exists(join(packageDir, "src", "modes", "interactive", "theme", "dark.json"))
  );
}

function packageRootFrom(startDir: string): string | undefined {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      const parent = dirname(dir);
      if (basename(dir) === "dist" && existsSync(join(parent, "package.json"))) return parent;
      return dir;
    }
    dir = dirname(dir);
  }
  return undefined;
}

function walkNodeModules(fromDir: string): string | undefined {
  let dir = fromDir;
  while (dir !== dirname(dir)) {
    const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(join(candidate, "package.json"))) return candidate;
    dir = dirname(dir);
  }
  return undefined;
}

function thisModuleDir(): string | undefined {
  const metaUrl = import.meta.url;
  if (typeof metaUrl !== "string" || metaUrl.length === 0) return undefined;
  try {
    return dirname(fileURLToPath(metaUrl));
  } catch {
    return undefined;
  }
}

export function resolveInstalledPiPackageDir(): string | undefined {
  try {
    const resolved = import.meta.resolve("@earendil-works/pi-coding-agent");
    const fromEntry = packageRootFrom(dirname(fileURLToPath(resolved)));
    if (fromEntry) return fromEntry;
  } catch {
    /* CJS/exports or compiled binary: fall through to node_modules walk */
  }
  return walkNodeModules(thisModuleDir() ?? process.cwd());
}

/**
 * `PI_PACKAGE_DIR` used to point at a compiled host root (`cli/` in bun-dev).
 * Official `main()` then treats that as the pi-coding-agent package and looks
 * for themes at `src/modes/interactive/theme` because `cli/src` exists — which
 * throws ENOENT on dark.json.
 *
 * Keep the env dir when it already has themes. Otherwise retarget to the
 * installed npm package.
 */
export function resolveOfficialMainPackageDir(
  envDir: string | undefined,
  installedDir: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const trimmed = envDir?.trim();
  if (trimmed && hasPiThemes(trimmed, exists)) return trimmed;
  if (installedDir && hasPiThemes(installedDir, exists)) return installedDir;
  return trimmed || installedDir;
}

export function applyOfficialMainPackageDir(
  env: NodeJS.ProcessEnv,
  installedDir: string | undefined = resolveInstalledPiPackageDir(),
  exists: (path: string) => boolean = existsSync,
): void {
  const next = resolveOfficialMainPackageDir(env.PI_PACKAGE_DIR, installedDir, exists);
  if (next) env.PI_PACKAGE_DIR = next;
}
