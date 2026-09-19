import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('embedded CodeGraph packaging', () => {
  it('pins the SDK and unpacks its platform resources', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const config = parse(readFileSync(resolve('electron-builder.yml'), 'utf8'));
    expect(manifest.dependencies['@colbymchenry/codegraph']).toBe('1.6.0');
    expect(manifest.scripts['test:codegraph']).toBe('node scripts/test-codegraph.mjs');
    expect(manifest.dependencies.electron).toBeUndefined();
    expect(manifest.devDependencies.electron).toBe('^38.0.0');
    expect(config.asarUnpack).toContain('node_modules/@colbymchenry/**');
    expect(config.asarUnpack).toContain('node_modules/@vscode/ripgrep/**');
    expect(config.asarUnpack).toContain('node_modules/@vscode/ripgrep-*/**');
    expect(config.asarUnpack).toContain('node_modules/.pnpm/@vscode+ripgrep*/**');
    expect(config.afterPack).toBe('./scripts/package-codegraph.cjs');
  });

  it('keeps the SDK external so native, grammar and worker paths survive the build', () => {
    const config = readFileSync(resolve('electron.vite.config.ts'), 'utf8');
    expect(config).toContain('"@colbymchenry/codegraph"');
    expect(config).toContain('"@vscode/ripgrep"');
  });

  it('restores the SDK bundled dependencies excluded by the app dependency collector', async () => {
    const require = createRequire(import.meta.url);
    const { Arch } = require('electron-builder');
    const root = await mkdtemp(join(tmpdir(), 'pi-sdk-packaging-'));
    const platform = `codegraph-${process.platform}-${process.arch}`;
    const target = join(root, 'app.asar.unpacked/node_modules/@colbymchenry', platform, 'lib');
    try {
      await mkdir(target, { recursive: true });
      await require(resolve('scripts/package-codegraph.cjs'))({ arch: Arch[process.arch], electronPlatformName: process.platform, appOutDir: root,
        packager: { getResourcesDir: () => root } });
      expect((await stat(join(target, 'node_modules/web-tree-sitter/tree-sitter.wasm'))).isFile()).toBe(true);
      expect((await stat(join(target, 'node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm'))).isFile()).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);
});
