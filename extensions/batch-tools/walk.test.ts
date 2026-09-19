import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { globToRegExp, matchesAnyGlob, walkFiles } from "./walk.js";

describe("globToRegExp", () => {
  it("maps * to a single path segment", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a/b.ts")).toBe(false);
  });
  it("maps ** to any depth, optionally zero", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/a/b.ts")).toBe(true);
    expect(re.test("lib/a.ts")).toBe(false);
  });
  it("maps ? to one non-slash char and escapes regex meta", () => {
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("matchesAnyGlob", () => {
  it("returns true when no globs given", () => {
    expect(matchesAnyGlob("any/path.ts", [])).toBe(true);
  });
  it("normalizes backslashes and matches any glob", () => {
    const globs = [globToRegExp("src/**/*.ts")];
    expect(matchesAnyGlob("src\\a\\b.ts", globs)).toBe(true);
  });
});

describe("walkFiles", () => {
  it("lists files, applies globs, skips SKIP_DIRS and hidden dirs, honors maxFiles", () => {
    const root = join(tmpdir(), `bt-walk-${Date.now()}`);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    mkdirSync(join(root, ".hidden"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "x");
    writeFileSync(join(root, "src", "b.js"), "x");
    writeFileSync(join(root, "node_modules", "c.ts"), "x");
    writeFileSync(join(root, ".hidden", "d.ts"), "x");
    const ts = walkFiles(root, { globs: ["**/*.ts"] }).map((p) => p.replace(root, "").replace(/\\/g, "/"));
    expect(ts).toContain("/src/a.ts");
    expect(ts).not.toContain("/src/b.js");
    expect(ts.some((p) => p.includes("node_modules"))).toBe(false);
    expect(ts.some((p) => p.includes(".hidden"))).toBe(false);
  });
  it("skips files larger than maxFileBytes", () => {
    const root = join(tmpdir(), `bt-walk2-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "big.ts"), "x".repeat(2000));
    writeFileSync(join(root, "small.ts"), "x");
    const out = walkFiles(root, { maxFileBytes: 100 }).map((p) => p.replace(root, "").replace(/\\/g, "/"));
    expect(out).toContain("/small.ts");
    expect(out).not.toContain("/big.ts");
  });
  it("skips tsbuildinfo and source-map artifacts even when they are under the byte cap", () => {
    const root = join(tmpdir(), `bt-walk3-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "app.ts"), "export {}");
    writeFileSync(join(root, "tsconfig.node.tsbuildinfo"), `{"root":["ask_user"]}`);
    writeFileSync(join(root, "bundle.js.map"), `{"sources":["ask_user.ts"]}`);
    const out = walkFiles(root).map((p) => p.replace(root, "").replace(/\\/g, "/"));
    expect(out).toContain("/app.ts");
    expect(out).not.toContain("/tsconfig.node.tsbuildinfo");
    expect(out).not.toContain("/bundle.js.map");
  });
  it("skips minified bundles even when they are under the byte cap", () => {
    const root = join(tmpdir(), `bt-walk4-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "app.ts"), "export {}");
    writeFileSync(join(root, "vendor.min.js"), `ask_user${"x".repeat(100)}`);
    writeFileSync(join(root, "app.min.css"), `.ask_user{${"x".repeat(100)}}`);
    const out = walkFiles(root).map((p) => p.replace(root, "").replace(/\\/g, "/"));
    expect(out).toContain("/app.ts");
    expect(out).not.toContain("/vendor.min.js");
    expect(out).not.toContain("/app.min.css");
  });
});
