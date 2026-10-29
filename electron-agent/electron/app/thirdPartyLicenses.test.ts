import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);
const script = require('../../scripts/collect-third-party-licenses.cjs') as {
  collect: (opts?: { out?: string; report?: string }) => { outDir: string; count: number; missing: number };
  buildInventory: () => Array<{ name: string; version: string; license: string; files: string[] }>;
  packedExclusions: () => string[];
  renderReport: (inventory: unknown, generatedBy: string) => string;
};

const root = resolve(__dirname, '../..');
const repoRoot = resolve(root, '..');

describe('collect-third-party-licenses', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('excludes exactly what electron-builder keeps out of the bundle', () => {
    const config = parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8')) as { files?: Array<string | object> };
    const fromConfig = (config.files ?? [])
      .filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('!'))
      .map((entry) => entry.slice(1));
    // 声明里列了没打包的包，或者打了包却没声明，都是合规缺口；两边必须同源。
    expect(script.packedExclusions()).toEqual(fromConfig);
    expect(fromConfig).toContain('node_modules/@splinetool/**');
  });

  it('lists every production dependency from the lockfile, dev ones excluded', () => {
    const inventory = script.buildInventory();
    const names = new Set(inventory.map((entry) => entry.name));
    expect(names.has('react')).toBe(true);
    expect(names.has('mermaid')).toBe(true);
    expect(names.has('elkjs')).toBe(true);
    // @splinetool 只由 @lobehub/ui 的依赖声明拉进来，本项目不分发它。
    expect(names.has('@splinetool/runtime')).toBe(false);
    // devDependencies 不进包。
    expect(names.has('vitest')).toBe(false);
    expect(names.has('typescript')).toBe(false);
    // 每个条目都带版本与许可证标识，报告才能对得上。
    for (const entry of inventory) {
      expect(entry.version).not.toBe('');
      expect(entry.license).not.toBe('');
    }
  });

  it('copies the license texts that carry obligations the bundle must satisfy', () => {
    const out = mkdtempSync(join(tmpdir(), 'licenses-'));
    created.push(out);
    const result = script.collect({ out });
    expect(result.count).toBeGreaterThan(800);

    // EPL-2.0（elkjs）：随附原文，且正文是 EPL 而非别的许可。
    const elk = readFileSync(join(out, 'elkjs', 'LICENSE.md'), 'utf8');
    expect(elk).toContain('Eclipse Public License - v 2.0');

    // OFL-1.1（Inter 字体）：字体许可随附。
    expect(readFileSync(join(out, '@fontsource/inter', 'LICENSE'), 'utf8')).toContain('SIL Open Font License');

    // 双许可包两个文件都在（dompurify 是 MPL-2.0 OR Apache-2.0，按 Apache 履行）。
    expect(existsSync(join(out, 'dompurify', 'LICENSE'))).toBe(true);
    expect(existsSync(join(out, 'dompurify', 'LICENSE-MPL'))).toBe(true);

    // 本仓库的许可与第三方来源说明也一并给出。
    expect(readFileSync(join(out, 'LICENSE.txt'), 'utf8')).toContain('PolyForm Noncommercial License 1.0.0');
    expect(existsSync(join(out, 'third-party-notices.md'))).toBe(true);
    expect(readFileSync(join(out, 'INDEX.md'), 'utf8')).toContain('| 许可证 | 包数 |');
  });

  it('leaves a placeholder for packages that ship no license file', () => {
    const out = mkdtempSync(join(tmpdir(), 'licenses-'));
    created.push(out);
    const result = script.collect({ out });
    expect(result.missing).toBeGreaterThan(0);
    // Pi SDK 的 npm 发布物没有 LICENSE（files 未包含），许可证由 package.json 的 MIT 声明。
    const placeholder = readFileSync(join(out, '@earendil-works/pi-coding-agent', 'LICENSE-MISSING.txt'), 'utf8');
    expect(placeholder).toContain('声明许可证：MIT');
    expect(placeholder).toContain('上游 npm 包内未附带许可文本');
  });

  it('keeps the committed dependency report in sync with the lockfile', () => {
    const expected = script.renderReport(script.buildInventory(), 'electron-agent/scripts/collect-third-party-licenses.cjs');
    const committed = readFileSync(join(repoRoot, 'docs/third-party-dependencies.md'), 'utf8');
    // 依赖变更后跑 `node scripts/collect-third-party-licenses.cjs --report=../docs/third-party-dependencies.md`。
    expect(committed).toBe(expected);
  });
});
