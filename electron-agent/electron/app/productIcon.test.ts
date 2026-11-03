import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { parse } from 'yaml';

const root = resolve(__dirname, '../..');
const originalIcon = readFileSync(join(root, 'brand', 'source', 'grenagent-icon.svg'), 'utf8');
const originalLogo = readFileSync(join(root, 'brand', 'source', 'grenagent-logo.svg'), 'utf8');
const artwork = (svg: string) => svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>')).replace(/<title>[\s\S]*?<\/title>/g, '').trim();

describe('product icon source', () => {
  it('keeps the approved G geometry on a neutral black and white application tile', () => {
    const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8');
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).toContain('#171819');
    expect(svg).toContain('#ffffff');
    expect(svg).toContain('viewBox="0 0 352 352"');
    expect(svg).toContain(artwork(originalIcon));
  });

  it('embeds the complete approved outlined logo in the cold-start brand block', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const brandBlock = html.split('<!-- grenagent-brand:start -->')[1]?.split('<!-- grenagent-brand:end -->')[0];
    expect(brandBlock).toBeTruthy();
    expect(brandBlock).toContain('viewBox="0 0 1514 378"');
    expect(brandBlock).toContain(artwork(originalLogo));
    expect(brandBlock).toContain('aria-hidden="true"');
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
    expect(config.files).toContain('build/icon.png');
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

  it('ships the G raster generated from the committed application SVG', async () => {
    const expected = await sharp(Buffer.from(readFileSync(join(root, 'build', 'icon.svg'), 'utf8'))).ensureAlpha().raw().toBuffer();
    const png = sharp(readFileSync(join(root, 'build', 'icon.png')));
    expect(await png.metadata()).toMatchObject({ format: 'png', width: 1024, height: 1024 });
    expect((await png.ensureAlpha().raw().toBuffer()).equals(expected)).toBe(true);
  });

  it('keeps a 16/32 favicon and a valid ICNS container', () => {
    expect(icoSizes(readFileSync(join(root, 'public', 'favicon.ico')))).toEqual([16, 32]);
    const icns = readFileSync(join(root, 'build', 'icon.icns'));
    expect(icns.toString('ascii', 0, 4)).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
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
