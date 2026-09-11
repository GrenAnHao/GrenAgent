import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  hasPiThemes,
  resolveInstalledPiPackageDir,
  resolveOfficialMainPackageDir,
} from "./official-package-dir.js";

test("hasPiThemes recognizes the bun-binary layout (theme/ next to the exe)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-theme-bun-"));
  mkdirSync(join(root, "theme"));
  writeFileSync(join(root, "theme", "dark.json"), "{}");
  assert.equal(hasPiThemes(root), true);
});

test("hasPiThemes recognizes the published npm layout (dist/modes/interactive/theme)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-theme-npm-"));
  const themeDir = join(root, "dist", "modes", "interactive", "theme");
  mkdirSync(themeDir, { recursive: true });
  writeFileSync(join(themeDir, "dark.json"), "{}");
  assert.equal(hasPiThemes(root), true);
});

test("hasPiThemes is false for GrenAgent cli/ (has src/ but no pi themes)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-theme-cli-"));
  mkdirSync(join(root, "src"));
  assert.equal(hasPiThemes(root), false);
});

test("resolveOfficialMainPackageDir keeps a package dir that already has themes", () => {
  const envDir = mkdtempSync(join(tmpdir(), "pi-theme-keep-"));
  mkdirSync(join(envDir, "theme"));
  writeFileSync(join(envDir, "theme", "dark.json"), "{}");
  assert.equal(resolveOfficialMainPackageDir(envDir, "/installed"), envDir);
});

test("resolveOfficialMainPackageDir retargets cli/ to the installed pi-coding-agent package", () => {
  const cliDir = mkdtempSync(join(tmpdir(), "pi-theme-retarget-"));
  mkdirSync(join(cliDir, "src"));
  const installed = mkdtempSync(join(tmpdir(), "pi-theme-installed-"));
  const themeDir = join(installed, "dist", "modes", "interactive", "theme");
  mkdirSync(themeDir, { recursive: true });
  writeFileSync(join(themeDir, "dark.json"), "{}");
  assert.equal(resolveOfficialMainPackageDir(cliDir, installed), installed);
});

test("resolveInstalledPiPackageDir points at a package that actually has themes", () => {
  const installed = resolveInstalledPiPackageDir();
  assert.match(installed.replaceAll("\\", "/"), /@earendil-works\/pi-coding-agent$/);
  assert.equal(hasPiThemes(installed), true);
});

test("Electron-dev PI_PACKAGE_DIR=cli/ is not a theme root; the installed package is", () => {
  const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(hasPiThemes(cliDir), false);
  assert.equal(resolveOfficialMainPackageDir(cliDir, resolveInstalledPiPackageDir()), resolveInstalledPiPackageDir());
});
