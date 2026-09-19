import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAIN_CJS_PACKAGE_JSON = { type: 'commonjs' } as const;

function mainPackageJsonPath(outDir: string): string {
  return join(outDir, 'package.json');
}

export function writeMainCjsPackageJson(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(mainPackageJsonPath(outDir), `${JSON.stringify(MAIN_CJS_PACKAGE_JSON)}\n`);
}

export function removeMainCjsPackageJson(outDir: string): void {
  const path = mainPackageJsonPath(outDir);
  if (existsSync(path)) unlinkSync(path);
}
