#!/usr/bin/env node
// 校验 docs/decisions/ 下的决策笔记是否符合约定。
// 用法: node scripts/check-notes.mjs [目录]
// 已挂到 .git/hooks/pre-commit；也可手动运行。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOTES = process.argv[2]
  ? resolve(process.argv[2])
  : join(ROOT, "docs", "decisions");
const NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const REQUIRED = ["## 背景", "## 决定", "## 放弃的方案", "## 后果"];
const SKIP = new Set(["README.md"]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith(".md")) yield full;
  }
}

// 模板 / 示例 / README，以及任何路径段以 _ 开头的文件，都不参与校验。
function isExempt(relPath) {
  const segments = relPath.split("/");
  if (segments.some((s) => s.startsWith("_"))) return true;
  return SKIP.has(segments.at(-1));
}

if (!existsSync(NOTES)) {
  console.error(`目录不存在: ${NOTES}`);
  process.exit(1);
}

const errors = [];
let checked = 0;

for (const file of walk(NOTES)) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  const base = file.split(/[\\/]/).pop();
  if (isExempt(rel)) continue;

  checked += 1;
  const text = readFileSync(file, "utf8");

  if (!NAME.test(base)) {
    errors.push(`${rel}: 文件名应为 YYYY-MM-DD-<短语>.md`);
  }
  if (!text.startsWith("---")) {
    errors.push(`${rel}: 缺少 frontmatter`);
  }
  for (const section of REQUIRED) {
    if (!text.includes(section)) errors.push(`${rel}: 缺少小节 ${section}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`notes OK (checked ${checked})`);
