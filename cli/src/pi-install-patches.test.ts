import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep, win32 } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installedPiRoot = join(cliRoot, "node_modules/@earendil-works/pi-coding-agent");
const projects = ["cli", "extensions", "electron-agent"] as const;
const scripts = ["patch-pi-shell.mjs", "patch-pi-edit-preview.mjs"] as const;
const shellFile = "dist/utils/shell.js";
const diffFile = "dist/core/tools/edit-diff.js";
const Diff = createRequire(join(installedPiRoot, "package.json"))("diff");

// Source maps retain upstream TypeScript even after postinstall patches dist JS.
// Recompile those sources so every run starts with the published, unpatched code.
function upstreamSource(relativeFile: string): string {
  const map = JSON.parse(readFileSync(join(installedPiRoot, `${relativeFile}.map`), "utf8"));
  assert.equal(typeof map.sourcesContent?.[0], "string", "published SDK includes original sources");
  return ts.transpileModule(map.sourcesContent[0], {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-install-patches-"));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "cli/scripts"), { recursive: true });
  for (const script of scripts) copyFileSync(join(cliRoot, "scripts", script), join(root, "cli/scripts", script));
  const source = { [shellFile]: upstreamSource(shellFile), [diffFile]: upstreamSource(diffFile) };
  const packageFile = (project: string, relativeFile: string) => join(root, project, "node_modules/@earendil-works/pi-coding-agent", relativeFile);
  for (const project of projects) {
    for (const [relativeFile, text] of Object.entries(source)) {
      const target = packageFile(project, relativeFile);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
  return {
    root, source, packageFile,
    run(script: string, project: string, explicit = true) {
      return spawnSync(process.execPath, [join(root, "cli/scripts", script), ...(explicit ? [join(root, project)] : [])], {
        cwd: root, encoding: "utf8", windowsHide: true,
      });
    },
  };
}

function evaluate(source: string, globals: Record<string, unknown>): Record<string, any> {
  const executable = source.replace(/^import .+;\r?\n/gm, "").replace(/^export /gm, "");
  return runInNewContext(`${executable}\n;({ getShellConfig: typeof getShellConfig === 'function' ? getShellConfig : undefined, getPowerShellConfig: typeof getPowerShellConfig === 'function' ? getPowerShellConfig : undefined, generateDiffString: typeof generateDiffString === 'function' ? generateDiffString : undefined, generateUnifiedPatch: typeof generateUnifiedPatch === 'function' ? generateUnifiedPatch : undefined });`, globals);
}

function shell(source: string, paths: string[], spawn: (command: string, args: string[], options: any) => any,
  env: Record<string, string> = {}) {
  const known = new Set(paths.map((path) => win32.normalize(path).toLowerCase()));
  return evaluate(source, {
    process: { platform: "win32", env: { SystemRoot: "E:\\Windows", PATH: "C:\\Stale", ...env } },
    accessSync(path: string) {
      if (!known.has(win32.normalize(path).toLowerCase())) throw new Error(`ENOENT: ${path}`);
    },
    constants: { F_OK: 0 }, win32, join: win32.join, delimiter: ";", spawnSync: spawn,
  });
}

const oldText = Array.from({ length: 21 }, (_, i) => `line-${i + 1}`).join("\n");
const newText = oldText.replace("line-11\n", "changed-11\n");
const expectedDisplay = "    ...\n  6 line-6\n  7 line-7\n  8 line-8\n  9 line-9\n 10 line-10\n-11 line-11\n+11 changed-11\n 12 line-12\n 13 line-13\n 14 line-14\n 15 line-15\n 16 line-16\n    ...";

// Catches a postinstall that silently patches CLI while the caller uses another SDK copy.
for (const project of projects) {
  test(`postinstall patches the requested ${project} SDK and is byte-idempotent`, (t) => {
    const f = fixture(t);
    for (const script of scripts) {
      const result = f.run(script, project);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const diff = evaluate(readFileSync(f.packageFile(project, diffFile), "utf8"), { Diff });
    assert.equal(diff.generateDiffString(oldText, newText).diff, expectedDisplay);
    assert.equal(diff.generateDiffString(oldText, newText).firstChangedLine, 11);
    assert.equal(diff.generateUnifiedPatch("sample.txt", oldText, newText),
      "--- sample.txt\n+++ sample.txt\n@@ -7,9 +7,9 @@\n line-7\n line-8\n line-9\n line-10\n-line-11\n+changed-11\n line-12\n line-13\n line-14\n line-15\n");
    for (const script of scripts) {
      const target = f.packageFile(project, script === scripts[0] ? shellFile : diffFile);
      const before = readFileSync(target, "utf8");
      const rerun = f.run(script, project);
      assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
      assert.equal(readFileSync(target, "utf8"), before);
    }
  });
}

test("legacy no-argument invocation still patches CLI beside the scripts", (t) => {
  const f = fixture(t);
  for (const script of scripts) {
    const result = f.run(script, "cli", false);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const diff = evaluate(readFileSync(f.packageFile("cli", diffFile), "utf8"), { Diff });
  assert.equal(diff.generateDiffString(oldText, newText).diff, expectedDisplay);
});

// Catches the old marker-only patch whose generic `where` call was never wired up.
test("patched resolver finds nondefault Git Bash with stale process PATH", (t) => {
  const f = fixture(t);
  const result = f.run(scripts[0], "cli");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const gitBash = "D:\\Portable Git\\bin\\bash.exe";
  const resolver = shell(readFileSync(f.packageFile("cli", shellFile), "utf8"), [gitBash], (command, args, options) => {
    if (command === "E:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") {
      return { status: 0, stdout: "D:\\Portable Git\\cmd;C:\\Stale\n" };
    }
    if (command === "E:\\Windows\\System32\\where.exe" && args[0] === "git.exe" &&
      options.env.PATH === "C:\\Stale;D:\\Portable Git\\cmd") {
      return { status: 0, stdout: "D:\\Portable Git\\cmd\\git.exe\r\n" };
    }
    return { status: 1, stdout: "" };
  });
  assert.equal(resolver.getShellConfig().shell, gitBash);
  assert.equal(JSON.stringify(resolver.getShellConfig().args), '["-c"]');
});

// Catches a fallback that keeps using bare where or throws away the registry PATH.
test("patched resolver also finds PATH bash outside a Git installation", (t) => {
  const f = fixture(t);
  assert.equal(f.run(scripts[0], "cli").status, 0);
  const bash = "D:\\MSYS\\usr\\bin\\bash.exe";
  const resolver = shell(readFileSync(f.packageFile("cli", shellFile), "utf8"), [bash], (command, args, options) => {
    if (command.endsWith("\\powershell.exe")) return { status: 0, stdout: "D:\\MSYS\\usr\\bin" };
    if (command === "E:\\Windows\\System32\\where.exe" && args[0] === "bash.exe" && options.env.PATH.includes("D:\\MSYS\\usr\\bin")) {
      return { status: 0, stdout: bash };
    }
    return { status: 1, stdout: "" };
  });
  assert.equal(resolver.getShellConfig().shell, bash);
});

// Catches a string-escaping error in the conventional Windows-directory fallback.
test("Windows discovery works when SystemRoot and WINDIR are absent", (t) => {
  const f = fixture(t);
  assert.equal(f.run(scripts[0], "cli").status, 0);
  const bash = "D:\\Portable Git\\bin\\bash.exe";
  const resolver = shell(readFileSync(f.packageFile("cli", shellFile), "utf8"), [bash], (command, args) => {
    if (command === "C:\\Windows\\System32\\where.exe" && args[0] === "git.exe") {
      return { status: 0, stdout: "D:\\Portable Git\\cmd\\git.exe" };
    }
    return { status: 1, stdout: "" };
  }, { SystemRoot: "", WINDIR: "" });
  assert.equal(resolver.getShellConfig().shell, bash);
});

// Catches reintroduction of existsSync or loss of 1.4's SystemRoot and PowerShell fixes.
test("shell patch preserves SDK 1.4 Store alias, WSL transport and PowerShell fallbacks", (t) => {
  const f = fixture(t);
  assert.equal(f.run(scripts[0], "cli").status, 0);
  const alias = "C:\\Users\\Example\\WindowsApps\\bash.exe";
  const wsl = "E:\\Windows\\System32\\bash.exe";
  const pwsh = "D:\\Apps\\PowerShell\\7\\pwsh.exe";
  const resolver = shell(readFileSync(f.packageFile("cli", shellFile), "utf8"), [alias, wsl, pwsh],
    () => ({ status: 1, stdout: "" }), { ProgramFiles: "D:\\Apps" });
  assert.equal(resolver.getShellConfig(alias).shell, alias);
  assert.equal(resolver.getShellConfig(wsl).commandTransport, "stdin");
  assert.equal(JSON.stringify(resolver.getShellConfig(wsl).args), '["-s"]');
  assert.equal(resolver.getPowerShellConfig().shell, pwsh);
});

// Catches partly-applied replacements being written as if installation succeeded.
for (const [script, relativeFile] of [[scripts[0], shellFile], [scripts[1], diffFile]]) {
  test(`${script} rejects an unexpected upstream shape without modifying it`, (t) => {
    const f = fixture(t);
    const target = f.packageFile("cli", relativeFile);
    const unexpected = "export function unrelated() { return 42; }\n";
    writeFileSync(target, unexpected);
    const result = f.run(script, "cli");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(readFileSync(target, "utf8"), unexpected);
  });
}

test("shell installer rejects an old helper marker without treating it as complete", (t) => {
  const f = fixture(t);
  const target = f.packageFile("cli", shellFile);
  const incomplete = f.source[shellFile] + "\nfunction getWindowsSearchPath() { return ''; }\n";
  writeFileSync(target, incomplete);
  const result = f.run(scripts[0], "cli");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(readFileSync(target, "utf8"), incomplete);
});
