import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import viteConfig from '../../electron.vite.config';

const root = resolve(__dirname, '../..');

function outputFormat(output: unknown): string | undefined {
  if (!output) return undefined;
  if (Array.isArray(output)) return output[0]?.format;
  return (output as { format?: string }).format;
}

describe('source code protection: electron-vite main', () => {
  it('compiles main to CJS bytecode and leaves preload/renderer as JS', () => {
    expect(viteConfig.main.build.bytecode).toEqual({ transformArrowFunctions: false });
    expect(outputFormat(viteConfig.main.build.rollupOptions?.output)).toBe('cjs');
    expect(viteConfig.preload.build.bytecode).toBeUndefined();
    expect(viteConfig.renderer.build?.bytecode).toBeUndefined();
  });

  it('drops package type module so Electron treats out/main JS as CJS', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      type?: string;
      main?: string;
    };
    expect(pkg).not.toHaveProperty('type');
    expect(pkg.main).toBe('out/main/main.js');
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

  it('unpacks the worker stub, bytecode and loader, not main.jsc', () => {
    expect(config.asarUnpack).toContain('out/main/pi-worker.js');
    expect(config.asarUnpack).toContain('out/main/pi-worker.jsc');
    expect(config.asarUnpack).toContain('out/main/bytecode-loader.cjs');
    expect(config.asarUnpack).not.toContain('out/main/main.jsc');
  });
});
