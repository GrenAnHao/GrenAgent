/** Node service only: constrained HTTPS clones with ephemeral askpass credentials. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  rm,
  lstat,
  readdir,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
export class GitError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}
export function normalizeGitUrl(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\x00-\x1f\x7f\\]/.test(value)
  )
    throw new GitError(
      "Use a plain HTTPS repository URL without credentials or whitespace.",
    );
  // Check raw authority/path before WHATWG URL normalization can erase :443 or /../.
  const raw = /^https:\/\/([^/?#]+)(\/[^?#]*)$/.exec(value);
  if (
    !raw ||
    !HOSTS.has(raw[1]!) ||
    raw[1]!.includes(":") ||
    raw[1]!.includes("@")
  )
    throw new GitError(
      "Only credential-free HTTPS GitHub, GitLab, or Bitbucket repository URLs are accepted.",
    );
  const parts = raw[2]!.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2 || (raw[1] !== "gitlab.com" && parts.length !== 2))
    throw new GitError(
      "Provide a repository root URL, not a branch or file URL.",
    );
  parts[parts.length - 1] = parts.at(-1)!.replace(/\.git$/, "");
  if (
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_.-]{1,200}$/.test(part) || part === "." || part === "..",
    )
  )
    throw new GitError("Repository URL contains an unsafe path segment.");
  return `https://${raw[1]}/${parts.join("/")}.git`;
}
export function repositorySlug(url: string): string {
  return normalizeGitUrl(url)
    .split("/")
    .at(-1)!
    .replace(/\.git$/, "");
}
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
const DEV_NULL = process.platform === "win32" ? "NUL" : "/dev/null";

/** The token lives only in the short-lived Git/askpass child environment, never script bytes. */
export async function withGitEnvironment<T>(
  url: string,
  token: string | undefined,
  callback: (env: NodeJS.ProcessEnv) => Promise<T>,
  source: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const normalized = normalizeGitUrl(url);
  const useToken =
    new URL(normalized).hostname === "github.com"
      ? (token ?? source.GITHUB_TOKEN ?? source.GH_TOKEN ?? "")
      : "";
  if (/[\r\n\x00]/.test(useToken))
    throw new GitError("Git token contains invalid characters.");
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source))
    if (
      !key.startsWith("GIT_") &&
      ![
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "REPOWIKI_API_KEY",
        "REPOWIKI_GIT_TOKEN",
        "NODE_OPTIONS",
        "NODE_PATH",
      ].includes(key)
    )
      env[key] = value;
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: DEV_NULL,
    GCM_INTERACTIVE: "Never",
    ELECTRON_RUN_AS_NODE: "1",
  });
  const directory = await mkdtemp(path.join(tmpdir(), "repowiki-askpass-"));
  try {
    await chmod(directory, 0o700);
    const script = path.join(directory, "askpass.cjs");
    await writeFile(
      script,
      "'use strict';\nconst prompt = process.argv.slice(2).join(' ').toLowerCase();\nprocess.stdout.write((prompt.includes('username') ? 'x-access-token' : (process.env.REPOWIKI_GIT_TOKEN || '')) + '\\n');\n",
      { mode: 0o700, flag: "wx" },
    );
    const wrapper = path.join(
      directory,
      process.platform === "win32" ? "askpass.cmd" : "askpass",
    );
    const batchQuote = (value: string) => value.replace(/%/g, "%%");
    await writeFile(
      wrapper,
      process.platform === "win32"
        ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${batchQuote(process.execPath)}" "${batchQuote(script)}" %*\r\n`
        : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`,
      { mode: 0o700, flag: "wx" },
    );
    Object.assign(env, {
      GIT_ASKPASS: wrapper,
      SSH_ASKPASS: wrapper,
      REPOWIKI_GIT_TOKEN: useToken,
    });
    return await callback(env);
  } finally {
    delete env.REPOWIKI_GIT_TOKEN;
    await rm(directory, { recursive: true, force: true });
  }
}
export type GitRunOptions = {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
};
export type GitRunner = (
  args: string[],
  options: GitRunOptions,
) => Promise<void>;
export type CloneOptions = {
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  run?: GitRunner;
  maxBytes?: number;
};
const runGit: GitRunner = async (args, options) => {
  if (options.signal?.aborted)
    throw new GitError("Git clone canceled; partial checkout removed.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      env: options.env,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    let timedOut = false,
      canceled = false,
      settled = false;
    let forceKill: NodeJS.Timeout | undefined;
    const kill = () => {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1000);
      forceKill.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const abort = () => {
      canceled = true;
      kill();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      if (timedOut)
        reject(
          new GitError(
            "Git clone timed out; partial checkout removed. Credentials and Git output withheld.",
          ),
        );
      else if (canceled)
        reject(new GitError("Git clone canceled; partial checkout removed."));
      else if (code !== 0)
        reject(
          new GitError(
            "Git clone failed. Check Git installation, repository URL and access. Credentials and Git output withheld.",
          ),
        );
      else resolve();
    };
    child.once("error", () => finish(null));
    child.once("close", finish);
    if (options.signal?.aborted) abort();
  });
};
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function checkoutBytes(root: string, maxBytes: number): Promise<void> {
  let total = 0,
    count = 0;
  const pending = [root];
  while (pending.length) {
    for (const item of await readdir(pending.pop()!, { withFileTypes: true })) {
      const full = path.join(item.parentPath, item.name);
      if (item.isSymbolicLink()) continue;
      if (++count > 100_000)
        throw new GitError(
          "Cloned repository exceeds the 100,000-entry safety limit.",
        );
      if (item.isDirectory()) pending.push(full);
      else if (item.isFile()) {
        total += (await lstat(full)).size;
        if (total > maxBytes)
          throw new GitError("Cloned repository exceeds the local size limit.");
      }
    }
  }
}
/** New snapshot only. Existing destinations are never deleted; no automatic fetch, push, or repository code execution. */
export async function cloneInto(
  url: string,
  destination: string,
  options: CloneOptions = {},
): Promise<string> {
  const normalized = normalizeGitUrl(url),
    target = path.resolve(destination);
  const timeoutMs = options.timeoutMs ?? 120_000,
    maxBytes = options.maxBytes ?? 500 * 1024 * 1024;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 600_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    throw new GitError("Invalid Git clone limits.");
  if (await exists(target))
    throw new GitError(
      "Clone destination already exists; no files were changed.",
    );
  if (options.signal?.aborted)
    throw new GitError("Git clone canceled; no files were changed.");
  await mkdir(path.dirname(target), { recursive: true });
  // Resolve parent once; the reserved destination itself is exclusively created below.
  const canonical = path.join(
    await realpath(path.dirname(target)),
    path.basename(target),
  );
  try {
    await mkdir(canonical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new GitError(
        "Clone destination already exists; no files were changed.",
      );
    throw new GitError("Unable to create clone destination.");
  }
  const owned = await lstat(canonical);
  try {
    await withGitEnvironment(normalized, options.token, async (env) => {
      await (options.run ?? runGit)(
        [
          "-c",
          "credential.helper=",
          "-c",
          "http.followRedirects=false",
          "-c",
          `core.hooksPath=${DEV_NULL}`,
          "-c",
          "core.fsmonitor=false",
          "-c",
          "init.templateDir=",
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--no-recurse-submodules",
          "--",
          normalized,
          canonical,
        ],
        { env, timeoutMs, signal: options.signal },
      );
    });
    if (options.signal?.aborted)
      throw new GitError("Git clone canceled; partial checkout removed.");
    await checkoutBytes(canonical, maxBytes);
    return canonical;
  } catch (error) {
    const current = await lstat(canonical).catch(() => null);
    if (
      current &&
      current.dev === owned.dev &&
      current.ino === owned.ino &&
      !current.isSymbolicLink()
    )
      await rm(canonical, { recursive: true, force: true });
    if (error instanceof GitError) throw error;
    throw new GitError(
      "Git clone failed. Check Git installation, repository URL and access. Credentials and Git output withheld.",
    );
  }
}
export async function cloneRepository(
  url: string,
  destinationRoot: string,
  options: CloneOptions = {},
): Promise<string> {
  const normalized = normalizeGitUrl(url),
    root = path.resolve(destinationRoot);
  await mkdir(root, { recursive: true });
  return cloneInto(
    normalized,
    path.join(
      root,
      `${repositorySlug(normalized)}-${randomUUID().replace(/-/g, "").slice(0, 10)}`,
    ),
    options,
  );
}
export const normalize_git_url = normalizeGitUrl;
export const repository_slug = repositorySlug;
export const clone_into = cloneInto;
export const clone_repository = cloneRepository;
