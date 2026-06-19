import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAstEdit } from "./edit.js";

function fixture(content: string): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "ast-edit-"));
  const file = join(root, "a.ts");
  writeFileSync(file, content);
  return { root, file };
}

describe("runAstEdit", () => {
  it("applies a single-metavariable rewrite and writes file", async () => {
    const { root, file } = fixture("console.log(1)\nconsole.log(2)\n");
    const res = await runAstEdit({
      ops: [{ pat: "console.log($A)", out: "logger.info($A)" }],
      paths: ["a.ts"],
      dryRun: false,
      cwd: root,
    });
    expect(res.totalReplacements).toBe(2);
    expect(res.files[0]).toMatchObject({ rel: "a.ts", replacements: 2 });
    expect(readFileSync(file, "utf8")).toBe("logger.info(1)\nlogger.info(2)\n");
  });
  it("dryRun does not write", async () => {
    const { root, file } = fixture("console.log(1)\n");
    const res = await runAstEdit({
      ops: [{ pat: "console.log($A)", out: "logger.info($A)" }],
      paths: ["a.ts"],
      dryRun: true,
      cwd: root,
    });
    expect(res.totalReplacements).toBe(1);
    expect(res.applied).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("console.log(1)\n"); // 未改
  });
  it("applies multiple ops sequentially and reports zero matches", async () => {
    const { root, file } = fixture("a(1); b(2);\n");
    const res = await runAstEdit({
      ops: [
        { pat: "a($X)", out: "A($X)" },
        { pat: "nope($X)", out: "Z($X)" },
      ],
      paths: ["a.ts"],
      dryRun: false,
      cwd: root,
    });
    expect(res.totalReplacements).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("A(1); b(2);\n");
  });

  it("skips protected paths (node_modules) even when explicitly targeted", async () => {
    const root = mkdtempSync(join(tmpdir(), "ast-edit-"));
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep", "index.ts"), "log(1)");
    writeFileSync(join(root, "a.ts"), "log(2)");
    const res = await runAstEdit({
      ops: [{ pat: "log($X)", out: "warn($X)" }],
      paths: ["node_modules/dep/index.ts", "a.ts"],
      dryRun: false,
      cwd: root,
    });
    expect(res.totalReplacements).toBe(1); // 仅 a.ts
    expect(readFileSync(join(root, "node_modules", "dep", "index.ts"), "utf8")).toBe("log(1)"); // 未触碰
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("warn(2)");
    expect(res.parseErrors.some((e) => e.includes("node_modules") && e.includes("受保护"))).toBe(true);
  });

  it("rejects when files exceed maxFiles", async () => {
    const root = mkdtempSync(join(tmpdir(), "ast-edit-"));
    writeFileSync(join(root, "a.ts"), "log(1)");
    writeFileSync(join(root, "b.ts"), "log(2)");
    const res = await runAstEdit({
      ops: [{ pat: "log($X)", out: "warn($X)" }],
      paths: ["*.ts"],
      dryRun: false,
      cwd: root,
      maxFiles: 1,
    });
    expect(res.totalReplacements).toBe(0);
    expect(res.parseErrors[0]).toContain("超过上限");
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("log(1)");
  });
});
