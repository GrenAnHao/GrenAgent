import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectFiles } from "../ast-tools/lang.js";
import { searchWorkspace } from "../batch-tools/search.js";
import { grepWithRg, resolveRgPath } from "./ripgrep.js";

async function requireRg(): Promise<string> {
  const rg = await resolveRgPath();
  if (!rg) throw new Error("@vscode/ripgrep is required for this test");
  return rg;
}

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rg-git-"));
  execSync("git init", { cwd: root, stdio: "ignore" });
  return root;
}

describe("packaged ripgrep engine", () => {
  it("resolves the @vscode/ripgrep binary", async () => {
    const rg = await requireRg();
    expect(rg.length).toBeGreaterThan(0);
  });

  it("does not search gitignored source, matching DSH grep", async () => {
    await requireRg();
    const root = gitRepo();
    writeFileSync(join(root, ".gitignore"), "secret.ts\n");
    writeFileSync(join(root, "app.ts"), "export const ask_user = 1;\n");
    writeFileSync(join(root, "secret.ts"), "export const ask_user = 2;\n");
    const rg = await grepWithRg({ patterns: ["ask_user"], path: root, cwd: root });
    expect(rg).not.toBeNull();
    expect(rg!.error).toBeUndefined();
    const files = rg!.groups.map((g) => g.file.replace(/\\/g, "/"));
    expect(files.some((f) => f.endsWith("app.ts"))).toBe(true);
    expect(files.some((f) => f.includes("secret.ts"))).toBe(false);
  });

  it("skips tsbuildinfo via exclusion globs even when it is not gitignored", async () => {
    await requireRg();
    const root = mkdtempSync(join(tmpdir(), "rg-skip-"));
    writeFileSync(join(root, "app.ts"), "export const ask_user = 1;\n");
    writeFileSync(join(root, "tsconfig.node.tsbuildinfo"), `{"root":["ask_user"]}\n`);
    const out = await searchWorkspace({
      dir: root, cwd: root, patterns: ["ask_user"], contextLines: 0,
      maxResults: 40, maxFiles: 5000, maxFileBytes: 1048576,
    });
    expect(out.error).toBeUndefined();
    const files = out.groups.map((g) => g.file.replace(/\\/g, "/"));
    expect(files.some((f) => f.endsWith("app.ts"))).toBe(true);
    expect(files.some((f) => f.includes("tsbuildinfo"))).toBe(false);
  });

  it("collectFiles skips gitignored sources so ast_grep does not parse them", async () => {
    await requireRg();
    const root = gitRepo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".gitignore"), "secret.ts\n");
    writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "secret.ts"), "export const b = 1;\n");
    const files = await collectFiles(["."], root);
    const rels = files.map((f) => f.rel);
    expect(rels).toContain("app.ts");
    expect(rels).not.toContain("secret.ts");
  });
});
