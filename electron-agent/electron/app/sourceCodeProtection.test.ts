import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import viteConfig from '../../electron.vite.config';
import { removeMainCjsPackageJson, writeMainCjsPackageJson } from '../agent/writeMainCjsPackageJson';

const root = resolve(__dirname, '../..');

type ViteCommand = 'build' | 'serve';

type ViteSlice = {
  main: {
    build?: {
      bytecode?: unknown;
      rollupOptions?: { output?: unknown };
    };
  };
  preload: { build?: { bytecode?: unknown } };
  renderer?: { build?: { bytecode?: unknown } };
};

function resolveViteConfig(command: ViteCommand): ViteSlice {
  if (typeof viteConfig !== 'function') {
    throw new Error('electron.vite.config must export defineConfig(({ command }) => ...)');
  }
  return viteConfig({ command, mode: command === 'build' ? 'production' : 'development' });
}

function outputFormat(output: unknown): string | undefined {
  if (!output) return undefined;
  if (Array.isArray(output)) return output[0]?.format;
  return (output as { format?: string }).format;
}

describe('source code protection: electron-vite main', () => {
  it('compiles production main to CJS bytecode and leaves preload/renderer as JS', () => {
    const config = resolveViteConfig('build');
    expect(config.main.build?.bytecode).toEqual({ transformArrowFunctions: false });
    expect(outputFormat(config.main.build?.rollupOptions?.output)).toBe('cjs');
    expect(config.preload.build?.bytecode).toBeUndefined();
    expect(config.renderer?.build?.bytecode).toBeUndefined();
  });

  it('keeps electron-vite serve as ESM so Pi SDK import.meta.resolve works', () => {
    const config = resolveViteConfig('serve');
    expect(config.main.build?.bytecode).toBeUndefined();
    expect(outputFormat(config.main.build?.rollupOptions?.output)).not.toBe('cjs');
  });

  it('keeps package type module and writes out/main as commonjs for bytecode stubs', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      type?: string;
      main?: string;
    };
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('out/main/main.js');
  });

  it('writes out/main/package.json as commonjs after a production bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-main-cjs-'));
    writeMainCjsPackageJson(dir);
    const written = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { type?: string };
    expect(written).toEqual({ type: 'commonjs' });
    removeMainCjsPackageJson(dir);
    expect(() => readFileSync(join(dir, 'package.json'), 'utf8')).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('source code protection: electron-builder', () => {
  const config = parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8')) as {
    asar?: boolean | { disableIntegrity?: boolean };
    asarUnpack?: string[];
    electronFuses?: {
      enableEmbeddedAsarIntegrityValidation?: boolean;
      onlyLoadAppFromAsar?: boolean;
      runAsNode?: boolean;
    };
  };

  it('enables asar integrity fuses without disabling runAsNode', () => {
    expect(config.electronFuses?.enableEmbeddedAsarIntegrityValidation).toBe(true);
    expect(config.electronFuses?.onlyLoadAppFromAsar).toBe(true);
    expect(config.electronFuses?.runAsNode).not.toBe(false);
    if (config.asar && typeof config.asar === 'object') {
      expect(config.asar.disableIntegrity).not.toBe(true);
    } else {
      expect(config.asar).toBe(true);
    }
  });

  it('unpacks the codegraph-host entry and its worker thread entry', () => {
    expect(config.asarUnpack).toContain('out/main/codegraph-host.js');
    expect(config.asarUnpack).toContain('out/main/codegraph-host.jsc');
    expect(config.asarUnpack).toContain('out/main/codegraph-worker.js');
    expect(config.asarUnpack).toContain('out/main/codegraph-worker.jsc');
  });

  it('unpacks the worker stub, bytecode and loader, not main.jsc', () => {
    expect(config.asarUnpack).toContain('out/main/pi-worker.js');
    expect(config.asarUnpack).toContain('out/main/pi-worker.jsc');
    expect(config.asarUnpack).toContain('out/main/bytecode-loader.cjs');
    expect(config.asarUnpack).not.toContain('out/main/main.jsc');
  });
});
