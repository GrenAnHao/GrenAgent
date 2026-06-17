import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAstGrep } from "./grep.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ast-grep-"));
  writeFileSync(join(root, "a.ts"), "console.log(1)\nconsole.log(2)\nfoo(3)\n");
  return root;
}

describe("runAstGrep", () => {
  it("finds matches with location", async () => {
    const root = fixture();
    const res = await runAstGrep({ pat: "console.log($A)", paths: ["a.ts"], skip: 0, cwd: root });
    expect(res.totalMatches).toBe(2);
    expect(res.matches[0]).toMatchObject({ rel: "a.ts", line: 1 });
    expect(res.matches[1].line).toBe(2);
  });
  it("supports skip and reports empty", async () => {
    const root = fixture();
    const skipped = await runAstGrep({ pat: "console.log($A)", paths: ["a.ts"], skip: 1, cwd: root });
    expect(skipped.matches).toHaveLength(1);
    expect(skipped.matches[0].line).toBe(2);

    const none = await runAstGrep({ pat: "nope($A)", paths: ["a.ts"], skip: 0, cwd: root });
    expect(none.totalMatches).toBe(0);
    expect(none.matches).toHaveLength(0);
  });
});
