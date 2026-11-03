/** Bounded, non-executing source inspection. Static imports are evidence, not a universal AST. */
import { createHash } from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import ignore from "ignore";
export class ScannerError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "ScannerError";
  }
}
export type SourceFile = {
  path: string;
  content: string;
  hash: string;
  language: string;
  lines: number;
};
export type ScanOptions = {
  include?: string[];
  exclude?: string[];
  dataDir?: string;
  language?: string;
  maxFiles?: number;
  maxFileSize?: number;
  maxTotalBytes?: number;
  keepEmpty?: boolean;
};
export const isKnowledgeOutput = (relative: string): boolean => {
  const normalized = relative.replace(/\\/g, "/");
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return key === "docs/repo-wiki" || key.startsWith("docs/repo-wiki/")
    || key === ".qoder/repowiki" || key.startsWith(".qoder/repowiki/");
};
export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new ScannerError("Operation canceled", 499);
}
export type ScanCoverage = {
  partial: boolean;
  candidates: number;
  kept: number;
  max_files: number;
  max_file_bytes: number;
  max_total_bytes: number;
  omitted_files: string[];
  skipped: Record<string, number>;
  static_dependencies: string;
};
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "env", ".idea", ".vscode", ".next", "dist", "build", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".turbo", "coverage", ".cache", "vendor", "target", "__snapshots__", ".svn", ".hg", ".gradle", ".m2", "Pods", ".dart_tool", ".pub-cache", ".aws", ".ssh", ".gnupg", ".codex", ".agents", ".repowiki-workspace", ".repowiki-node", ".repowiki", ".runtime"]);
const SENSITIVE = new Set([".env", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "known_hosts", "credentials", "credentials.json", "service-account.json", "service_account.json", "secrets.json", "secrets.yaml", "secrets.yml"]);
const SKIP_SUFFIXES = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp", ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".flac", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz", ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".woff", ".woff2", ".ttf", ".eot", ".otf", ".pyc", ".pyo", ".class", ".o", ".obj", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".db", ".sqlite", ".sqlite3", ".lock", ".min.js", ".min.css", ".map", ".wasm", ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];
const LANGUAGES: Record<string, string> = {
  ".py": "python",
  ".pyi": "python",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".json": "json",
  ".jsonc": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".mdx": "markdown",
  ".txt": "text",
  ".html": "html",
  ".css": "css",
  ".scss": "css",
  ".sh": "shell",
  ".bash": "shell",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".vue": "vue",
  ".svelte": "svelte",
  ".sql": "sql",
  ".rb": "ruby",
  ".php": "php"
};
const CODE = new Set(["python", "javascript", "typescript", "go", "rust", "java", "kotlin", "c", "cpp", "vue", "svelte", "shell", "ruby", "php", "sql"]);
const CONFIG = /^(?:readme(?:\..*)?|package\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|makefile|dockerfile|tsconfig\.json|wiki_plan\.json)$/i;
const ENTRY = /^(?:main|index|app|server|__main__)\.(?:py|go|rs|[cm]?[jt]sx?)$/i;
const compare = (a: string, b: string): number => {
  const aa = [...a],
    bb = [...b];
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    const d = aa[i]!.codePointAt(0)! - bb[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return aa.length - bb.length;
};

/** Same sorted compact JSON encoding as the original Python workspace for schema JSON values. */
export function canonicalJson(value: unknown): string {
  function encode(item: unknown): string {
    if (item === null || typeof item !== "object") {
      const encoded = JSON.stringify(item);
      if (encoded === undefined || typeof item === "number" && !Number.isFinite(item)) throw new TypeError("Only finite JSON values are accepted");
      return encoded;
    }
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    return `{${Object.keys(item).sort(compare).map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return encode(value);
}
export function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}
export function safeRelative(value: unknown, glob = false): string {
  if (typeof value !== "string" || !value || value.length > 500 || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith("/") || value.split("/").some(p => !p || p === "." || p === "..") || !glob && /[*?\[\]]/.test(value)) throw new ScannerError("Only safe POSIX relative paths are accepted");
  return value;
}
type GlobToken = {
  kind: "star";
} | {
  kind: "one";
  test: (char: string) => boolean;
};
const globCache = new Map<string, GlobToken[]>();
function globTokens(pattern: string): GlobToken[] {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  const result: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (result.at(-1)?.kind !== "star") result.push({
        kind: "star"
      });
    } else if (char === "?") result.push({
      kind: "one",
      test: () => true
    });else if (char === "[" && pattern.indexOf("]", i + 1) > i + 1) {
      const end = pattern.indexOf("]", i + 1);
      let group = pattern.slice(i + 1, end);
      const negate = group.startsWith("!");
      if (negate) group = group.slice(1);
      const values = group;
      result.push({
        kind: "one",
        test: (value: string) => {
          let matched = false;
          for (let j = 0; j < values.length; j++) {
            if (values[j + 1] === "-" && j + 2 < values.length) {
              matched ||= value >= values[j]! && value <= values[j + 2]!;
              j += 2;
            } else matched ||= value === values[j];
          }
          return negate ? !matched : matched;
        }
      });
      i = end;
    } else result.push({
      kind: "one",
      test: value => value === char
    });
  }
  if (globCache.size > 1000) globCache.clear();
  globCache.set(pattern, result);
  return result;
}
function globMatch(file: string, pattern: string): boolean {
  // Greedy wildcard matching has bounded O(path * pattern) work, not regex backtracking.
  const tokens = globTokens(pattern);
  let i = 0,
    j = 0,
    star = -1,
    retry = 0;
  while (i < file.length) {
    const token = tokens[j];
    if (token?.kind === "one" && token.test(file[i]!)) {
      i++;
      j++;
    } else if (token?.kind === "star") {
      star = j++;
      retry = i;
    } else if (star >= 0) {
      j = star + 1;
      i = ++retry;
    } else return false;
  }
  while (tokens[j]?.kind === "star") j++;
  return j === tokens.length;
}
export function matches(file: string, patterns: string[]): boolean {
  return patterns.some(pattern => pattern === "**" || globMatch(file, pattern) || pattern.startsWith("**/") && globMatch(file, pattern.slice(3)));
}
function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel);
}
function languageOf(file: string): string {
  const name = path.posix.basename(file).toLowerCase();
  return name === "makefile" ? "makefile" : name.startsWith("dockerfile") ? "dockerfile" : LANGUAGES[path.posix.extname(file).toLowerCase()] ?? "unknown";
}
function forbidden(file: string): boolean {
  const name = path.posix.basename(file).toLowerCase();
  return SENSITIVE.has(name) || name.startsWith(".env.") && ![".env.example", ".env.sample", ".env.template"].includes(name) || SKIP_SUFFIXES.some(suffix => name.endsWith(suffix));
}

/** Open regular files only; on POSIX O_NOFOLLOW also protects the final path from symlink races. */
function readRegular(root: string, relative: string, maxBytes: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    safeRelative(relative);
    const full = path.join(root, ...relative.split("/"));
    let cursor = root;
    for (const part of relative.split("/")) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) return;
    }
    if (!inside(root, fs.realpathSync(full))) return;
    fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return;
    // Read one extra byte to reject a file that grows while being read.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > stat.size || length > maxBytes) return;
    return buffer.subarray(0, length);
  } catch {
    return;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
const SAFE_DIRECTORY_TTL_MS = 30_000;
let safeDirectoryCache: { at: number; values: string[] } | undefined;
/**
 * The user's own global `safe.directory` entries. Scanning isolates global config, so without
 * them a repository owned by another Windows account (for example the sandbox user) fails Git's
 * ownership check even though the user already trusted it. Only the user's decision is forwarded.
 * See .agents/notes/implemented/bug-fix/2026-11-01-repo-wiki-git-safe-directory.md.
 */
export function userSafeDirectoryArgs(now = Date.now()): string[] {
  if (!safeDirectoryCache || now - safeDirectoryCache.at > SAFE_DIRECTORY_TTL_MS) {
    let values: string[] = [];
    try {
      values = execFileSync("git", ["config", "--global", "--get-all", "safe.directory"], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    } catch { /* No entries (exit 1) or no git: keep Git's default ownership check. */ }
    safeDirectoryCache = { at: now, values };
  }
  return safeDirectoryCache.values.flatMap((value) => ["-c", `safe.directory=${value}`]);
}
function git(root: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  // Note: Git for Windows rejects Node's \\.\nul device path as a config file.
  // See .agents/notes/implemented/bug-fix/2026-10-31-repo-wiki-windows-git-identity.md.
  const devNull = process.platform === "win32" ? "NUL" : os.devNull;
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull
  });
  try {
    return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, ...userSafeDirectoryArgs(), "-C", root, ...args], {
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}
export function identity(root: string, hashes: Record<string, string>, language: string): Record<string, any> {
  const commit = git(root, ["rev-parse", "HEAD"]);
  const branch = git(root, ["symbolic-ref", "--short", "HEAD"]) || (commit ? `detached:${commit.slice(0, 12)}` : "local");
  let dirty = false;
  if (commit && Object.keys(hashes).length) {
    const format = git(root, ["rev-parse", "--show-object-format"]) === "sha256" ? "sha256" : "sha1";
    const tracked = new Map<string, string>();
    for (const entry of git(root, ["ls-files", "--stage", "-z"]).split("\0")) {
      const m = /^\d+ ([a-f\d]+) \d\t([\s\S]+)$/.exec(entry);
      if (m) tracked.set(m[2]!, m[1]!);
    }
    for (const relative of Object.keys(hashes)) {
      const raw = readRegular(root, relative, 200 * 1024);
      if (!raw || !tracked.has(relative) || createHash(format).update(`blob ${raw.length}\0`).update(raw).digest("hex") !== tracked.get(relative)) {
        dirty = true;
        break;
      }
    }
    if (!dirty) for (const relative of tracked.keys()) {
      if (isKnowledgeOutput(relative)) continue;
      try {
        safeRelative(relative);
        if (!fs.existsSync(path.join(root, ...relative.split("/")))) {
          dirty = true;
          break;
        }
      } catch {
        /* Ignore non-POSIX unsupported tracked names. */
      }
    }
  }
  return {
    branch,
    commit: commit || null,
    language,
    worktree_hash: hash(hashes),
    dirty,
    is_git: Boolean(commit),
    dirty_scope: "scanned-files-and-tracked-deletions"
  };
}
function buildTree(files: SourceFile[]): string {
  const entries = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    entries.add(file.path);
    for (let i = 1; i < parts.length; i++) entries.add(parts.slice(0, i).join("/") + "/");
  }
  const ordered = [...entries].sort(compare);
  const lines = ordered.slice(0, 200).map(entry => `${"  ".repeat(entry.replace(/\/$/, "").split("/").length - 1)}${path.posix.basename(entry)}${entry.endsWith("/") ? "/" : ""}`);
  if (ordered.length > 200) lines.push(`  ... and ${ordered.length - 200} more entries`);
  return lines.join("\n");
}
function stripComments(text: string, language: string): string {
  // Preserve quoted text while replacing comments; deliberately not a parser for template expressions.
  const pattern = language === "python" ? /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|#[^\n]*/g : /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  return text.replace(pattern, (whole, quoted: string | undefined) => quoted ?? whole.replace(/[^\n]/g, " "));
}
/** Ignore import-looking text inside string literals/docstrings. Template expressions are conservatively opaque. */
function codeMatches(text: string, pattern: RegExp): RegExpMatchArray[] {
  const spans = [...text.matchAll(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g)].map(match => [match.index!, match.index! + match[0].length]);
  const result: RegExpMatchArray[] = [];
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    while (index < spans.length && spans[index]![1]! <= start) index++;
    if (index >= spans.length || start < spans[index]![0]!) result.push(match);
  }
  return result;
}
/** Resolve only paths present in the scanned evidence set, never installed dependencies. */
export function dependencyEdges(files: SourceFile[]): [string, string][] {
  const known = new Set(files.map(f => f.path));
  const edges = new Set<string>();
  const add = (source: string, target: string): void => {
    const normalized = path.posix.normalize(target);
    if (normalized !== source && known.has(normalized)) edges.add(JSON.stringify([source, normalized]));
  };
  const first = (source: string, candidates: string[]): void => {
    const found = candidates.map(c => path.posix.normalize(c)).find(c => known.has(c));
    if (found) add(source, found);
  };
  const pyCandidates = (module: string): string[] => [`${module}.py`, `${module}/__init__.py`, `${module}.pyi`, ...(!module.startsWith("src/") ? [`src/${module}.py`, `src/${module}/__init__.py`, `src/${module}.pyi`] : [])];
  const pyBase = (source: string, module: string): string => {
    const dots = /^\.+/.exec(module)?.[0].length ?? 0;
    if (!dots) return module.replaceAll(".", "/");
    const dirs = path.posix.dirname(source) === "." ? [] : path.posix.dirname(source).split("/");
    if (dots > dirs.length + 1) return "__outside__";
    return [...dirs.slice(0, Math.max(0, dirs.length - dots + 1)), ...module.slice(dots).split(".").filter(Boolean)].join("/");
  };
  const jsExt = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
  const moduleName = /^\s*module\s+([^\s]+)/m.exec(files.find(f => f.path === "go.mod")?.content ?? "")?.[1];
  for (const file of files) {
    const text = stripComments(file.content, file.language);
    if (["javascript", "typescript", "vue", "svelte"].includes(file.language)) {
      const imports = new Set<string>();
      for (const pattern of [/\b(?:import|export)\s+(?:type\s+)?[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) for (const match of codeMatches(text, pattern)) imports.add(match[1]!);
      for (const spec of imports) {
        if (!spec.startsWith(".")) continue; // tsconfig aliases and packages require host-specific resolution.
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), spec));
        const replacements = /\.[cm]?jsx?$/.test(base) ? jsExt.map(ext => base.replace(/\.[cm]?jsx?$/, ext)) : [];
        first(file.path, [base, ...replacements, ...jsExt.map(ext => base + ext), ...jsExt.map(ext => `${base}/index${ext}`)]);
      }
    } else if (file.language === "python") {
      for (const match of codeMatches(text, /^\s*import\s+([^\n;]+)/gm)) for (const part of match[1]!.split(",")) {
        const module = /^\s*([\w.]+)/.exec(part)?.[1];
        if (module) first(file.path, pyCandidates(pyBase(file.path, module)));
      }
      for (const match of codeMatches(text, /^\s*from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n;]+)/gm)) {
        const base = pyBase(file.path, match[1]!);
        first(file.path, pyCandidates(base));
        for (const part of match[2]!.replace(/[()]/g, "").split(",")) {
          const name = /^\s*(\w+)/.exec(part)?.[1];
          if (name) first(file.path, pyCandidates(`${base}/${name}`));
        }
      }
    } else if (file.language === "go") {
      for (const block of codeMatches(text, /\bimport\s*(?:\(([\s\S]*?)\)|(?:\w+|\.)?\s*("[^"\n]+"))/g)) for (const match of (block[1] ?? block[2] ?? "").matchAll(/"([^"\n]+)"/g)) {
        const spec = match[1]!;
        if (!moduleName || !spec.startsWith(moduleName + "/")) continue;
        const dir = spec.slice(moduleName.length + 1);
        for (const candidate of files) if (candidate.language === "go" && path.posix.dirname(candidate.path) === dir && !candidate.path.endsWith("_test.go")) add(file.path, candidate.path);
      }
    } else if (file.language === "rust") {
      for (const match of codeMatches(text, /\bmod\s+(\w+)\s*;/g)) {
        const dir = path.posix.dirname(file.path);
        const stem = path.posix.basename(file.path, ".rs");
        const base = ["lib", "main", "mod"].includes(stem) ? dir : `${dir}/${stem}`;
        first(file.path, [`${base}/${match[1]}.rs`, `${base}/${match[1]}/mod.rs`]);
      }
      for (const match of codeMatches(text, /\buse\s+((?:crate|self|super)::[\w:]+)/g)) {
        const parts = match[1]!.split("::");
        const kind = parts.shift();
        let base = kind === "crate" ? "src" : path.posix.dirname(file.path);
        if (kind === "super") base = path.posix.dirname(base);
        for (let count = parts.length; count > 0; count--) first(file.path, [`${base}/${parts.slice(0, count).join("/")}.rs`, `${base}/${parts.slice(0, count).join("/")}/mod.rs`]);
      }
    } else if (file.language === "java") {
      for (const match of codeMatches(text, /^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;/gm)) {
        const parts = match[1]!.split(".");
        for (let count = parts.length; count > 0; count--) first(file.path, [`src/main/java/${parts.slice(0, count).join("/")}.java`, `src/test/java/${parts.slice(0, count).join("/")}.java`, `${parts.slice(0, count).join("/")}.java`]);
      }
    }
  }
  return [...edges].map(value => JSON.parse(value) as [string, string]).sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]));
}
export function scanRepository(rootInput: string, options: ScanOptions = {}) {
  const root = fs.realpathSync(path.resolve(rootInput));
  if (!fs.statSync(root).isDirectory()) throw new Error("Repository directory does not exist");
  const include = options.include ?? ["**"],
    exclude = options.exclude ?? [];
  for (const pattern of [...include, ...exclude]) safeRelative(pattern, true);
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 1000, 1000));
  const maxFileSize = Math.max(1, Math.min(options.maxFileSize ?? 200 * 1024, 200 * 1024));
  const maxTotalBytes = Math.max(1, Math.min(options.maxTotalBytes ?? 20 * 1024 * 1024, 20 * 1024 * 1024));
  const coverage: ScanCoverage = {
    partial: false,
    candidates: 0,
    kept: 0,
    max_files: maxFiles,
    max_file_bytes: maxFileSize,
    max_total_bytes: maxTotalBytes,
    omitted_files: [],
    skipped: {},
    static_dependencies: "best-effort literal imports; no dynamic imports, aliases, build tags or runtime execution"
  };
  const skipped = (reason: string, file?: string): void => {
    coverage.skipped[reason] = (coverage.skipped[reason] ?? 0) + 1;
    if (["file_limit", "byte_limit", "oversized", "entry_limit", "unreadable", "invalid_utf8", "minified"].includes(reason)) {
      coverage.partial = true;
      if (file && coverage.omitted_files.length < 100) coverage.omitted_files.push(file);
    }
  };
  const ignoreRules = ignore();
  for (const name of [".gitignore", ".repowikiignore"]) {
    const raw = readRegular(root, name, 100_000);
    if (raw) {
      try {
        ignoreRules.add(new TextDecoder("utf-8", {
          fatal: true
        }).decode(raw));
      } catch {
        skipped("invalid_ignore", name);
      }
    }
  }
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : undefined;
  const skipData = dataDir && inside(root, dataDir) ? dataDir : undefined;
  const candidates: {
    path: string;
    size: number;
    language: string;
  }[] = [];
  let entries = 0,
    stopped = false;
  function walk(directory: string): void {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(directory, {
        withFileTypes: true
      }).sort((a, b) => compare(a.name, b.name));
    } catch {
      skipped("unreadable", path.relative(root, directory).split(path.sep).join("/"));
      return;
    }
    for (const entry of names) {
      if (++entries > 20_000) {
        skipped("entry_limit");
        stopped = true;
        return;
      }
      const full = path.join(directory, entry.name),
        relative = path.relative(root, full).split(path.sep).join("/");
      try {
        safeRelative(relative);
      } catch {
        skipped("unsafe_path");
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped("symlink");
        continue;
      }
      if (isKnowledgeOutput(relative)) {
        skipped("knowledge_output");
        continue;
      }
      if (skipData && inside(skipData, full)) {
        skipped("workspace_data");
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.endsWith(".egg-info") || ignoreRules.ignores(relative + "/")) {
          skipped("excluded_directory");
          continue;
        }
        walk(full);
        if (stopped) return;
      } else if (entry.isFile()) {
        if (forbidden(relative)) {
          skipped("sensitive_or_binary_extension");
          continue;
        }
        if (ignoreRules.ignores(relative) || !matches(relative, include) || matches(relative, exclude)) {
          skipped("excluded_file");
          continue;
        }
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(full);
        } catch {
          skipped("unreadable", relative);
          continue;
        }
        if (!stat.isFile()) {
          skipped("non_regular");
          continue;
        }
        coverage.candidates++;
        if (stat.size === 0 && !options.keepEmpty) {
          skipped("empty");
          continue;
        }
        if (stat.size > maxFileSize) {
          skipped("oversized", relative);
          continue;
        }
        candidates.push({
          path: relative,
          size: stat.size,
          language: languageOf(relative)
        });
      }
    }
  }
  walk(root);
  const priority = (file: {
    path: string;
    language: string;
  }): number => CONFIG.test(path.posix.basename(file.path)) ? 0 : ENTRY.test(path.posix.basename(file.path)) ? 1 : CODE.has(file.language) ? 2 : 3;
  candidates.sort((a, b) => priority(a) - priority(b) || compare(a.path, b.path));
  const files: SourceFile[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (files.length >= maxFiles) {
      skipped("file_limit", candidate.path);
      continue;
    }
    if (totalBytes + candidate.size > maxTotalBytes) {
      skipped("byte_limit", candidate.path);
      continue;
    }
    const raw = readRegular(root, candidate.path, maxFileSize);
    if (!raw) {
      skipped("unreadable", candidate.path);
      continue;
    }
    if (raw.includes(0)) {
      skipped("binary");
      continue;
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true
      }).decode(raw);
    } catch {
      skipped("invalid_utf8", candidate.path);
      continue;
    }
    if (["javascript", "css"].includes(candidate.language)) {
      const lines = content.split(/\r?\n/);
      const longest = Math.max(0, ...lines.map(line => line.length));
      if (longest >= 1000 && (lines.filter(line => line.trim()).length <= 5 || longest > content.length * 0.5)) {
        skipped("minified", candidate.path);
        continue;
      }
    }
    if (totalBytes + raw.length > maxTotalBytes) {
      skipped("byte_limit", candidate.path);
      continue;
    }
    totalBytes += raw.length;
    files.push({
      path: candidate.path,
      content,
      hash: hash(content),
      language: candidate.language,
      lines: content.split(/\r\n|\n|\r/).length
    });
  }
  coverage.kept = files.length;
  const hashes = Object.fromEntries(files.map(file => [file.path, file.hash]));
  return {
    files,
    hashes,
    edges: dependencyEdges(files),
    identity: identity(root, hashes, options.language ?? "zh"),
    file_tree: buildTree(files),
    name: path.basename(root),
    coverage
  };
}

// Callback realpath uses Node's component walk; promises.realpath uses the native
// Windows API, which rejects otherwise accessible app-container temp paths.
const realpathAsync = (filename: string): Promise<string> => new Promise((resolve, reject) => fs.realpath(filename, (error, result) => error ? reject(error) : resolve(result)));
/** Bounded single-file source link; does not enumerate the repository or run Git. */
export function readSourceFile(root: string, relative: string): SourceFile | undefined {
  safeRelative(relative);
  if (isKnowledgeOutput(relative) || forbidden(relative) || relative.split("/").slice(0, -1).some(part => SKIP_DIRS.has(part))) return;
  const raw = readRegular(root, relative, 200 * 1024);
  if (!raw || raw.includes(0)) return;
  try {
    const content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true
    }).decode(raw);
    return {
      path: relative,
      content,
      hash: hash(content),
      language: languageOf(relative),
      lines: content.split(/\r\n|\n|\r/).length
    };
  } catch {
    return;
  }
}
async function readRegularAsync(root: string, relative: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer | undefined> {
  checkAborted(signal);
  let handle: fs.promises.FileHandle | undefined;
  try {
    safeRelative(relative);
    const full = path.join(root, ...relative.split("/"));
    let cursor = root;
    for (const part of relative.split("/")) {
      cursor = path.join(cursor, part);
      if ((await fs.promises.lstat(cursor)).isSymbolicLink()) return;
    }
    if (!inside(root, await realpathAsync(full))) return;
    handle = await fs.promises.open(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return;
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      checkAborted(signal);
      const r = await handle.read(buffer, length, buffer.length - length, null);
      if (!r.bytesRead) break;
      length += r.bytesRead;
    }
    if (length > stat.size || length > maxBytes) return;
    return buffer.subarray(0, length);
  } catch (e) {
    checkAborted(signal);
    return;
  } finally {
    await handle?.close();
  }
}
async function gitAsync(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  checkAborted(signal);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  const devNull = process.platform === "win32" ? "NUL" : os.devNull;
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull
  });
  return new Promise((resolve, reject) => execFile("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, ...userSafeDirectoryArgs(), "-C", root, ...args], {
    env,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    signal
  }, (error, stdout) => {
    if (signal?.aborted) reject(signal.reason instanceof Error ? signal.reason : new ScannerError("Operation canceled", 499));else resolve(error ? "" : stdout.trim());
  }));
}
export async function identityAsync(root: string, hashes: Record<string, string>, language: string, signal?: AbortSignal): Promise<Record<string, any>> {
  const commit = await gitAsync(root, ["rev-parse", "HEAD"], signal),
    branch = (await gitAsync(root, ["symbolic-ref", "--short", "HEAD"], signal)) || (commit ? `detached:${commit.slice(0, 12)}` : "local");
  let dirty = false;
  if (commit && Object.keys(hashes).length) {
    const format = (await gitAsync(root, ["rev-parse", "--show-object-format"], signal)) === "sha256" ? "sha256" : "sha1",
      tracked = new Map<string, string>();
    for (const entry of (await gitAsync(root, ["ls-files", "--stage", "-z"], signal)).split("\0")) {
      const m = /^\d+ ([a-f\d]+) \d\t([\s\S]+)$/.exec(entry);
      if (m) tracked.set(m[2]!, m[1]!);
    }
    for (const relative of Object.keys(hashes)) {
      const raw = await readRegularAsync(root, relative, 200 * 1024, signal);
      if (!raw || !tracked.has(relative) || createHash(format).update(`blob ${raw.length}\0`).update(raw).digest("hex") !== tracked.get(relative)) {
        dirty = true;
        break;
      }
    }
    if (!dirty) for (const relative of tracked.keys()) {
      checkAborted(signal);
      if (isKnowledgeOutput(relative)) continue;
      try {
        safeRelative(relative);
        await fs.promises.lstat(path.join(root, ...relative.split("/")));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          dirty = true;
          break;
        }
      }
    }
  }
  return {
    branch,
    commit: commit || null,
    language,
    worktree_hash: hash(hashes),
    dirty,
    is_git: Boolean(commit),
    dirty_scope: "scanned-files-and-tracked-deletions"
  };
}
export async function scanRepositoryAsync(rootInput: string, options: ScanOptions = {}, signal?: AbortSignal) {
  checkAborted(signal);
  const root = await realpathAsync(path.resolve(rootInput));
  if (!(await fs.promises.stat(root)).isDirectory()) throw new Error("Repository directory does not exist");
  const include = options.include ?? ["**"],
    exclude = options.exclude ?? [];
  for (const pattern of [...include, ...exclude]) safeRelative(pattern, true);
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 1000, 1000));
  const maxFileSize = Math.max(1, Math.min(options.maxFileSize ?? 200 * 1024, 200 * 1024));
  const maxTotalBytes = Math.max(1, Math.min(options.maxTotalBytes ?? 20 * 1024 * 1024, 20 * 1024 * 1024));
  const coverage: ScanCoverage = {
    partial: false,
    candidates: 0,
    kept: 0,
    max_files: maxFiles,
    max_file_bytes: maxFileSize,
    max_total_bytes: maxTotalBytes,
    omitted_files: [],
    skipped: {},
    static_dependencies: "best-effort literal imports; no dynamic imports, aliases, build tags or runtime execution"
  };
  const skipped = (reason: string, file?: string): void => {
    coverage.skipped[reason] = (coverage.skipped[reason] ?? 0) + 1;
    if (["file_limit", "byte_limit", "oversized", "entry_limit", "unreadable", "invalid_utf8", "minified"].includes(reason)) {
      coverage.partial = true;
      if (file && coverage.omitted_files.length < 100) coverage.omitted_files.push(file);
    }
  };
  const ignoreRules = ignore();
  for (const name of [".gitignore", ".repowikiignore"]) {
    const raw = await readRegularAsync(root, name, 100_000, signal);
    if (raw) {
      try {
        ignoreRules.add(new TextDecoder("utf-8", {
          fatal: true
        }).decode(raw));
      } catch {
        skipped("invalid_ignore", name);
      }
    }
  }
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : undefined;
  const skipData = dataDir && inside(root, dataDir) ? dataDir : undefined;
  const candidates: {
    path: string;
    size: number;
    language: string;
  }[] = [];
  let entries = 0,
    stopped = false;
  async function walk(directory: string): Promise<void> {
    checkAborted(signal);
    let names: fs.Dirent[];
    try {
      names = (await fs.promises.readdir(directory, {
        withFileTypes: true
      })).sort((a, b) => compare(a.name, b.name));
    } catch {
      skipped("unreadable", path.relative(root, directory).split(path.sep).join("/"));
      return;
    }
    for (const entry of names) {
      checkAborted(signal);
      if (++entries > 20_000) {
        skipped("entry_limit");
        stopped = true;
        return;
      }
      const full = path.join(directory, entry.name),
        relative = path.relative(root, full).split(path.sep).join("/");
      try {
        safeRelative(relative);
      } catch {
        skipped("unsafe_path");
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped("symlink");
        continue;
      }
      if (isKnowledgeOutput(relative)) {
        skipped("knowledge_output");
        continue;
      }
      if (skipData && inside(skipData, full)) {
        skipped("workspace_data");
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.endsWith(".egg-info") || ignoreRules.ignores(relative + "/")) {
          skipped("excluded_directory");
          continue;
        }
        await walk(full);
        if (stopped) return;
      } else if (entry.isFile()) {
        if (forbidden(relative)) {
          skipped("sensitive_or_binary_extension");
          continue;
        }
        if (ignoreRules.ignores(relative) || !matches(relative, include) || matches(relative, exclude)) {
          skipped("excluded_file");
          continue;
        }
        let stat: fs.Stats;
        try {
          stat = await fs.promises.lstat(full);
        } catch {
          skipped("unreadable", relative);
          continue;
        }
        if (!stat.isFile()) {
          skipped("non_regular");
          continue;
        }
        coverage.candidates++;
        if (stat.size === 0 && !options.keepEmpty) {
          skipped("empty");
          continue;
        }
        if (stat.size > maxFileSize) {
          skipped("oversized", relative);
          continue;
        }
        candidates.push({
          path: relative,
          size: stat.size,
          language: languageOf(relative)
        });
      }
    }
  }
  await walk(root);
  const priority = (file: {
    path: string;
    language: string;
  }): number => CONFIG.test(path.posix.basename(file.path)) ? 0 : ENTRY.test(path.posix.basename(file.path)) ? 1 : CODE.has(file.language) ? 2 : 3;
  candidates.sort((a, b) => priority(a) - priority(b) || compare(a.path, b.path));
  const files: SourceFile[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    checkAborted(signal);
    if (files.length >= maxFiles) {
      skipped("file_limit", candidate.path);
      continue;
    }
    if (totalBytes + candidate.size > maxTotalBytes) {
      skipped("byte_limit", candidate.path);
      continue;
    }
    const raw = await readRegularAsync(root, candidate.path, maxFileSize, signal);
    if (!raw) {
      skipped("unreadable", candidate.path);
      continue;
    }
    if (raw.includes(0)) {
      skipped("binary");
      continue;
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true
      }).decode(raw);
    } catch {
      skipped("invalid_utf8", candidate.path);
      continue;
    }
    if (["javascript", "css"].includes(candidate.language)) {
      const lines = content.split(/\r?\n/);
      const longest = Math.max(0, ...lines.map(line => line.length));
      if (longest >= 1000 && (lines.filter(line => line.trim()).length <= 5 || longest > content.length * 0.5)) {
        skipped("minified", candidate.path);
        continue;
      }
    }
    if (totalBytes + raw.length > maxTotalBytes) {
      skipped("byte_limit", candidate.path);
      continue;
    }
    totalBytes += raw.length;
    files.push({
      path: candidate.path,
      content,
      hash: hash(content),
      language: candidate.language,
      lines: content.split(/\r\n|\n|\r/).length
    });
  }
  coverage.kept = files.length;
  const hashes = Object.fromEntries(files.map(file => [file.path, file.hash]));
  return {
    files,
    hashes,
    edges: dependencyEdges(files),
    identity: await identityAsync(root, hashes, options.language ?? "zh", signal),
    file_tree: buildTree(files),
    name: path.basename(root),
    coverage
  };
}

/** Snapshot plus explicit Git probe: repository content remains the correctness authority. */
export async function scanKnowledgeSnapshot(root: string, options: ScanOptions = {}, signal?: AbortSignal, gitExecutable = 'git') {
  const snapshot = await scanRepositoryAsync(root, {...options, keepEmpty:true}, signal);
  checkAborted(signal);
  const git = await new Promise<{kind:'git'|'non-git'|'error'; message?:string}>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
    Object.assign(env, { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull });
    execFile(gitExecutable, [...userSafeDirectoryArgs(), '-C', root, 'rev-parse', '--is-inside-work-tree'], {env, encoding:'utf8', timeout:5000, windowsHide:true, signal}, (error, stdout, stderr) => {
      if (signal?.aborted) { reject(signal.reason instanceof Error ? signal.reason : new ScannerError('Operation canceled', 499)); return; }
      if (!error && stdout.trim() === 'true') resolve({kind:'git'});
      else if (error && /not a git repository/i.test(stderr)) resolve({kind:'non-git'});
      else resolve({kind:'error', message: /dubious ownership/i.test(stderr) ? 'GIT_DUBIOUS_OWNERSHIP' : error?.message ?? 'Unexpected git response'});
    });
  });
  const uncertain = ['invalid_ignore'].some(reason => (snapshot.coverage.skipped[reason] ?? 0) > 0);
  return {...snapshot, coverage: {...snapshot.coverage, partial: snapshot.coverage.partial || uncertain}, git};
}


