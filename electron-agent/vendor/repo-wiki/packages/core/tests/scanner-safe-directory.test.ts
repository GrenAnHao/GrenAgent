import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { userSafeDirectoryArgs } from "../src/scanner.js";

// The scanner isolates global Git config; only the user's own safe.directory trust is forwarded,
// so a repository owned by another Windows account (the sandbox user) can still be read.
test("forwards the user's global safe.directory entries and nothing else", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-safe-dir-"));
  const config = path.join(dir, "gitconfig");
  fs.writeFileSync(config, "[safe]\n\tdirectory = D:/Repos/owned-by-sandbox\n\tdirectory = *\n[core]\n\tfsmonitor = true\n");
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(userSafeDirectoryArgs(Date.now() + 10 * 60_000), ["-c", "safe.directory=D:/Repos/owned-by-sandbox", "-c", "safe.directory=*"]);
  fs.writeFileSync(config, "[core]\n\tautocrlf = true\n");
  assert.deepEqual(userSafeDirectoryArgs(Date.now() + 20 * 60_000), []);
});
