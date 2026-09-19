// Packaged-ripgrep seam (DeepSeek Harness grep/glob engine, minus Cordis).
// Spawn `@vscode/ripgrep` with a plain argv vector — no shell, `--no-config`
// so a host RIPGREP_CONFIG_PATH cannot inject `--pre`.
import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { SKIP_DIRS } from "./fs-walk.js";
import { previewLine, GREP_MAX_MATCHES } from "./output-retention.js";

/** Extra exclusion globs even when a file is not gitignored. */
export const RG_SKIP_GLOBS = [
  "!*.tsbuildinfo",
  "!*.map",
  "!*.min.js",
  "!*.min.css",
  "!*.min.mjs",
  ...[...SKIP_DIRS].map((d) => `!**/${d}/**`),
] as const;

export const RAW_OUTPUT_MAX_BYTES = 20_000_000;
export const SEARCH_TIMEOUT_MS = 30_000;

export interface RgHit {
  path: string;
  line: number;
  text: string;
  isMatch: boolean;
}

export interface GrepArgvOpts {
  patterns: string[];
  path: string;
  globs?: string[];
  ignoreCase?: boolean;
  literal?: boolean;
  contextLines?: number;
  maxFilesize?: number;
}

export function buildGrepArgv(opts: GrepArgvOpts): string[] {
  const argv: string[] = ["--json"];
  if (opts.literal) argv.push("--fixed-strings");
  if (opts.ignoreCase) argv.push("--ignore-case");
  if (opts.contextLines && opts.contextLines > 0) argv.push(`--context=${opts.contextLines}`);
  if (opts.maxFilesize && opts.maxFilesize > 0) argv.push(`--max-filesize=${opts.maxFilesize}`);
  for (const p of opts.patterns) argv.push(`--regexp=${p}`);
  for (const g of opts.globs ?? []) argv.push(`--glob=${g}`);
  for (const g of RG_SKIP_GLOBS) argv.push(`--glob=${g}`);
  argv.push("--", opts.path);
  return argv;
}

export function buildFilesArgv(opts: { path: string; globs?: string[] }): string[] {
  const argv: string[] = ["--files"];
  for (const g of opts.globs ?? []) argv.push(`--glob=${g}`);
  for (const g of RG_SKIP_GLOBS) argv.push(`--glob=${g}`);
  argv.push("--", opts.path);
  return argv;
}

export function parseRgJsonLine(line: string): RgHit | undefined {
  const s = line.trim();
  if (!s) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as { type?: unknown; data?: unknown };
  if (record.type !== "match" && record.type !== "context") return undefined;
  if (typeof record.data !== "object" || record.data === null) return undefined;
  const data = record.data as { path?: unknown; line_number?: unknown; lines?: unknown };
  const pathText = typeof data.path === "object" && data.path !== null ? (data.path as { text?: unknown }).text : undefined;
  if (typeof pathText !== "string") return undefined;
  if (typeof data.line_number !== "number") return undefined;
  if (typeof data.lines !== "object" || data.lines === null) return undefined;
  const lines = data.lines as { text?: unknown; bytes?: unknown };
  let text: string;
  if (typeof lines.text === "string") text = lines.text.replace(/\r?\n$/, "");
  else if (typeof lines.bytes === "string") text = "(line is not valid UTF-8)";
  else return undefined;
  return { path: pathText, line: data.line_number, text, isMatch: record.type === "match" };
}

let rgPathPromise: Promise<string | null> | undefined;

/** Lazy resolve so a missing platform package does not fail extension load. */
export function resolveRgPath(): Promise<string | null> {
  rgPathPromise ??= import("@vscode/ripgrep")
    .then((mod) => (typeof mod.rgPath === "string" && mod.rgPath ? mod.rgPath : null))
    .catch(() => null);
  return rgPathPromise;
}

/** Test-only. */
export function __resetRgPathForTest(): void {
  rgPathPromise = undefined;
}

export interface RipgrepRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runRipgrep(
  argv: readonly string[],
  opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number; maxStdoutBytes?: number },
): Promise<RipgrepRun | null> {
  const rgPath = await resolveRgPath();
  if (!rgPath) return null;
  const maxStdout = opts.maxStdoutBytes ?? RAW_OUTPUT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
  return new Promise((resolveRun, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let settled = false;
    const child = spawn(rgPath, ["--no-config", ...argv], {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onAbort = () => {
      child.kill("SIGTERM");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolveRun({ stdout, stderr, exitCode });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        child.kill("SIGTERM");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

export function hitsToGroups(
  hits: RgHit[],
  cwd: string,
  maxMatches: number,
): { groups: { file: string; hits: Array<{ line: number; text: string; isMatch: boolean }> }[]; total: number; capped: boolean } {
  const filtered: RgHit[] = [];
  let matchCount = 0;
  let capped = false;
  for (const h of hits) {
    if (h.isMatch) {
      if (matchCount >= maxMatches) {
        capped = true;
        break;
      }
      matchCount++;
    }
    filtered.push(h);
  }
  const groups: { file: string; hits: Array<{ line: number; text: string; isMatch: boolean }> }[] = [];
  const byFile = new Map<string, Array<{ line: number; text: string; isMatch: boolean }>>();
  for (const h of filtered) {
    const abs = isAbsolute(h.path) ? h.path : join(cwd, h.path);
    const disp = relative(cwd, abs) || h.path;
    const row = { line: h.line, text: previewLine(h.text), isMatch: h.isMatch };
    const list = byFile.get(disp);
    if (list) list.push(row);
    else {
      const next = [row];
      byFile.set(disp, next);
      groups.push({ file: disp, hits: next });
    }
  }
  return { groups, total: matchCount, capped };
}

export async function grepWithRg(
  opts: GrepArgvOpts & { cwd: string; maxMatches?: number; signal?: AbortSignal },
): Promise<{
  groups: { file: string; hits: Array<{ line: number; text: string; isMatch: boolean }> }[];
  total: number;
  capped: boolean;
  error?: string;
} | null> {
  const run = await runRipgrep(buildGrepArgv(opts), { cwd: opts.cwd, signal: opts.signal });
  if (!run) return null;
  // 0 = matches, 1 = no matches, else pattern/IO error.
  if (run.exitCode > 1) {
    const stderr = run.stderr.trim();
    return { groups: [], total: 0, capped: false, error: stderr || `ripgrep exited ${run.exitCode}` };
  }
  const hits: RgHit[] = [];
  for (const line of run.stdout.split("\n")) {
    const hit = parseRgJsonLine(line);
    if (hit) hits.push(hit);
  }
  return hitsToGroups(hits, opts.cwd, opts.maxMatches ?? GREP_MAX_MATCHES);
}

export async function listFilesWithRg(opts: {
  cwd: string;
  targets: string[];
  signal?: AbortSignal;
}): Promise<string[] | null> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const target of opts.targets) {
    const abs = isAbsolute(target) ? target : resolve(opts.cwd, target);
    const hasGlob = /[*?[\]{}]/.test(target);
    const argv = hasGlob
      ? buildFilesArgv({ path: opts.cwd, globs: [target.replace(/\\/g, "/")] })
      : buildFilesArgv({ path: abs });
    const run = await runRipgrep(argv, { cwd: opts.cwd, signal: opts.signal });
    if (!run) return null;
    if (run.exitCode > 1) continue;
    for (const line of run.stdout.split("\n")) {
      const p = line.trim();
      if (!p) continue;
      const full = isAbsolute(p) ? p : join(opts.cwd, p);
      if (seen.has(full)) continue;
      seen.add(full);
      out.push(full);
    }
  }
  return out;
}

