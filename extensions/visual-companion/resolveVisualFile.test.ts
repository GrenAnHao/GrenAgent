import { expect, test } from "vitest";
import { resolveVisualFile } from "./resolveVisualFile.js";

test("resolves a workspace html file", () => {
  expect(resolveVisualFile("D:/work", "deepseek-landing/index.html")).toMatch(/deepseek-landing[\\/]index\.html$/);
});

test("rejects paths outside the workspace", () => {
  expect(() => resolveVisualFile("D:/work", "../secret.html")).toThrow(/工作区/);
});

test("rejects non-html files", () => {
  expect(() => resolveVisualFile("D:/work", "notes.md")).toThrow(/\.html/);
});
