import { describe, it, expect } from "vitest";
import { markdownFiles } from "./imports";
const file = (name: string, text: string, path = "") =>
  ({
    name,
    size: text.length,
    webkitRelativePath: path,
    text: async () => text,
  }) as File;
describe("safe Markdown import payload", () => {
  it("preserves nested paths and hidden manifest while removing directory picker wrapper", async () => {
    expect(
      await markdownFiles([
        file("core.md", "# Core", "wiki/modules/core.md"),
        file(".repowiki-manifest.json", "{}", "wiki/.repowiki-manifest.json"),
      ]),
    ).toEqual({ "modules/core.md": "# Core", ".repowiki-manifest.json": "{}" });
  });
  it("rejects traversal before any upload", async () => {
    await expect(
      markdownFiles([file("x.md", "unsafe", "wiki/../x.md")]),
    ).rejects.toThrow("路径不安全");
  });
  it("rejects colliding leaf filenames and irrelevant files", async () => {
    await expect(
      markdownFiles([file("x.md", "one"), file("x.md", "two")]),
    ).rejects.toThrow("文件名重复");
    await expect(
      markdownFiles([file("script.js", "alert(1)")]),
    ).rejects.toThrow("目录仅应");
  });
  it("bounds import size", async () => {
    await expect(
      markdownFiles([{ ...file("large.md", "x"), size: 10_000_001 } as File]),
    ).rejects.toThrow("10 MB");
  });
});
