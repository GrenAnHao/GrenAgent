import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
});
