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
      outDir?: string;
      bytecode?: unknown;
      rollupOptions?: { output?: unknown };
    };
  };
  preload: { build?: { outDir?: string; bytecode?: unknown } };
  renderer?: { build?: { outDir?: string; bytecode?: unknown } };
};

function resolveViteConfig(command: ViteCommand, mode?: string): ViteSlice {
  if (typeof viteConfig !== 'function') {
    throw new Error('electron.vite.config must export defineConfig(({ command }) => ...)');
  }
  return viteConfig({ command, mode: mode ?? (command === 'build' ? 'production' : 'development') });
}

function outDirs(config: ViteSlice) {
  return [config.main.build?.outDir, config.preload.build?.outDir, config.renderer?.build?.outDir];
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

  it('writes the production build to out-pkg so a running dev / start never shares its output', () => {
    expect(outDirs(resolveViteConfig('build'))).toEqual([
      join(root, 'out-pkg', 'main'),
      join(root, 'out-pkg', 'preload'),
      join(root, 'out-pkg', 'renderer'),
    ]);
    const devLike = [join(root, 'out', 'main'), join(root, 'out', 'preload'), join(root, 'dist')];
    expect(outDirs(resolveViteConfig('serve'))).toEqual(devLike);
    expect(outDirs(resolveViteConfig('build', 'localrun'))).toEqual(devLike);
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
    files?: Array<string | { from?: string; to?: string }>;
    asar?: boolean | { disableIntegrity?: boolean };
    asarUnpack?: string[];
    extraResources?: Array<string | { from?: string; to?: string }>;
    beforePack?: string;
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

  it('packs only out-pkg, mapped back to the out/ and dist/ layout the runtime expects', () => {
    const fileSets = (config.files ?? []).filter((item): item is { from?: string; to?: string } => typeof item !== 'string');
    expect(fileSets).toEqual([
      { from: 'out-pkg/main', to: 'out/main' },
      { from: 'out-pkg/preload', to: 'out/preload' },
      { from: 'out-pkg/renderer', to: 'dist' },
    ]);
    const globs = (config.files ?? []).filter((item): item is string => typeof item === 'string');
    expect(globs.some((glob) => glob.startsWith('out/') || glob.startsWith('dist'))).toBe(false);
    // asarUnpack 按源路径匹配：写成 out/main/... 就一个也对不上，子进程入口会留在 asar 里。
    expect(config.asarUnpack?.some((glob) => glob.startsWith('out/'))).toBe(false);
  });

  it('unpacks the agentdata-host entry', () => {
    expect(config.asarUnpack).toContain('out-pkg/main/agentdata-host.js');
    expect(config.asarUnpack).toContain('out-pkg/main/agentdata-host.jsc');
  });

  it('unpacks out/main/package.json beside the unpacked .js stubs so they load as commonjs', () => {
    expect(config.asarUnpack).toContain('out-pkg/main/package.json');
    expect(config.asarUnpack).toContain('out-pkg/main/agent-host.js');
  });

  it('unpacks the codegraph-host entry and its worker thread entry', () => {
    expect(config.asarUnpack).toContain('out-pkg/main/codegraph-host.js');
    expect(config.asarUnpack).toContain('out-pkg/main/codegraph-host.jsc');
    expect(config.asarUnpack).toContain('out-pkg/main/codegraph-worker.js');
    expect(config.asarUnpack).toContain('out-pkg/main/codegraph-worker.jsc');
  });

  it('unpacks the worker stub, bytecode and loader, not main.jsc', () => {
    expect(config.asarUnpack).toContain('out-pkg/main/pi-worker.js');
    expect(config.asarUnpack).toContain('out-pkg/main/pi-worker.jsc');
    expect(config.asarUnpack).toContain('out-pkg/main/bytecode-loader.cjs');
    expect(config.asarUnpack).not.toContain('out-pkg/main/main.jsc');
  });

  it('ships its own and third-party license texts outside the asar', () => {
    // asar 对最终用户不透明；MIT/ISC/Apache/EPL/OFL 都要求接收方看得到声明。
    expect(config.beforePack).toBe('./scripts/collect-third-party-licenses.cjs');
    expect(config.extraResources).toContainEqual({ from: 'build/licenses', to: 'licenses' });
  });

  it('keeps the undeclarable Spline runtime and the unused giscus packages out of the bundle', () => {
    // @splinetool/runtime 上游无 license 字段与许可文件（只有 © 2025 Spline, Inc.），
    // @lobehub/ui 声明了它但本项目不引用；两个 giscus 包同理。没有授权声明就不能随包分发。
    const excluded = (config.files ?? []).filter((item): item is string => typeof item === 'string' && item.startsWith('!'));
    expect(excluded).toEqual(expect.arrayContaining([
      '!node_modules/@splinetool/**',
      '!node_modules/giscus/**',
      '!node_modules/@giscus/**',
    ]));
  });
});
