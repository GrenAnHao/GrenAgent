import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  filterOverrideEnv,
  parseFilterDrivers,
  parseUntrustedFilterDrivers,
  runSafeGit,
  safeGitEnv,
  safeGitPrefix,
} from "./git-safe.js";

describe("git environment", () => {
  it("removes the variables that point git at another repository, index or configuration", () => {
    const env = safeGitEnv({}, {
      GIT_DIR: "x", GIT_WORK_TREE: "x", GIT_COMMON_DIR: "x", GIT_INDEX_FILE: "x", GIT_OBJECT_DIRECTORY: "x",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "x", GIT_NAMESPACE: "x", GIT_PREFIX: "x", GIT_REPLACE_REF_BASE: "x",
      GIT_ATTR_SOURCE: "x", GIT_CONFIG: "x", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "x",
      PATH: "C:/bin", HOME: "C:/home", GIT_SSH_COMMAND: "ssh",
    });
    expect(Object.keys(env).filter((key) => key.startsWith("GIT_")).sort()).toEqual(["GIT_NO_LAZY_FETCH", "GIT_OPTIONAL_LOCKS", "GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT"]);
    expect(env.PATH).toBe("C:/bin");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("keeps the user's own global and system configuration, which the workspace cannot reach", () => {
    const env = safeGitEnv({}, { GIT_CONFIG_GLOBAL: "C:/me/.gitconfig", GIT_CONFIG_SYSTEM: "C:/sys", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_PARAMETERS: "'core.x=y'" });
    expect(env.GIT_CONFIG_GLOBAL).toBe("C:/me/.gitconfig");
    expect(env.GIT_CONFIG_SYSTEM).toBe("C:/sys");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    // this one carries -c settings from a parent git process
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
  });

  it("never lets git fetch missing objects, which would run the remote's configured commands", () => {
    expect(safeGitEnv().GIT_NO_LAZY_FETCH).toBe("1");
  });

  it("lets the caller add variables after the cleaning", () => {
    expect(safeGitEnv({ GIT_CONFIG_COUNT: "1" }, { GIT_CONFIG_COUNT: "9" }).GIT_CONFIG_COUNT).toBe("1");
  });

  it("does not change the environment it was given", () => {
    const source = { GIT_DIR: "x" };
    safeGitEnv({}, source);
    expect(source).toEqual({ GIT_DIR: "x" });
  });
});

describe("git command prefix", () => {
  it("switches off the file system monitor and the hooks directory when the host runs git on its own", () => {
    const prefix = safeGitPrefix();
    expect(prefix).toContain("core.fsmonitor=false");
    expect(prefix.some((entry) => /^core\.hooksPath=(NUL|\/dev\/null)$/.test(entry))).toBe(true);
    // each value is introduced by its own -c
    expect(prefix.filter((entry) => entry === "-c")).toHaveLength(prefix.filter((entry) => entry !== "-c").length);
  });

  it("keeps the file system monitor and signature checks off in every mode", () => {
    for (const mode of ["automatic", "user"] as const) {
      expect(safeGitPrefix(mode)).toContain("core.fsmonitor=false");
      // log.showSignature=true makes git log run the configured gpg.program
      expect(safeGitPrefix(mode)).toContain("log.showSignature=false");
    }
  });

  it("leaves hooks alone for an action the user asked for", () => {
    expect(safeGitPrefix("user").some((entry) => entry.startsWith("core.hooksPath"))).toBe(false);
  });
});

describe("filter drivers", () => {
  it("reads the driver names out of git's null-separated config key list", () => {
    expect([...parseFilterDrivers("filter.lfs.clean\0filter.lfs.smudge\0filter.my.driver.process\0core.x\0")].sort()).toEqual(["lfs", "my.driver"]);
  });

  it("reads a driver whose name is empty, which an attributes line of filter= selects", () => {
    expect([...parseFilterDrivers("filter..clean\0")]).toEqual([""]);
  });

  it("keeps only the drivers some non-user scope defines (the user's own LFS definition is not the workspace's)", () => {
    const listing = ["system", "filter.lfs.clean", "global", "filter.lfs.smudge", "local", "filter.evil.clean", "worktree", "filter.w.smudge", "command", "filter.c.clean", "local", "filter..clean"].join("\0") + "\0";
    expect([...parseUntrustedFilterDrivers(listing)].sort()).toEqual(["", "c", "evil", "w"]);
    // a driver the workspace redefines is untrusted even though the user defined it too
    expect([...parseUntrustedFilterDrivers(["global", "filter.lfs.clean", "local", "filter.lfs.smudge"].join("\0") + "\0")]).toEqual(["lfs"]);
  });

  it("builds an environment that empties every command of every driver", () => {
    const env = filterOverrideEnv(["lfs"]);
    expect(env.GIT_CONFIG_COUNT).toBe("4");
    const pairs = Array.from({ length: 4 }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    expect(pairs).toEqual([
      ["filter.lfs.clean", ""],
      ["filter.lfs.smudge", ""],
      ["filter.lfs.process", ""],
      ["filter.lfs.required", "false"],
    ]);
  });

  it("is empty when there are no drivers", () => {
    expect(filterOverrideEnv([])).toEqual({});
  });
});

// every script the fixtures run is a separate sh process, about a second each on Windows
describe("running git against a workspace the sandbox could have written", { timeout: 60_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  function repository(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-gitsafe-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "one\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });
    return dir;
  }

  const posix = (path: string) => path.replace(/\\/g, "/");

  it("does not run the configured file system monitor command (control: plain git does)", async () => {
    const dir = repository();
    const marker = join(dir, "fsmonitor-ran.txt");
    writeFileSync(join(dir, "hook.sh"), `echo ran > "${posix(marker)}"\n`);
    execFileSync("git", ["config", "core.fsmonitor", `sh "${posix(join(dir, "hook.sh"))}"`], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "two\n");

    await runSafeGit(dir, ["status", "--porcelain"]);
    expect(existsSync(marker)).toBe(false);

    execFileSync("git", ["status", "--porcelain"], { cwd: dir });
    expect(existsSync(marker)).toBe(true);
  });

  it("does not run a clean filter that a configuration and an attributes file defined (control: plain git does)", async () => {
    const dir = repository();
    const marker = join(dir, "filter-ran.txt");
    writeFileSync(join(dir, "filter.sh"), `echo ran > "${posix(marker)}"\ncat\n`);
    execFileSync("git", ["config", "filter.spy.clean", `sh "${posix(join(dir, "filter.sh"))}"`], { cwd: dir });
    writeFileSync(join(dir, ".gitattributes"), "a.txt filter=spy\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");

    await runSafeGit(dir, ["diff"]);
    expect(existsSync(marker)).toBe(false);

    execFileSync("git", ["diff"], { cwd: dir });
    expect(existsSync(marker)).toBe(true);
  });

  it("does not run a diff text converter when asked not to (control: plain git does)", async () => {
    const dir = repository();
    const marker = join(dir, "textconv-ran.txt");
    writeFileSync(join(dir, "conv.sh"), `echo ran > "${posix(marker)}"\ncat "$1"\n`);
    execFileSync("git", ["config", "diff.spy.textconv", `sh "${posix(join(dir, "conv.sh"))}"`], { cwd: dir });
    writeFileSync(join(dir, ".gitattributes"), "a.txt diff=spy\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");

    await runSafeGit(dir, ["diff", "--no-textconv", "--no-ext-diff"]);
    expect(existsSync(marker)).toBe(false);

    execFileSync("git", ["diff"], { cwd: dir });
    expect(existsSync(marker)).toBe(true);
  });

  it("leaves the user's own filters and hooks alone for an action the user asked for (they are the user's workflow)", async () => {
    const dir = repository();
    const filterMarker = join(dir, "filter-ran.txt");
    writeFileSync(join(dir, "filter.sh"), `echo ran > "${posix(filterMarker)}"\ncat\n`);
    execFileSync("git", ["config", "filter.spy.clean", `sh "${posix(join(dir, "filter.sh"))}"`], { cwd: dir });
    writeFileSync(join(dir, ".gitattributes"), "a.txt filter=spy\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    await runSafeGit(dir, ["diff"], { mode: "user" });
    expect(existsSync(filterMarker)).toBe(true);

    const hookMarker = join(dir, "hook-ran.txt");
    writeFileSync(join(dir, ".git", "hooks", "post-checkout"), `#!/bin/sh\necho ran > "${posix(hookMarker)}"\n`);
    await runSafeGit(dir, ["checkout", "-q", "-b", "topic"], { mode: "user" });
    expect(existsSync(hookMarker)).toBe(true);
  });

  it("does not run a driver whose name is empty (control: plain git does)", async () => {
    const dir = repository();
    const marker = join(dir, "empty-ran.txt");
    writeFileSync(join(dir, "filter.sh"), `echo ran > "${posix(marker)}"\ncat\n`);
    execFileSync("git", ["config", "filter..clean", `sh "${posix(join(dir, "filter.sh"))}"`], { cwd: dir });
    writeFileSync(join(dir, ".gitattributes"), "a.txt filter=\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");

    await runSafeGit(dir, ["diff"]);
    expect(existsSync(marker)).toBe(false);
    execFileSync("git", ["diff"], { cwd: dir });
    expect(existsSync(marker)).toBe(true);
  });

  it("does not run a driver that only a submodule's own configuration defines (control: plain git does)", async () => {
    const dir = repository();
    const source = mkdtempSync(join(tmpdir(), "pi-gitsafe-sub-"));
    dirs.push(source);
    execFileSync("git", ["init", "-q"], { cwd: source });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: source });
    execFileSync("git", ["config", "user.name", "t"], { cwd: source });
    writeFileSync(join(source, "a.txt"), "one\n");
    execFileSync("git", ["add", "a.txt"], { cwd: source });
    execFileSync("git", ["commit", "-q", "-m", "sub"], { cwd: source });
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", posix(source), "sub"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add submodule"], { cwd: dir });

    const marker = join(dir, "submodule-ran.txt");
    writeFileSync(join(dir, "filter.sh"), `echo ran > "${posix(marker)}"\ncat\n`);
    execFileSync("git", ["config", "filter.spy.clean", `sh "${posix(join(dir, "filter.sh"))}"`], { cwd: join(dir, "sub") });
    writeFileSync(join(dir, "sub", ".gitattributes"), "a.txt filter=spy\n");
    // exactly as many bytes as the checkout wrote (line-ending conversion may have added some): a different size would tell
    // git the file changed without it having to run the filter
    const size = statSync(join(dir, "sub", "a.txt")).size;
    writeFileSync(join(dir, "sub", "a.txt"), `${"t".repeat(size - 1)}\n`);

    await runSafeGit(dir, ["status", "--porcelain"]);
    expect(existsSync(marker)).toBe(false);
    execFileSync("git", ["status", "--porcelain"], { cwd: dir });
    expect(existsSync(marker)).toBe(true);
  });

  it("keeps a driver the user defined in their own configuration, so an LFS repository does not show touched files as modified", async () => {
    const dir = repository();
    // a "clean" that upper-cases, defined only in the user's global configuration
    const upper = `${dir}-upper.sh`;
    const global = `${dir}-global.gitconfig`;
    dirs.push(upper, global);
    writeFileSync(upper, "tr a-z A-Z\n");
    writeFileSync(global, `[filter "up"]\n\tclean = sh "${posix(upper)}"\n`);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: global };
    writeFileSync(join(dir, ".gitattributes"), "a.txt filter=up\n");
    execFileSync("git", ["add", ".gitattributes", "a.txt"], { cwd: dir, env });
    execFileSync("git", ["commit", "-q", "-m", "filtered"], { cwd: dir, env });
    // same content, new modification time: the index entry is stale, so git has to run the filter to compare
    writeFileSync(join(dir, "a.txt"), "one\n", { flag: "w" });
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, "a.txt"), later, later);

    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, env }).toString().trim()).toBe("");
    const { stdout } = await runSafeGit(dir, ["status", "--porcelain"], { env: { GIT_CONFIG_GLOBAL: global } });
    expect(stdout.trim()).toBe("");
  });

  it("does not run hooks when the host asked on its own (control: plain git does)", async () => {
    const dir = repository();
    const marker = join(dir, "hook-ran.txt");
    writeFileSync(join(dir, ".git", "hooks", "reference-transaction"), `#!/bin/sh\necho ran >> "${posix(marker)}"\n`);

    await runSafeGit(dir, ["branch", "from-host"]);
    expect(existsSync(marker)).toBe(false);
    execFileSync("git", ["branch", "from-user"], { cwd: dir });
    expect(existsSync(marker)).toBe(true);
  });

  it("refuses to go on when it cannot tell which drivers the configuration defines", async () => {
    const dir = repository();
    const broken = join(dir, "broken.gitconfig");
    writeFileSync(broken, "[filter\n");
    await expect(runSafeGit(dir, ["status", "--porcelain"], { env: { GIT_CONFIG_GLOBAL: broken } })).rejects.toThrow(/^git config /);
  });

  it("says why a command that never ran properly failed", async () => {
    const dir = repository();
    await expect(runSafeGit(dir, ["status", "--porcelain"], { timeoutMs: 1 })).rejects.toThrow(/timed out|stopped/);
  });

  it("still reports the changes", async () => {
    const dir = repository();
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
    const { stdout } = await runSafeGit(dir, ["status", "--porcelain"]);
    expect(stdout.split(/\r?\n/).filter(Boolean).sort()).toEqual([" M a.txt", "?? b.txt"]);
    expect((await runSafeGit(dir, ["diff", "--no-textconv", "--no-ext-diff"])).stdout).toContain("+two");
  });

  it("returns the exit code of a command that is allowed to fail, and throws for one that is not", async () => {
    const dir = repository();
    expect((await runSafeGit(dir, ["show-ref", "--verify", "--quiet", "refs/heads/nope"], { allowCodes: [0, 1] })).code).toBe(1);
    await expect(runSafeGit(dir, ["show-ref", "--verify", "--quiet", "refs/heads/nope"])).rejects.toThrow(/failed/);
  });

  it("takes the repository from -C and not from the process's own directory", async () => {
    const dir = repository();
    const other = mkdtempSync(join(tmpdir(), "pi-gitsafe-other-"));
    dirs.push(other);
    expect((await runSafeGit(dir, ["rev-parse", "--show-toplevel"])).stdout.trim().toLowerCase()).toBe(posix(dir).toLowerCase());
    // a directory that is not a repository is reported as such
    await expect(runSafeGit(other, ["status", "--porcelain"])).rejects.toThrow();
  });

  it.skipIf(process.platform !== "win32")("never runs a git.exe that sits in the workspace, even when Windows would look there first", async () => {
    const dir = repository();
    // A copy of whoami: if it runs as "git", the output is a user name and not porcelain.
    copyFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), join(dir, "git.exe"));
    writeFileSync(join(dir, "a.txt"), "two\n");
    const saved = process.env.NoDefaultCurrentDirectoryInExePath;
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    try {
      // control: the way the host used to call it
      let plain = "";
      try {
        plain = execFileSync("git", [], { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).toString();
      } catch (error) {
        plain = String((error as { stdout?: Buffer }).stdout ?? "");
      }
      expect(plain).not.toContain("usage: git");
      const { stdout } = await runSafeGit(dir, ["status", "--porcelain"]);
      expect(stdout).toContain(" M a.txt");
    } finally {
      if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved;
    }
  });
});
