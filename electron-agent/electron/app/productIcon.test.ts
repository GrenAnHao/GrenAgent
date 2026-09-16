import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(__dirname, '../..');
const PI_PATH = 'M40 56 H200 V84 H40 Z M74 84 H102 V190 H74 Z M150 84 H178 V190 H150 Z';

describe('product icon source', () => {
  it('keeps the 1024 SVG mark, colors and squircle radius', () => {
    const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8');
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).toContain('rx="320"');
    expect(svg).toContain('#0b0d12');
    expect(svg).toContain('#e6e8ec');
    expect(svg).toContain(PI_PATH);
  });

  it('uses the same pi path as PiBrandLogo', () => {
    const logo = readFileSync(join(root, 'src', 'components', 'PiBrandLogo.tsx'), 'utf8');
    expect(logo).toContain(PI_PATH);
  });
});

describe('product icon packaging', () => {
  it('points electron-builder at the committed icon files', () => {
    const config = parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8')) as {
      directories?: { buildResources?: string };
      files?: string[];
      win?: { icon?: string };
      mac?: { icon?: string };
      linux?: { icon?: string };
      nsis?: { installerIcon?: string };
    };
    expect(config.directories?.buildResources).toBe('build');
    expect(config.files).toContain('build/icon.ico');
    expect(config.win?.icon).toBe('build/icon.ico');
    expect(config.mac?.icon).toBe('build/icon.icns');
    expect(config.linux?.icon).toBe('build/icon.png');
    expect(config.nsis?.installerIcon).toBeUndefined();
  });
});

const ARTIFACTS = [
  'build/icon.ico',
  'build/icon.png',
  'build/icon.icns',
  'public/favicon.ico',
  'public/favicon.png',
] as const;

function icoSizes(buf: Buffer): number[] {
  const count = buf.readUInt16LE(4);
  const sizes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const width = buf[6 + i * 16];
    sizes.push(width === 0 ? 256 : width);
  }
  return sizes;
}

describe('product icon artifacts', () => {
  it('commits raster files with non-empty bytes', () => {
    for (const relative of ARTIFACTS) {
      const path = join(root, relative);
      expect(existsSync(path), relative).toBe(true);
      expect(statSync(path).size, relative).toBeGreaterThan(0);
    }
  });

  it('embeds 16-256 layers in icon.ico', () => {
    const sizes = icoSizes(readFileSync(join(root, 'build', 'icon.ico')));
    for (const size of [16, 24, 32, 48, 64, 128, 256]) {
      expect(sizes, `missing ${size}`).toContain(size);
    }
  });
});

describe('product icon scripts', () => {
  it('exposes a manual icons script and does not hook package', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.icons).toBe('node scripts/generate-icons.mjs');
    expect(pkg.scripts.package).toBe('electron-builder --config electron-builder.yml');
    expect(pkg.scripts.package).not.toContain('icons');
  });
});

describe('product icon favicon', () => {
  it('links index.html at ./favicon.ico', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).toMatch(/rel=["']icon["']/);
    expect(html).toContain('href="./favicon.ico"');
  });
});
