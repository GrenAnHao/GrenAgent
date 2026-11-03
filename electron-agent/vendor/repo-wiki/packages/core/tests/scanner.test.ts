import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  canonicalJson,
  hash,
  safeRelative,
  matches,
  identity,
  scanRepository,
} from "../src/scanner.js";
function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-scan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write: (name: string, body: string | Buffer) => {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), body);
    },
  };
}
const scan = (root: string, options = {}) =>
  scanRepository(root, {
    include: ["**"],
    exclude: [],
    language: "zh",
    ...options,
  });
test("canonical JSON and namespace hashes preserve Python compact sorted Unicode JSON", () => {
  assert.equal(
    canonicalJson({ z: 1, a: ["中文", true, null], nested: { b: 2, a: "x" } }),
    '{"a":["中文",true,null],"nested":{"a":"x","b":2},"z":1}',
  );
  assert.equal(canonicalJson({ "\u{10000}": 1, "\ue000": 2 }), '{"":2,"𐀀":1}');
  assert.equal(
    hash(["main", "zh"]),
    "82fb0fa18ab9bbe427be02a608e0e7bc3f4f4880b537f0b924fb7f42538b4502",
  );
  assert.throws(() => canonicalJson({ bad: undefined }));
});
test("relative paths reject traversal, drive paths, controls, ambiguous slashes and glob misuse", () => {
  for (const value of [
    "",
    null,
    42,
    "../a",
    "a/../b",
    "a//b",
    "a/./b",
    "/tmp/a",
    "C:/a",
    "a\\b",
    "a\0b",
    "a\nb",
    "a*",
  ])
    assert.throws(() => safeRelative(value));
  assert.equal(safeRelative("src/**", true), "src/**");
  assert.equal(safeRelative("模块/a.ts"), "模块/a.ts");
  assert(matches("a.ts", ["**/*.ts"]));
  assert(matches("a/b/c.ts", ["*.ts"]));
  assert(!matches("a.md", ["*.ts"]));
  assert(matches("x/a.ts", ["x/[ab].ts"]));
});
test("scanner only reads regular scoped text, excluding credentials, symlinks and generated directories", (t) => {
  const f = fixture(t);
  f.write("src/main.ts", "export const main = 1;\n");
  f.write("README.md", "# Hi\n");
  f.write(".env", "SECRET");
  f.write(".env.local", "SECRET");
  f.write(".env.example", "KEY=example");
  f.write("private.pem", "SECRET");
  f.write("nested/secrets.json", "SECRET");
  f.write(".aws/config", "SECRET");
  f.write(".codex/config.toml", "SECRET");
  f.write("node_modules/code.js", "SECRET");
  f.write("dist/index.js", "SECRET");
  f.write("binary.txt", Buffer.from([65, 0, 66]));
  f.write("bad.txt", Buffer.from([0xff]));
  f.write("outside.txt", "linked");
  fs.symlinkSync(
    path.join(f.root, "outside.txt"),
    path.join(f.root, "linked.txt"),
  );
  fs.symlinkSync(path.join(f.root, "src"), path.join(f.root, "linked-dir"));
  const result = scan(f.root);
  assert.deepEqual(result.files.map((file) => file.path).sort(), [
    ".env.example",
    "README.md",
    "outside.txt",
    "src/main.ts",
  ]);
  assert.equal(result.coverage.skipped.symlink, 2);
  assert(result.coverage.partial);
  assert.equal(result.coverage.skipped.invalid_utf8, 1);
});
test("safe ignore files honor negation, directory rules, and cannot be read via symlinks", (t) => {
  const f = fixture(t);
  f.write(".gitignore", "*.txt\n!keep.txt\nignored/\n");
  f.write("drop.txt", "drop");
  f.write("keep.txt", "keep");
  f.write("ignored/a.ts", "ignored");
  f.write("src/a.ts", "okay");
  assert.deepEqual(
    scan(f.root)
      .files.map((f) => f.path)
      .sort(),
    [".gitignore", "keep.txt", "src/a.ts"],
  );
  fs.unlinkSync(path.join(f.root, ".gitignore"));
  fs.symlinkSync(
    path.join(f.root, "keep.txt"),
    path.join(f.root, ".gitignore"),
  );
  assert(scan(f.root).files.some((f) => f.path === "drop.txt"));
});
test("scope filters and nested data exclusion do not exclude repositories hosted below dataDir", (t) => {
  const f = fixture(t);
  f.write("src/a.ts", "a");
  f.write("src/b.test.ts", "b");
  f.write("docs/a.md", "a");
  f.write("custom-state/state.json", "private");
  assert.deepEqual(
    scan(f.root, { include: ["src/**"], exclude: ["**/*.test.ts"] }).files.map(
      (f) => f.path,
    ),
    ["src/a.ts"],
  );
  assert(
    !scan(f.root, { dataDir: path.join(f.root, "custom-state") }).files.some(
      (f) => f.path.startsWith("custom-state/"),
    ),
  );
  assert(
    scan(f.root, { dataDir: path.dirname(f.root) }).files.some(
      (f) => f.path === "src/a.ts",
    ),
  );
});
test("bounded file, byte, oversized, minified and UTF-8 handling reports partial coverage", (t) => {
  const f = fixture(t);
  f.write("README.md", "readme");
  f.write("src/a.ts", "export const a = 1");
  f.write("src/b.ts", "export const b = 2");
  f.write("docs.md", "docs");
  f.write("big.ts", "a".repeat(205000));
  f.write("min.js", "x".repeat(1200));
  const result = scan(f.root, { maxFiles: 2 });
  assert.deepEqual(
    result.files.map((f) => f.path),
    ["README.md", "src/a.ts"],
  );
  assert(result.coverage.partial);
  assert.equal(result.coverage.skipped.oversized, 1);
  assert(result.coverage.skipped.file_limit! >= 2);
  const bytes = scan(f.root, { maxTotalBytes: 10 });
  assert.equal(
    bytes.files.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0),
    10,
  );
  assert(bytes.coverage.skipped.byte_limit);
});
test("JS TS resolver follows literal ESM CommonJS export and index imports, but not comments or external packages", (t) => {
  const f = fixture(t);
  f.write(
    "src/main.ts",
    `import {a} from './a.js';\nexport {b} from './b';\nimport './side';\nconst util = require('./util');\nconst lazy = import('./lazy');\n// import x from './fake'\nimport fs from 'node:fs';\n`,
  );
  for (const name of [
    "a.ts",
    "b/index.ts",
    "side.ts",
    "util.cjs",
    "lazy.ts",
    "fake.ts",
  ])
    f.write("src/" + name, "export const value = 1;");
  assert.deepEqual(scan(f.root).edges, [
    ["src/main.ts", "src/a.ts"],
    ["src/main.ts", "src/b/index.ts"],
    ["src/main.ts", "src/lazy.ts"],
    ["src/main.ts", "src/side.ts"],
    ["src/main.ts", "src/util.cjs"],
  ]);
});
test("Python absolute, src layout, relative and from-package submodule imports are resolved", (t) => {
  const f = fixture(t);
  f.write(
    "src/pkg/main.py",
    "from . import util\nfrom .sub import x\nimport pkg.api, pkg.service as service\n# import pkg.fake\n",
  );
  for (const name of [
    "__init__.py",
    "util.py",
    "sub/__init__.py",
    "sub/x.py",
    "api.py",
    "service.py",
    "fake.py",
  ])
    f.write("src/pkg/" + name, "value = 1\n");
  assert.deepEqual(scan(f.root).edges, [
    ["src/pkg/main.py", "src/pkg/__init__.py"],
    ["src/pkg/main.py", "src/pkg/api.py"],
    ["src/pkg/main.py", "src/pkg/service.py"],
    ["src/pkg/main.py", "src/pkg/sub/__init__.py"],
    ["src/pkg/main.py", "src/pkg/sub/x.py"],
    ["src/pkg/main.py", "src/pkg/util.py"],
  ]);
});
test("Go module packages, Rust modules and Java imports resolve only scanned local files", (t) => {
  const f = fixture(t);
  f.write("go.mod", "module example.com/app\n");
  f.write("main.go", 'package main\nimport "example.com/app/internal/store"\n');
  f.write("internal/store/a.go", "package store");
  f.write("internal/store/a_test.go", "package store");
  f.write("src/lib.rs", "mod foo;\nuse crate::foo::Item;\n");
  f.write("src/foo.rs", "pub struct Item;");
  f.write("src/main/java/app/Main.java", "import app.Store;\n");
  f.write("src/main/java/app/Store.java", "class Store {}");
  const edges = scan(f.root).edges;
  assert(
    edges.some(([a, b]) => a === "main.go" && b === "internal/store/a.go"),
  );
  assert(!edges.some(([, b]) => b.endsWith("_test.go")));
  assert(edges.some(([a, b]) => a === "src/lib.rs" && b === "src/foo.rs"));
  assert(
    edges.some(([a, b]) => a.endsWith("Main.java") && b.endsWith("Store.java")),
  );
});
test("Git identity is scoped, branch-sensitive and never invokes configured hooks or filters", (t) => {
  const f = fixture(t);
  f.write("src/a.ts", "export const a = 1\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", f.root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  git("init", "-b", "main");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "add",
    ".",
  );
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  let result = scan(f.root);
  assert.equal(result.identity.branch, "main");
  assert.equal(result.identity.dirty, false);
  assert.equal(result.identity.is_git, true);
  git(
    "config",
    "core.fsmonitor",
    `sh -c 'touch "${path.join(f.root, "executed")}"'`,
  );
  git(
    "config",
    "filter.evil.clean",
    `sh -c 'touch "${path.join(f.root, "executed")}"; cat'`,
  );
  f.write(".gitattributes", "*.ts filter=evil\n");
  f.write("src/a.ts", "export const a = 2\n");
  result = scan(f.root);
  assert.equal(result.identity.dirty, true);
  assert(!fs.existsSync(path.join(f.root, "executed")));
  git("config", "--unset", "core.fsmonitor");
  git("config", "--unset", "filter.evil.clean");
  git("checkout", "-b", "feature");
  assert.equal(identity(f.root, {}, "en").branch, "feature");
});
test("malicious inherited GIT_DIR cannot redirect metadata to another repository", (t) => {
  const f = fixture(t);
  f.write("a.ts", "const a=1");
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = "/does/not/exist";
  try {
    assert.equal(scan(f.root).identity.branch, "local");
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

test("import-looking strings and docstrings are not dependency evidence", (t) => {
  const f = fixture(t);
  f.write(
    "main.ts",
    `const text = "import x from './fake'";\nconst template = \`require('./fake')\`;\n`,
  );
  f.write("fake.ts", "export const fake=1;");
  f.write("main.py", `"""\nimport fake\nfrom fake import x\n"""\n`);
  f.write("fake.py", "x=1");
  assert.deepEqual(scan(f.root).edges, []);
});
test("wildcard matching is bounded for adversarial repeated stars", () => {
  assert.equal(matches("a".repeat(400) + "b", ["*a".repeat(100) + "c"]), false);
  assert(matches("a.ts", ["[!b]*.ts"]));
});

test("empty files are not advertised as line evidence", (t) => {
  const f = fixture(t);
  f.write("empty.ts", "");
  const result = scan(f.root);
  assert.equal(result.files.length, 0);
  assert.equal(result.coverage.skipped.empty, 1);
});
