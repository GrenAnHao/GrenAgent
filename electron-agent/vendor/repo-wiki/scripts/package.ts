/** Reproducible source + compiled runtime archive; excludes user/runtime/secret files. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const target = path.resolve(
  process.argv[2] ??
    path.join(root, "../Gren_RepoWiki_TypeScript_Electron.zip"),
);
const denied = new Set([
  "node_modules",
  ".git",
  ".runtime",
  ".repowiki-node",
  ".repowiki-workspace",
  ".openai",
  ".venv",
  ".cache",
  "coverage",
  ".npm",
  ".agents",
  ".codex",
]);
const files: Record<string, [Uint8Array, { mtime: Date }]> =
  Object.create(null);
const date = new Date("2026-10-30T00:00:00Z");
function walk(dir: string) {
  for (const item of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (denied.has(item.name) || item.isSymbolicLink()) continue;
    const full = path.join(dir, item.name),
      rel = path.relative(root, full).split(path.sep).join("/");
    if (item.isDirectory()) walk(full);
    else if (
      item.isFile() &&
      !/(?:\.sqlite(?:3|-wal|-shm)?|\.db|\.log|\.pem|\.key|\.zip)$/.test(
        item.name,
      ) &&
      (!item.name.startsWith(".env") || item.name.endsWith(".example"))
    ) {
      files["gren-repowiki-ts/" + rel] = [
        fs.readFileSync(full),
        { mtime: date },
      ];
    }
  }
}
walk(root);
const bytes = zipSync(files, { level: 6 });
fs.writeFileSync(target, bytes);
console.log(
  JSON.stringify(
    {
      path: target,
      files: Object.keys(files).length,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    null,
    2,
  ),
);
