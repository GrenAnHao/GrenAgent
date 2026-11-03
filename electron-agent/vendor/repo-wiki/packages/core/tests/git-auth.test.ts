import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  normalizeGitUrl,
  withGitEnvironment,
  cloneInto,
  cloneRepository,
  GitError,
} from "../src/git-auth.js";
const exec = promisify(execFile);
for (const url of [
  "https://user:secret@github.com/a/b",
  "http://github.com/a/b",
  "https://github.com.evil/a/b",
  "file:///tmp/repo",
  "-uhttps://github.com/a/b",
  "https://github.com/a/b?token=secret",
  "https://github.com/a/b#branch",
  "https://github.com/a/../b",
  "https://github.com/a/%2e%2e",
  "https://github.com:443/a/b",
  "https://github.com/a/b/tree/main",
  "https://github.com/a/b\n-x",
  "https://github.com/a\\b/c",
])
  test(`reject unsafe Git URL ${JSON.stringify(url)}`, () =>
    assert.throws(() => normalizeGitUrl(url), GitError));
test("nested GitLab groups and dot github repository remain valid", () => {
  assert.equal(
    normalizeGitUrl("https://gitlab.com/group/subgroup/repo.git"),
    "https://gitlab.com/group/subgroup/repo.git",
  );
  assert.equal(
    normalizeGitUrl("https://github.com/acme/repo/"),
    "https://github.com/acme/repo.git",
  );
  assert.equal(
    normalizeGitUrl("https://github.com/acme/.github"),
    "https://github.com/acme/.github.git",
  );
});
test("token only enters ephemeral child environment, executable helper has no secret", async () => {
  let wrapper = "";
  await withGitEnvironment(
    "https://github.com/a/b",
    undefined,
    async (env) => {
      assert.equal(env.REPOWIKI_GIT_TOKEN, "my-secret-token");
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.GIT_TRACE, undefined);
      assert.equal(env.GIT_CURL_VERBOSE, undefined);
      assert.equal(env.NODE_OPTIONS, undefined);
      wrapper = env.GIT_ASKPASS!;
      for (const name of await readdir(path.dirname(wrapper)))
        assert.ok(
          !(
            await readFile(path.join(path.dirname(wrapper), name), "utf8")
          ).includes("my-secret-token"),
        );
      if (process.platform !== "win32") {
        assert.equal((await lstat(wrapper)).mode & 0o077, 0);
        assert.equal(
          (
            await exec(wrapper, ["Username for https://github.com"], { env })
          ).stdout.trim(),
          "x-access-token",
        );
        assert.equal(
          (
            await exec(wrapper, ["Password for https://github.com"], { env })
          ).stdout.trim(),
          "my-secret-token",
        );
      }
    },
    {
      ...process.env,
      GITHUB_TOKEN: "my-secret-token",
      GIT_TRACE: "1",
      GIT_CURL_VERBOSE: "1",
      NODE_OPTIONS: "--require=evil",
    },
  );
  await assert.rejects(lstat(wrapper), { code: "ENOENT" });
});
test("GitHub token never reaches a different host; helper cleanup on thrown callback", async () => {
  let wrapper = "";
  await assert.rejects(
    withGitEnvironment("https://gitlab.com/a/b", "secret", async (env) => {
      assert.equal(env.REPOWIKI_GIT_TOKEN, "");
      wrapper = env.GIT_ASKPASS!;
      throw new Error("synthetic");
    }),
    /synthetic/,
  );
  await assert.rejects(lstat(wrapper), { code: "ENOENT" });
});
test("clone argv and origin have no token; safe flags and unique child retained", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "repowiki-git-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let captured: any;
  const result = await cloneRepository("https://github.com/a/b", root, {
    token: "never-in-argv",
    run: async (args, options) => {
      captured = { args, env: { ...options.env } };
      const target = args.at(-1)!;
      await mkdir(path.join(target, ".git"));
      await writeFile(
        path.join(target, ".git/config"),
        `[remote "origin"]\nurl = ${args.at(-2)}\n`,
      );
    },
  });
  assert.equal(path.dirname(result), root);
  assert.ok(!captured.args.join(" ").includes("never-in-argv"));
  assert.ok(
    !(await readFile(path.join(result, ".git/config"), "utf8")).includes(
      "never-in-argv",
    ),
  );
  assert.equal(captured.env.REPOWIKI_GIT_TOKEN, "never-in-argv");
  assert.ok(captured.args.includes("http.followRedirects=false"));
  assert.ok(captured.args.includes("core.fsmonitor=false"));
  assert.ok(captured.args.includes("--no-recurse-submodules"));
  await assert.rejects(lstat(captured.env.GIT_ASKPASS), { code: "ENOENT" });
});
test("existing destination and symlink are never deleted", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "repowiki-git-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "existing");
  await mkdir(target);
  await writeFile(path.join(target, "precious"), "keep");
  await assert.rejects(
    cloneInto("https://github.com/a/b", target),
    /already exists/,
  );
  assert.equal(await readFile(path.join(target, "precious"), "utf8"), "keep");
  if (process.platform !== "win32") {
    const link = path.join(root, "link");
    await symlink(target, link);
    await assert.rejects(
      cloneInto("https://github.com/a/b", link),
      /already exists/,
    );
    assert.equal((await lstat(link)).isSymbolicLink(), true);
  }
});
test("failure deletes only owned partial clone and exposes no Git output", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "repowiki-git-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "failed");
  await assert.rejects(
    cloneInto("https://github.com/a/b", target, {
      run: async (args) => {
        await writeFile(path.join(args.at(-1)!, "partial"), "partial");
        throw new Error("secret-token bearer private-repo-url");
      },
    }),
    (error) => {
      assert.ok(error instanceof GitError);
      assert.ok(!error.message.includes("secret-token"));
      assert.ok(!error.message.includes("private-repo-url"));
      return true;
    },
  );
  await assert.rejects(lstat(target), { code: "ENOENT" });
});
test("clone size limit and cancellation cleanup", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "repowiki-git-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "large");
  await assert.rejects(
    cloneInto("https://github.com/a/b", target, {
      maxBytes: 1,
      run: async (args) => {
        await writeFile(path.join(args.at(-1)!, "file"), "xx");
      },
    }),
    /size limit/,
  );
  await assert.rejects(lstat(target), { code: "ENOENT" });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    cloneInto("https://github.com/a/b", path.join(root, "cancel"), {
      signal: abort.signal,
    }),
    /canceled/,
  );
  await assert.rejects(lstat(path.join(root, "cancel")), { code: "ENOENT" });
});
