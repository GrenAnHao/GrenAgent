import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, validateWorktreeName, WORKTREE_NAME_PREFIX } from "./worktree.js";

let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(withCommit = true): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "wt-repo-")));
  git(dir, "init", "-q", "-b", "main");
  if (withCommit) {
    writeFileSync(join(dir, "README.md"), "base\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

beforeEach(() => {
  repo = initRepo();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("createWorktree", { timeout: 30_000 }, () => {
  it.skipIf(process.platform !== "win32")("never runs a git.exe that sits in the repository, even when Windows would look in the working directory first", async () => {
    // A copy of whoami placed where a sandboxed command could put a program called git.exe.
    copyFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), join(repo, "git.exe"));
    const saved = process.env.NoDefaultCurrentDirectoryInExePath;
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    try {
      const created = await createWorktree({ cwd: repo, writableRoot: repo, name: "unharmed" });
      expect(created.branch).toBe("unharmed");
      expect(existsSync(join(created.path, "README.md"))).toBe(true);
    } finally {
      if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved;
    }
  });

  it("pins HEAD, creates the branch under .agents/worktrees, ignores its new pool, and leaves the source dirty state alone", async () => {
    writeFileSync(join(repo, "README.md"), "dirty edit\n");
    writeFileSync(join(repo, "untracked.txt"), "x\n");
    const head = git(repo, "rev-parse", "HEAD");
    const created = await createWorktree({ cwd: repo, writableRoot: repo, name: "feature" });
    expect(created.branch).toBe("feature");
    expect(created.baseCommit).toBe(head);
    expect(created.repositoryRoot.toLowerCase()).toBe(repo.toLowerCase());
    expect(created.path.toLowerCase()).toBe(join(repo, ".agents", "worktrees", "feature").toLowerCase());
    expect(readFileSync(join(created.path, "README.md"), "utf8").replace(/\r\n/g, "\n")).toBe("base\n");
    expect(existsSync(join(created.path, "untracked.txt"))).toBe(false);
    expect(git(created.path, "branch", "--show-current")).toBe("feature");
    expect(readFileSync(join(repo, ".agents", "worktrees", ".gitignore"), "utf8")).toBe("*\n");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("dirty edit\n");
    expect(git(repo, "status", "--porcelain")).not.toContain(".agents");
  });

  it("starts from a named ref and nests slash names; a generated name uses the prefix", async () => {
    git(repo, "tag", "v1");
    writeFileSync(join(repo, "README.md"), "second\n");
    git(repo, "commit", "-q", "-am", "second");
    const nested = await createWorktree({ cwd: repo, writableRoot: repo, name: "topic/nested", from: "v1" });
    expect(nested.baseCommit).toBe(git(repo, "rev-parse", "v1^{commit}"));
    expect(nested.path.toLowerCase()).toBe(join(repo, ".agents", "worktrees", "topic", "nested").toLowerCase());
    const generated = await createWorktree({ cwd: repo, writableRoot: repo });
    expect(generated.branch.startsWith(WORKTREE_NAME_PREFIX)).toBe(true);
  });

  it("keeps an existing pool without a .gitignore untouched", async () => {
    mkdirSync(join(repo, ".agents", "worktrees"), { recursive: true });
    await createWorktree({ cwd: repo, writableRoot: repo, name: "b1" });
    expect(existsSync(join(repo, ".agents", "worktrees", ".gitignore"))).toBe(false);
  });

  it("refuses an existing branch or destination, invalid names, and bad revisions before touching anything", async () => {
    git(repo, "branch", "taken");
    await expect(createWorktree({ cwd: repo, writableRoot: repo, name: "taken" })).rejects.toThrow(/branch already exists: taken/);
    mkdirSync(join(repo, ".agents", "worktrees", "occupied"), { recursive: true });
    await expect(createWorktree({ cwd: repo, writableRoot: repo, name: "occupied" })).rejects.toThrow(/path already exists/);
    await expect(createWorktree({ cwd: repo, writableRoot: repo, name: "../escape" })).rejects.toThrow(/relative Git branch name/);
    await expect(createWorktree({ cwd: repo, writableRoot: repo, name: "x", from: " " })).rejects.toThrow(/local commit, branch, or tag/);
    await expect(createWorktree({ cwd: repo, writableRoot: repo, name: "x", from: "no-such-ref" })).rejects.toThrow(/worktree command failed/);
  });

  it("fails outside a repository and in a repository without commits", async () => {
    const plain = realpathSync.native(mkdtempSync(join(tmpdir(), "wt-plain-")));
    const empty = initRepo(false);
    try {
      await expect(createWorktree({ cwd: plain, writableRoot: plain })).rejects.toThrow(/worktree command failed/);
      await expect(createWorktree({ cwd: empty, writableRoot: empty })).rejects.toThrow(/worktree command failed/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("does not grant extra rights: the checkout must land inside the session's writable root", async () => {
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), "wt-root-")));
    try {
      await expect(createWorktree({ cwd: repo, writableRoot: elsewhere, name: "x" })).rejects.toThrow(
        /worktree directory is outside this session's writable workspace/,
      );
      expect(existsSync(join(repo, ".agents"))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("creates from a linked checkout using its own commit and pool", async () => {
    const first = await createWorktree({ cwd: repo, writableRoot: repo, name: "outer" });
    writeFileSync(join(first.path, "README.md"), "outer\n");
    git(first.path, "commit", "-q", "-am", "outer change");
    const inner = await createWorktree({ cwd: first.path, writableRoot: repo, name: "inner" });
    expect(inner.baseCommit).toBe(git(first.path, "rev-parse", "HEAD"));
    expect(inner.path.toLowerCase()).toBe(join(first.path, ".agents", "worktrees", "inner").toLowerCase());
  });
});

describe("validateWorktreeName", () => {
  it.each(["a\\b", "c:d", "-x", "a//b", "./a", "a/../b"])("rejects %s", (name) => {
    expect(() => validateWorktreeName(name)).toThrow(/relative Git branch name/);
  });
  it("accepts nested names", () => {
    expect(() => validateWorktreeName("topic/x")).not.toThrow();
  });
});
