import { describe, expect, it } from "vitest";
import { buildFilesArgv, buildGrepArgv, parseRgJsonLine, RG_SKIP_GLOBS } from "./ripgrep.js";

describe("buildGrepArgv", () => {
  it("matches DSH: --json, --regexp=, --glob=, path behind --, no shell", () => {
    const argv = buildGrepArgv({
      patterns: ["ask_user"],
      path: "D:/repo/electron-agent",
    });
    expect(argv[0]).toBe("--json");
    expect(argv).toContain("--regexp=ask_user");
    expect(argv[argv.length - 2]).toBe("--");
    expect(argv[argv.length - 1]).toBe("D:/repo/electron-agent");
    for (const g of RG_SKIP_GLOBS) expect(argv).toContain(`--glob=${g}`);
  });
  it("OR-s multiple patterns and honors literal, ignoreCase, context, globs, max-filesize", () => {
    const argv = buildGrepArgv({
      patterns: ["foo", "-bar"],
      path: ".",
      globs: ["src/**/*.ts"],
      ignoreCase: true,
      literal: true,
      contextLines: 2,
      maxFilesize: 1048576,
    });
    expect(argv).toContain("--fixed-strings");
    expect(argv).toContain("--ignore-case");
    expect(argv).toContain("--context=2");
    expect(argv).toContain("--max-filesize=1048576");
    expect(argv).toContain("--regexp=foo");
    expect(argv).toContain("--regexp=-bar");
    expect(argv).toContain("--glob=src/**/*.ts");
  });
});

describe("buildFilesArgv", () => {
  it("lists files with skip globs and the target behind --", () => {
    const argv = buildFilesArgv({ path: "src", globs: ["*.ts"] });
    expect(argv[0]).toBe("--files");
    expect(argv).toContain("--glob=*.ts");
    expect(argv[argv.length - 2]).toBe("--");
    expect(argv[argv.length - 1]).toBe("src");
  });
});

describe("parseRgJsonLine", () => {
  it("reads a match record and strips the trailing newline", () => {
    const line = JSON.stringify({
      type: "match",
      data: {
        path: { text: "a.ts" },
        line_number: 12,
        lines: { text: "const ask_user = 1\n" },
      },
    });
    expect(parseRgJsonLine(line)).toEqual({ path: "a.ts", line: 12, text: "const ask_user = 1", isMatch: true });
  });
  it("reads a context record as a non-match hit", () => {
    const line = JSON.stringify({
      type: "context",
      data: {
        path: { text: "a.ts" },
        line_number: 11,
        lines: { text: "import x" },
      },
    });
    expect(parseRgJsonLine(line)).toEqual({ path: "a.ts", line: 11, text: "import x", isMatch: false });
  });
  it("skips begin/end/summary and malformed lines", () => {
    expect(parseRgJsonLine('{"type":"begin","data":{}}')).toBeUndefined();
    expect(parseRgJsonLine("not-json")).toBeUndefined();
    expect(parseRgJsonLine("")).toBeUndefined();
  });
  it("uses a placeholder when ripgrep sent base64 bytes instead of utf8 text", () => {
    const line = JSON.stringify({
      type: "match",
      data: { path: { text: "a.bin" }, line_number: 1, lines: { bytes: "AAAA" } },
    });
    expect(parseRgJsonLine(line)).toEqual({
      path: "a.bin",
      line: 1,
      text: "(line is not valid UTF-8)",
      isMatch: true,
    });
  });
});
